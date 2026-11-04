import { faroTimeMs, HIDDEN_MEASUREMENT_TYPES } from './journey';
import { logqlString } from './loki';
import { parseLogfmt } from './logfmt';
import { regexEscape, sessionLineFilter, STREAMS } from './logql';
import type { LokiLine } from '../types';

/**
 * The dialer's per-second audio levels (predictive-power-dialer
 * `audioLevelMonitor.ts`), for the level graph under the replay timeline:
 * - `twilio_audio_level` / `telnyx_audio_level`: one window per second of a
 *   call, with the agent's microphone (`agent_mic_*`) and the call audio the
 *   agent hears (`customer_audio_*`);
 * - `twilio_mic_level_idle`: the agent's microphone between calls.
 * Levels are 0..1 (-100 dB .. -30 dB). These lines are kept out of the
 * journey; they are fetched here on their own.
 */
export const AUDIO_LEVEL_TYPES = HIDDEN_MEASUREMENT_TYPES;

export type AudioPhase = 'call' | 'waiting' | 'idle';

/** The only dialer state with a customer on the agent's line. */
const CUSTOMER_STATE = 'ON_CALL';

/**
 * Which phase a window belongs to. The agent's leg is the same conference leg
 * while waiting and while talking, so only the agent's state tells them
 * apart. Without a state (lines from before it was sent), a line is assumed
 * to have a customer.
 */
function phaseOf(type: string, fields: Record<string, string>): AudioPhase {
  if (type === 'twilio_mic_level_idle' || fields.context_phase === 'idle') {
    return 'idle';
  }
  const state = fields.user_attr_state;
  return state && state !== CUSTOMER_STATE ? 'waiting' : 'call';
}

/** A level below this is silent (the dialer's AUDIO_SILENCE_THRESHOLD, about -99 dB). */
export const AUDIO_SILENCE_THRESHOLD = 0.01;

export interface AudioLevelWindow {
  /** Epoch ms of the window's start and end (Faro sends the measurement at the end). */
  startMs: number;
  endMs: number;
  /**
   * - `call`: a customer is on the line (the agent's state is ON_CALL);
   * - `waiting`: the agent's line is open in their conference, but no customer
   *   is on it (AVAILABLE, connecting): "customer audio" is then the empty
   *   conference, not a customer;
   * - `idle`: no line at all, the idle meter's microphone only.
   */
  phase: AudioPhase;
  /** The agent's dialer state when the window was sent (Faro user attribute). */
  agentState?: string;
  /** Level reports the browser delivered in the window; 0 means the SDK reported nothing. */
  samples: number;
  agentAvg?: number;
  agentMax?: number;
  agentSilentRatio?: number;
  /**
   * Every reading of the window (about one per 50 ms), when the dialer sent
   * them (levels_format=pct2); in hundredths, so 0 is below the threshold.
   */
  agentLevels?: number[];
  /** In a call only. */
  customerAvg?: number;
  customerMax?: number;
  customerSilentRatio?: number;
  customerLevels?: number[];
  /** Share of the window the dialer tab was in the background (timers throttled there). */
  hiddenRatio?: number;
  callSid?: string;
}

/** One session's audio level lines. */
export function audioLevelsQuery(sessionId: string): string {
  const types = AUDIO_LEVEL_TYPES.map(regexEscape).join('|');
  return STREAMS.faro + sessionLineFilter(sessionId) + ` |~ ${logqlString(`(^| )type=(${types})( |$)`)}`;
}

/** A measurement value: Faro writes it twice, rounded (`x=`) and exact (`value_x=`). */
function value(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[`value_${key}`] ?? fields[key];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * A window's readings in the dialer's `pct2` format: two digits per reading,
 * the level in hundredths rounded down. Undefined for any other format or a
 * malformed string.
 */
export function decodeLevelSeries(format: string | undefined, encoded: string | undefined): number[] | undefined {
  if (format !== 'pct2' || !encoded || encoded.length % 2 !== 0 || !/^\d+$/.test(encoded)) {
    return undefined;
  }
  const levels: number[] = [];
  for (let i = 0; i < encoded.length; i += 2) {
    levels.push(Number(encoded.slice(i, i + 2)) / 100);
  }
  return levels;
}

/** One measurement line as a window, or undefined for anything else. */
export function parseAudioLevelLine(tsNs: string, line: string, sessionId: string): AudioLevelWindow | undefined {
  const fields = parseLogfmt(line);
  if (fields.kind !== 'measurement' || fields.session_id !== sessionId) {
    return undefined;
  }
  const type = fields.type as (typeof AUDIO_LEVEL_TYPES)[number];
  if (!AUDIO_LEVEL_TYPES.includes(type)) {
    return undefined;
  }
  const endMs = faroTimeMs(fields, tsNs);
  const windowMs = value(fields, 'window_ms') ?? 1000;
  return {
    startMs: endMs - Math.max(0, windowMs),
    endMs,
    phase: phaseOf(type, fields),
    agentState: fields.user_attr_state || undefined,
    samples: value(fields, 'samples') ?? 0,
    agentAvg: value(fields, 'agent_mic_avg'),
    agentMax: value(fields, 'agent_mic_max'),
    agentSilentRatio: value(fields, 'agent_mic_silent_ratio'),
    customerAvg: value(fields, 'customer_audio_avg'),
    customerMax: value(fields, 'customer_audio_max'),
    customerSilentRatio: value(fields, 'customer_audio_silent_ratio'),
    agentLevels: decodeLevelSeries(fields.context_levels_format, fields.context_agent_mic_levels),
    customerLevels: decodeLevelSeries(fields.context_levels_format, fields.context_customer_audio_levels),
    hiddenRatio: value(fields, 'hidden_ratio'),
    callSid: fields.context_callSid || undefined,
  };
}

/** Builds the sorted windows from lines that may arrive twice (live polling overlaps). */
export function buildAudioLevels(entries: Iterable<LokiLine>, sessionId: string): AudioLevelWindow[] {
  const windows: AudioLevelWindow[] = [];
  for (const entry of entries) {
    const window = parseAudioLevelLine(entry.tsNs, entry.line, sessionId);
    if (window) {
      windows.push(window);
    }
  }
  return windows.sort(byStart);
}

/** Start, then end: windows of two legs at once overlap, so end order alone is not start order. */
export function byStart(a: AudioLevelWindow, b: AudioLevelWindow): number {
  return a.startMs - b.startMs || a.endMs - b.endMs;
}

/** A window positioned on the replay timeline (ms from the recording start). */
export interface AudioLevelSegment extends AudioLevelWindow {
  /** Clipped to the recording. */
  startOffsetMs: number;
  endOffsetMs: number;
  /** Not clipped: where the window's readings really sit. */
  rawStartOffsetMs: number;
  rawEndOffsetMs: number;
}

/** The windows that overlap the recording, as timeline offsets. */
export function toTimelineSegments(
  windows: AudioLevelWindow[],
  recordingStartMs: number,
  totalMs: number
): AudioLevelSegment[] {
  const segments: AudioLevelSegment[] = [];
  for (const window of windows) {
    const startOffsetMs = window.startMs - recordingStartMs;
    const endOffsetMs = window.endMs - recordingStartMs;
    if (endOffsetMs <= 0 || startOffsetMs >= totalMs) {
      continue;
    }
    segments.push({
      ...window,
      startOffsetMs: Math.max(0, startOffsetMs),
      endOffsetMs: Math.min(totalMs, endOffsetMs),
      rawStartOffsetMs: startOffsetMs,
      rawEndOffsetMs: endOffsetMs,
    });
  }
  return segments;
}

/** The reading at an offset inside a segment, if the window carries its readings. */
export function readingAt(
  levels: number[] | undefined,
  segment: AudioLevelSegment,
  offsetMs: number
): number | undefined {
  if (!levels || levels.length === 0) {
    return undefined;
  }
  const length = segment.rawEndOffsetMs - segment.rawStartOffsetMs;
  const index = length > 0 ? Math.floor(((offsetMs - segment.rawStartOffsetMs) / length) * levels.length) : 0;
  return levels[Math.min(levels.length - 1, Math.max(0, index))];
}

/** How many windows before the last one starting at an offset may still cover it (legs at once). */
const OVERLAP_LOOKBACK = 8;

/**
 * The window at a timeline offset, for the hover readout. Segments are sorted
 * by start (byStart). Windows of one leg follow each other; when two legs run
 * at once (a redial while the old leg ends), a few overlap, hence the
 * look-back. With several, the one that started last wins.
 */
export function segmentAt(segments: AudioLevelSegment[], offsetMs: number): AudioLevelSegment | undefined {
  // The last segment that starts at or before the offset.
  let low = 0;
  let high = segments.length - 1;
  let last = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].startOffsetMs <= offsetMs) {
      last = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  for (let index = last; index >= 0 && index > last - OVERLAP_LOOKBACK; index--) {
    const segment = segments[index];
    if (offsetMs < segment.endOffsetMs) {
      return segment;
    }
  }
  return undefined;
}
