import type { JourneyEvent } from './journey';

/**
 * The call audio of a session, as the call recorder keeps it, and where on the
 * session's timeline each piece plays.
 *
 * Two sources, four tracks (see the call recorder's README):
 *
 *   mic       the agent's microphone, recorded on their computer (whole shift)
 *   heard     what came out of the agent's speaker, recorded there too
 *   agent     the agent as the carrier received them (carrier stream of the agent's leg)
 *   customer  what the carrier sent the agent: the customer
 *
 * The conversation is mic + customer; agent and heard show where audio was
 * lost on the way: mic without agent is the agent's uplink, customer without
 * heard their downlink.
 *
 * Where the audio is comes from the session's own Faro events, contract
 * "recording" v1 of the dialer (recording.started: env, agent_id;
 * recording.source-changed: leg_sid while on a leg). Sessions of other apps
 * have none, and have no call audio.
 */
export type CallAudioTrack = 'mic' | 'customer' | 'agent' | 'heard';

export const CALL_AUDIO_TRACKS: readonly CallAudioTrack[] = ['mic', 'customer', 'agent', 'heard'];

/** What plays by default: the two halves of the conversation. */
export const DEFAULT_AUDIBLE: ReadonlySet<CallAudioTrack> = new Set(['mic', 'customer']);

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
  /** Stretches the file holds silence for, because the carrier sent nothing. */
  gaps: Interval[];
}

/** Where the session's audio is kept. */
export interface AudioSources {
  /** The agent's computer's recording, filed by environment and agent. */
  browser?: { env: string; agentId: number };
  /** The agent's legs, whose carrier streams are filed by CallSid. */
  legSids: string[];
}

const RECORDING_CONTRACT = 'v1';

/** Reads the session's recording events (contract v1); nothing for sessions without any. */
export function audioSourcesOf(journey: JourneyEvent[]): AudioSources {
  let browser: AudioSources['browser'];
  const legSids = new Set<string>();
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
    if (a.event_name === 'recording.source-changed' && a.event_data_leg_sid) {
      legSids.add(a.event_data_leg_sid);
    }
  }
  return { browser, legSids: [...legSids] };
}

/** The recorder's names for the tracks. */
export function trackOf(source: string, track: string): CallAudioTrack | undefined {
  if (source === 'browser') {
    return track === 'mic' || track === 'heard' ? track : undefined;
  }
  if (source === 'carrier') {
    return track === 'inbound' ? 'agent' : track === 'outbound' ? 'customer' : undefined;
  }
  return undefined;
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

/** Where a track has audio: its segments, less the gaps the carrier left. */
export function coverage(segments: AudioSegment[]): Interval[] {
  return subtract(spansOf(segments), union(segments.flatMap((segment) => segment.gaps)));
}

function spansOf(segments: AudioSegment[]): Interval[] {
  return union(segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.startMs + segment.durationMs })));
}

/** Shorter than this is jitter, not lost audio. */
export const MIN_LOSS_MS = 500;

export interface Losses {
  /** The agent's computer has their voice, the carrier did not receive it: the agent's uplink. */
  uplink: Interval[];
  /** The carrier sent the customer, the agent's computer did not play it: the agent's downlink. */
  downlink: Interval[];
}

/** Where both have audio (both unions). */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const startMs = Math.max(a[i].startMs, b[j].startMs);
    const endMs = Math.min(a[i].endMs, b[j].endMs);
    if (endMs > startMs) {
      result.push({ startMs, endMs });
    }
    if (a[i].endMs < b[j].endMs) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

/**
 * Where audio was lost between the agent's computer and the carrier, while the
 * carrier streamed the agent's leg (between legs it has nothing to compare).
 */
export function losses(tracks: Record<CallAudioTrack, AudioSegment[]>): Losses {
  const legs = union([...spansOf(tracks.agent), ...spansOf(tracks.customer)]);
  const long = (intervals: Interval[]) => intervals.filter((i) => i.endMs - i.startMs >= MIN_LOSS_MS);
  return {
    uplink: long(intersect(subtract(coverage(tracks.mic), coverage(tracks.agent)), legs)),
    downlink: long(intersect(subtract(coverage(tracks.customer), coverage(tracks.heard)), legs)),
  };
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
