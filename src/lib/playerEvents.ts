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

/** URL of the page the user was on at `timestamp` (changes sorted by time); asked every frame, so by binary search. */
export function pageAt(changes: readonly PageChange[], timestamp: number): string | undefined {
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
 * after `linkFromMs`. Loading starts at the session start (see loadRange), so
 * that point is found among the track's Metas, all known from the index.
 */
export function linkOffset(
  track: { startMs: number; pages: ReadonlyArray<{ timestamp: number }> },
  linkFromMs: number | undefined,
  t = 0
): number {
  if (linkFromMs === undefined || track.startMs >= linkFromMs) {
    return t;
  }
  const anchor = track.pages.find((page) => page.timestamp >= linkFromMs);
  return anchor ? anchor.timestamp - track.startMs + t : t;
}
