import type { eventWithTime } from '@grafana/rrweb-types';
import { byStart, parseAudioLevelLine, type AudioLevelWindow } from './audioLevels';
import { buildJourney, type JourneyEvent } from './journey';
import { compareNs } from './loki';
import { decodeReplayLines, mergeReplayEvents, type DecodedReplayEvent } from './replayEvents';
import { StylesheetResolver } from './stylesheetRefs';
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
  private readonly stylesheets = new StylesheetResolver();
  private readonly journeyLines = new Map<string, LokiLine>();
  /** Keys of the level lines seen; only new lines are parsed. */
  private readonly audioLevelKeys = new Set<string>();
  private replayCursorNs?: string;
  private journeyCursorNs?: string;
  private audioLevelCursorNs?: string;

  tracks: eventWithTime[][] = [];
  journey: JourneyEvent[] = [];
  /** The dialer's per-second audio levels (empty for other apps), sorted. */
  audioLevels: AudioLevelWindow[] = [];
  skipped = 0;
  /** Stylesheet references (ajaska-css) that could not be resolved; those render unstyled. */
  unresolvedStylesheets = 0;
  /** Distinct stylesheet texts the viewer did not keep (size cap). */
  droppedStylesheets = 0;
  /** Loki (server) time of the newest replay line, epoch ms. */
  lastReplayMs?: number;

  constructor(private readonly sessionId: string) {}

  addReplayLines(lines: LokiLine[]): void {
    if (lines.length === 0) {
      return;
    }
    const { decoded, skipped } = decodeReplayLines(lines, this.sessionId);
    this.skipped += skipped;
    // Only events not loaded before; pages overlap. Resolved in place, before
    // the player sees them (it appends events by identity).
    this.stylesheets.addEvents(decoded.filter((entry) => !this.known.has(entry.key)).map((entry) => entry.event));
    this.unresolvedStylesheets = this.stylesheets.unresolved;
    this.droppedStylesheets = this.stylesheets.droppedTexts;
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

  addAudioLevelLines(lines: LokiLine[]): void {
    if (lines.length === 0) {
      return;
    }
    const added: AudioLevelWindow[] = [];
    for (const entry of lines) {
      const key = `${entry.tsNs}\u0000${entry.line}`;
      if (this.audioLevelKeys.has(key)) {
        continue;
      }
      this.audioLevelKeys.add(key);
      const window = parseAudioLevelLine(entry.tsNs, entry.line, this.sessionId);
      if (window) {
        added.push(window);
      }
    }
    if (added.length > 0) {
      // A new array, so React sees the change; earlier windows are not parsed again.
      this.audioLevels = [...this.audioLevels, ...added].sort(byStart);
    }
    this.audioLevelCursorNs = maxNs(this.audioLevelCursorNs, lines);
  }

  audioLevelCursorMs(fallbackMs: number): number {
    return this.audioLevelCursorNs ? nsToMs(this.audioLevelCursorNs) : fallbackMs;
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
