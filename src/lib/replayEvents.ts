import type { eventWithTime } from '@grafana/rrweb-types';
import { parseLogfmt } from './logfmt';

export const REPLAY_EVENT_NAME = 'faro.session_recording.event';

/** rrweb EventType values the player needs to start a recording. */
export const RRWEB_FULL_SNAPSHOT = 2;
export const RRWEB_META = 4;

export interface DecodedReplayEvent {
  key: string;
  /** One recording per page load (or per tab); empty for replay < 2.13. */
  recordingId: string;
  gen: number;
  seq: number;
  event: eventWithTime;
}

/**
 * Decode Loki lines of one session into rrweb events. Faro sends every rrweb
 * event as its own `faro.session_recording.event` with `recording_id`, `gen`
 * and `seq` attributes (logfmt keys `event_data_*`); the JSON payload is in
 * `event_data_event`. Lines of other sessions are ignored, broken ones counted.
 */
export function decodeReplayLines(
  lines: Iterable<{ line: string }>,
  sessionId: string
): { decoded: DecodedReplayEvent[]; skipped: number } {
  const decoded: DecodedReplayEvent[] = [];
  let skipped = 0;

  for (const { line } of lines) {
    const fields = parseLogfmt(line);
    if (fields.event_name !== REPLAY_EVENT_NAME || fields.session_id !== sessionId) {
      continue;
    }

    let event: eventWithTime | undefined;
    try {
      event = fields.event_data_event ? JSON.parse(fields.event_data_event) : undefined;
    } catch {
      event = undefined;
    }
    if (typeof event?.timestamp !== 'number' || typeof event?.type !== 'number') {
      skipped++;
      continue;
    }

    const recordingId = fields.event_data_recording_id ?? '';
    const gen = Number(fields.event_data_gen ?? 0) || 0;
    const seq = Number(fields.event_data_seq ?? 0) || 0;
    decoded.push({
      // Replay < 2.13 sends no recording id/gen/seq: only identical payloads are duplicates then.
      key: recordingId ? `${recordingId}:${gen}:${seq}` : fields.event_data_event,
      recordingId,
      gen,
      seq,
      event,
    });
  }

  return { decoded, skipped };
}

/**
 * Merge new events into the known ones (de-duplicated by recording, gen and
 * seq) and split them into playable tracks.
 *
 * Every recording starts with its own Meta + full snapshot. Recordings that
 * follow each other (page reloads) are played back to back on one track;
 * recordings that overlap in time (the same session open in two tabs) get a
 * track each, because mixing their DOM changes would corrupt the playback.
 * Within a recording, events are ordered by rrweb timestamp, then gen and seq.
 */
export function mergeReplayEvents(
  known: Map<string, DecodedReplayEvent>,
  incoming: DecodedReplayEvent[]
): eventWithTime[][] {
  for (const entry of incoming) {
    if (!known.has(entry.key)) {
      known.set(entry.key, entry);
    }
  }

  const byRecording = new Map<string, DecodedReplayEvent[]>();
  for (const entry of known.values()) {
    const list = byRecording.get(entry.recordingId) ?? [];
    list.push(entry);
    byRecording.set(entry.recordingId, list);
  }

  const recordings = [...byRecording.values()]
    .map((entries) =>
      entries
        .sort((a, b) => a.event.timestamp - b.event.timestamp || a.gen - b.gen || a.seq - b.seq)
        .map((entry) => entry.event)
    )
    .sort((a, b) => a[0].timestamp - b[0].timestamp);

  const tracks: eventWithTime[][] = [];
  for (const recording of recordings) {
    const start = recording[0].timestamp;
    const track = tracks.find((candidate) => candidate[candidate.length - 1].timestamp <= start);
    if (track) {
      track.push(...recording);
    } else {
      tracks.push([...recording]);
    }
  }

  return tracks.map(playableEvents).filter((track) => track.length > 0);
}

/**
 * Trim to what the player can render: it needs a Meta event and a full DOM
 * snapshot first, so incremental events before the first snapshot are dropped
 * (keeping the closest preceding Meta). Returns [] when there is no snapshot.
 */
export function playableEvents(events: eventWithTime[]): eventWithTime[] {
  const firstSnapshot = events.findIndex((event) => event.type === RRWEB_FULL_SNAPSHOT);
  if (firstSnapshot === -1) {
    return [];
  }
  const metaBefore = events
    .slice(0, firstSnapshot)
    .reverse()
    .find((event) => event.type === RRWEB_META);
  return metaBefore ? [metaBefore, ...events.slice(firstSnapshot)] : events.slice(firstSnapshot);
}
