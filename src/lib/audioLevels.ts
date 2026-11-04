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

/** A level below this is silent (the dialer's AUDIO_SILENCE_THRESHOLD, about -99 dB). */
export const AUDIO_SILENCE_THRESHOLD = 0.01;

export interface AudioLevelWindow {
  /** Epoch ms of the window's start and end (Faro sends the measurement at the end). */
  startMs: number;
  endMs: number;
  phase: 'call' | 'idle';
  /** Level reports the browser delivered in the window; 0 means the SDK reported nothing. */
  samples: number;
  agentAvg?: number;
  agentMax?: number;
  agentSilentRatio?: number;
  /** In a call only. */
  customerAvg?: number;
  customerMax?: number;
  customerSilentRatio?: number;
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
    phase: type === 'twilio_mic_level_idle' || fields.context_phase === 'idle' ? 'idle' : 'call',
    samples: value(fields, 'samples') ?? 0,
    agentAvg: value(fields, 'agent_mic_avg'),
    agentMax: value(fields, 'agent_mic_max'),
    agentSilentRatio: value(fields, 'agent_mic_silent_ratio'),
    customerAvg: value(fields, 'customer_audio_avg'),
    customerMax: value(fields, 'customer_audio_max'),
    customerSilentRatio: value(fields, 'customer_audio_silent_ratio'),
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
  return windows.sort((a, b) => a.endMs - b.endMs);
}

/** A window positioned on the replay timeline (ms from the recording start). */
export interface AudioLevelSegment extends AudioLevelWindow {
  startOffsetMs: number;
  endOffsetMs: number;
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
    });
  }
  return segments;
}

/** The window at a timeline offset, for the hover readout. */
export function segmentAt(segments: AudioLevelSegment[], offsetMs: number): AudioLevelSegment | undefined {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (offsetMs < segment.startOffsetMs) {
      high = mid - 1;
    } else if (offsetMs >= segment.endOffsetMs) {
      low = mid + 1;
    } else {
      return segment;
    }
  }
  return undefined;
}
