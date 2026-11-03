import type { eventWithTime } from '@grafana/rrweb-types';
import { buildJourney, type JourneyEvent } from './journey';
import { compareNs } from './loki';
import { decodeReplayLines, mergeReplayEvents, type DecodedReplayEvent } from './replayEvents';
import type { LokiLine } from '../types';

/** A session counts as live while its recording received data this recently. */
export const LIVE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Everything loaded for one session, fed page by page — first the initial
 * load, then (in live mode) the newest lines on every poll. Pages may overlap;
 * duplicates are dropped. Cursors remember where the next poll starts.
 */
export class SessionStore {
  private readonly known = new Map<string, DecodedReplayEvent>();
  private readonly journeyLines = new Map<string, LokiLine>();
  private replayCursorNs?: string;
  private journeyCursorNs?: string;

  tracks: eventWithTime[][] = [];
  journey: JourneyEvent[] = [];
  skipped = 0;
  /** Loki (server) time of the newest replay line, epoch ms. */
  lastReplayMs?: number;

  constructor(private readonly sessionId: string) {}

  addReplayLines(lines: LokiLine[]): void {
    if (lines.length === 0) {
      return;
    }
    const { decoded, skipped } = decodeReplayLines(lines, this.sessionId);
    this.skipped += skipped;
    this.tracks = mergeReplayEvents(this.known, decoded);
    this.replayCursorNs = maxNs(this.replayCursorNs, lines);
    this.lastReplayMs = this.replayCursorNs ? nsToMs(this.replayCursorNs) : undefined;
  }

  addJourneyLines(lines: LokiLine[]): void {
    if (lines.length === 0) {
      return;
    }
    let added = false;
    for (const entry of lines) {
      const key = `${entry.tsNs}\u0000${entry.line}`;
      if (!this.journeyLines.has(key)) {
        this.journeyLines.set(key, entry);
        added = true;
      }
    }
    if (added) {
      this.journey = buildJourney(this.journeyLines.values(), this.sessionId);
    }
    this.journeyCursorNs = maxNs(this.journeyCursorNs, lines);
  }

  /** Where the next poll of each stream starts (epoch ms, inclusive). */
  replayCursorMs(fallbackMs: number): number {
    return this.replayCursorNs ? nsToMs(this.replayCursorNs) : fallbackMs;
  }

  journeyCursorMs(fallbackMs: number): number {
    return this.journeyCursorNs ? nsToMs(this.journeyCursorNs) : fallbackMs;
  }

  isActive(nowMs: number): boolean {
    return this.lastReplayMs !== undefined && nowMs - this.lastReplayMs < LIVE_WINDOW_MS;
  }
}

function maxNs(current: string | undefined, lines: LokiLine[]): string | undefined {
  let max = current;
  for (const { tsNs } of lines) {
    if (max === undefined || compareNs(tsNs, max) > 0) {
      max = tsNs;
    }
  }
  return max;
}

/** Floor to ms: the next query restarts inside the same millisecond, duplicates are dropped. */
function nsToMs(tsNs: string): number {
  return Math.floor(Number(tsNs.slice(0, -6)) || 0);
}
