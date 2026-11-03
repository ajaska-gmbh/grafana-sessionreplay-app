import type { eventWithTime } from '@grafana/rrweb-types';
import { RRWEB_FULL_SNAPSHOT, RRWEB_META } from './replayEvents';

/**
 * Where live playback starts: the Meta event before the last full snapshot.
 * Everything from there is applied at once; older events are not needed.
 */
export function liveStartIndex(events: eventWithTime[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === RRWEB_FULL_SNAPSHOT) {
      for (let j = i - 1; j >= 0; j--) {
        if (events[j].type === RRWEB_META) {
          return j;
        }
      }
      return i;
    }
  }
  return 0;
}

export interface PageChange {
  timestamp: number;
  href?: string;
}

/** Page loads in the recording: every Meta event carries the page URL. */
export function pageChanges(events: eventWithTime[]): PageChange[] {
  return events
    .filter((event) => event.type === RRWEB_META)
    .map((event) => ({ timestamp: event.timestamp, href: (event.data as { href?: string }).href }));
}

/** URL of the page the user was on at `timestamp` (changes sorted by time). */
export function pageAt(changes: PageChange[], timestamp: number): string | undefined {
  let href: string | undefined;
  for (const change of changes) {
    if (change.timestamp > timestamp) {
      break;
    }
    href = change.href;
  }
  return href;
}
