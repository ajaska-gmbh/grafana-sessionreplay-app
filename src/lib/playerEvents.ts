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

/** URL of the page the user was on at `timestamp` (changes sorted by time); asked every frame, so by binary search. */
export function pageAt(changes: PageChange[], timestamp: number): string | undefined {
  let low = 0;
  let high = changes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (changes[middle].timestamp <= timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low === 0 ? undefined : changes[low - 1].href;
}

/**
 * Playback offset for a link's `t`. `t` counts from the first event the link's
 * own range would have played: the first Meta (page load or checkout) at or
 * after `linkFromMs`. When loading started earlier (see loadRange), that point
 * is found in the loaded events. Undefined while it is not loaded yet.
 */
export function linkOffset(events: eventWithTime[], linkFromMs: number | undefined, t = 0): number | undefined {
  if (events.length === 0) {
    return undefined;
  }
  if (linkFromMs === undefined || events[0].timestamp >= linkFromMs) {
    return t;
  }
  const anchor = events.find((event) => event.type === RRWEB_META && event.timestamp >= linkFromMs);
  return anchor ? anchor.timestamp - events[0].timestamp + t : undefined;
}
