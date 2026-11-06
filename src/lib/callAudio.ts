import type { JourneyEvent } from './journey';

/**
 * The call audio of a session, as the call recorder keeps it, and where on the
 * session's timeline each piece plays.
 *
 * Both tracks are recorded on the agent's computer, from the agent's point of
 * view (see the call recorder's README):
 *
 *   mic    the agent's microphone, for the whole shift (also between calls)
 *   heard  what the agent heard: the leg's remote audio as their browser played it
 *
 * Both are on the agent's computer's clock, as the replay is, so they need no
 * shifting. Nothing is taken from the carrier.
 *
 * Where the audio is comes from the session's own Faro events, contract
 * "recording" v1 of the dialer (recording.started: env, agent_id). Sessions
 * of other apps have none, and have no call audio.
 */
export type CallAudioTrack = 'mic' | 'heard';

export const CALL_AUDIO_TRACKS: readonly CallAudioTrack[] = ['mic', 'heard'];

/** What plays by default: the whole conversation as the agent had it. */
export const DEFAULT_AUDIBLE: ReadonlySet<CallAudioTrack> = new Set(['mic', 'heard']);

export interface Interval {
  startMs: number;
  endMs: number;
}

/** One file of a track, on the wall clock (epoch ms). */
export interface AudioSegment {
  key: string;
  track: CallAudioTrack;
  startMs: number;
  durationMs: number;
}

/** Where the session's audio is kept: the agent's computer's recording, filed by environment and agent. */
export interface AudioSources {
  browser?: { env: string; agentId: number };
}

const RECORDING_CONTRACT = 'v1';

/** Reads the session's recording events (contract v1); nothing for sessions without any. */
export function audioSourcesOf(journey: JourneyEvent[]): AudioSources {
  let browser: AudioSources['browser'];
  for (const event of journey) {
    const a = event.attributes;
    if (
      a.event_name === 'recording.started' &&
      a.event_data_recording_contract === RECORDING_CONTRACT &&
      a.event_data_source === 'browser'
    ) {
      const agentId = Number(a.event_data_agent_id);
      if (a.event_data_env && Number.isInteger(agentId) && agentId > 0) {
        browser = { env: a.event_data_env, agentId };
      }
    }
  }
  return { browser };
}

/** The recorder's names for the tracks. */
export function trackOf(source: string, track: string): CallAudioTrack | undefined {
  return source === 'browser' && (track === 'mic' || track === 'heard') ? track : undefined;
}

/** The segment playing at `wallMs` (segments of one track, sorted by start), by binary search. */
export function segmentAt(segments: AudioSegment[], wallMs: number): AudioSegment | undefined {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].startMs <= wallMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const candidate = segments[low - 1];
  return candidate && wallMs < candidate.startMs + candidate.durationMs ? candidate : undefined;
}

/** The first segment starting at or after `wallMs` (sorted by start), by binary search. */
export function segmentStartingFrom(segments: AudioSegment[], wallMs: number): AudioSegment | undefined {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].startMs < wallMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return segments[low];
}

/** Merges overlapping or touching intervals. */
export function union(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const result: Interval[] = [];
  for (const interval of sorted) {
    const last = result[result.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      result.push({ ...interval });
    }
  }
  return result;
}

/** `from` without `minus`, both unions. */
export function subtract(from: Interval[], minus: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const interval of from) {
    let start = interval.startMs;
    for (const cut of minus) {
      if (cut.endMs <= start || cut.startMs >= interval.endMs) {
        continue;
      }
      if (cut.startMs > start) {
        result.push({ startMs: start, endMs: cut.startMs });
      }
      start = Math.max(start, cut.endMs);
    }
    if (start < interval.endMs) {
      result.push({ startMs: start, endMs: interval.endMs });
    }
  }
  return result;
}

/** Where a track has audio: its segments. */
export function coverage(segments: AudioSegment[]): Interval[] {
  return union(segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.startMs + segment.durationMs })));
}

/** Shorter than this is the seam between two segments, not missing audio. */
export const MIN_MISSING_MS = 500;

/**
 * Where the agent's microphone was not recorded within the session: before
 * the leg had its microphone, without the microphone permission, after the
 * idle microphone gave up, or while the tab was closed or crashed.
 */
export function missing(segments: AudioSegment[], session: Interval): Interval[] {
  return subtract([session], coverage(segments)).filter((i) => i.endMs - i.startMs >= MIN_MISSING_MS);
}

/**
 * Where the agent's browser had no network: the dialer's network.online
 * events say how long it was gone (offline_ms), sent once it was back.
 */
export function connectionLost(journey: JourneyEvent[]): Interval[] {
  const lost: Interval[] = [];
  for (const event of journey) {
    if (event.attributes.event_name !== 'network.online') {
      continue;
    }
    const offlineMs = Number(event.attributes.event_data_offline_ms);
    if (Number.isFinite(offlineMs) && offlineMs > 0) {
      lost.push({ startMs: event.timeMs - offlineMs, endMs: event.timeMs });
    }
  }
  return union(lost);
}
