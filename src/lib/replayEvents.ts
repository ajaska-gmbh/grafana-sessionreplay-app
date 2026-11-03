import type { eventWithTime } from '@grafana/rrweb-types';
import { parseLogfmt } from './logfmt';

export const REPLAY_EVENT_NAME = 'faro.session_recording.event';

/** rrweb EventType values the player needs to start a recording. */
export const RRWEB_FULL_SNAPSHOT = 2;
export const RRWEB_META = 4;

export interface DecodedReplayEvent {
  key: string;
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

    const gen = Number(fields.event_data_gen ?? 0) || 0;
    const seq = Number(fields.event_data_seq ?? 0) || 0;
    decoded.push({
      key: `${fields.event_data_recording_id ?? ''}:${gen}:${seq}:${event.timestamp}:${event.type}`,
      gen,
      seq,
      event,
    });
  }

  return { decoded, skipped };
}

/**
 * Merge new events into the known ones (de-duplicated by recording, gen, seq)
 * and return all events in playback order: rrweb timestamp, then gen and seq.
 */
export function mergeReplayEvents(
  known: Map<string, DecodedReplayEvent>,
  incoming: DecodedReplayEvent[]
): eventWithTime[] {
  for (const entry of incoming) {
    if (!known.has(entry.key)) {
      known.set(entry.key, entry);
    }
  }
  return [...known.values()]
    .sort((a, b) => a.event.timestamp - b.event.timestamp || a.gen - b.gen || a.seq - b.seq)
    .map((entry) => entry.event);
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
