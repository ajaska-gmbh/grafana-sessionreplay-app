import type { eventWithTime } from '@grafana/rrweb-types';
import type { ReplayChunk, ReplayTrack } from './replayEvents';

/** What the feed needs of rrweb's Replayer. */
export interface FeedReplayer {
  addEvent(event: eventWithTime): void;
  play(timeOffset?: number): void;
  pause(timeOffset?: number): void;
  getCurrentTime(): number;
}

/** Length of the track (ms), from the index: not from what is loaded. */
export function trackLength(track: ReplayTrack): number {
  return Math.max(0, track.endMs - track.startMs);
}

/**
 * The chunk playing at `offsetMs` (from the track start): the last one that
 * starts at or before it. Between two recordings (a reload) that is the
 * earlier recording's last chunk, whose page stays on screen.
 */
export function chunkIndexAt(track: ReplayTrack, offsetMs: number): number {
  const time = track.startMs + offsetMs;
  const { chunks } = track;
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (chunks[middle].startMs <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(0, low - 1);
}

function byKey(track: ReplayTrack): Map<string, ReplayChunk> {
  return new Map(track.chunks.map((chunk) => [chunk.key, chunk]));
}

/** The chunk at `index` and the chunks it depends on (oldest first). */
export function withDependencies(track: ReplayTrack, index: number): ReplayChunk[] {
  const chunks = byKey(track);
  const chain: ReplayChunk[] = [];
  let chunk: ReplayChunk | undefined = track.chunks[index];
  while (chunk && !chain.includes(chunk)) {
    chain.unshift(chunk);
    chunk = chunk.dependsOn ? chunks.get(chunk.dependsOn) : undefined;
  }
  return chain;
}

/** Whether the chunk at `index` can be played: it and what it depends on are loaded. */
export function isReady(track: ReplayTrack, index: number): boolean {
  return track.chunks.length === 0 || withDependencies(track, index).every((chunk) => chunk.loaded);
}

export function readyAt(track: ReplayTrack, offsetMs: number): boolean {
  return isReady(track, chunkIndexAt(track, offsetMs));
}

/** Where the chunk after the one at `offsetMs` starts (offset), or undefined for the last chunk. */
export function nextChunkOffset(track: ReplayTrack, offsetMs: number): number | undefined {
  const next = track.chunks[chunkIndexAt(track, offsetMs) + 1];
  return next ? next.startMs - track.startMs : undefined;
}

/** Spans (offsets) of the track not loaded yet, merged; drawn hatched on the timeline. */
export function unloadedSpans(track: ReplayTrack): Array<{ fromMs: number; toMs: number }> {
  const spans: Array<{ fromMs: number; toMs: number }> = [];
  for (const chunk of track.chunks) {
    if (chunk.loaded) {
      continue;
    }
    const fromMs = Math.max(0, chunk.startMs - track.startMs);
    const toMs = Math.max(fromMs, chunk.endMs - track.startMs);
    const last = spans[spans.length - 1];
    if (last && last.toMs >= fromMs) {
      last.toMs = Math.max(last.toMs, toMs);
    } else {
      spans.push({ fromMs, toMs });
    }
  }
  return spans;
}

/**
 * Hands a track's loaded chunks to one rrweb Replayer without ever disturbing
 * playback.
 *
 * rrweb applies an event older than the time it last played or seeked from
 * immediately, out of order (the page flashes back). So:
 * - at a seek (and at creation) the target chunk, what it depends on and the
 *   loaded chunks right after it are added, also ones behind the playhead,
 *   and the seek that follows rebuilds the page from the last snapshot;
 * - between seeks only chunks ahead of the playhead are added, and only while
 *   they continue the loaded run from it: a chunk past an unloaded one would
 *   let "skip inactivity" race over the gap. Everything else is held until a
 *   seek needs it.
 */
export class TrackFeed {
  private readonly added = new WeakSet<eventWithTime>();

  constructor(private current: ReplayTrack) {}

  /** The track changed (chunks loaded); the same tab. */
  setTrack(track: ReplayTrack): void {
    this.current = track;
  }

  /** The chunks a seek to `offsetMs` adds: target with dependencies, then the ready run after it. */
  private needed(offsetMs: number): ReplayChunk[] {
    const track = this.current;
    const index = chunkIndexAt(track, offsetMs);
    const chunks = withDependencies(track, index).filter((chunk) => chunk.loaded);
    for (let i = index + 1; i < track.chunks.length && isReady(track, i); i++) {
      chunks.push(track.chunks[i]);
    }
    return chunks;
  }

  /** Not yet added events of these chunks, at or after `fromMs` (rrweb time), in time order. */
  private fresh(chunks: ReplayChunk[], fromMs = -Infinity): eventWithTime[] {
    const events: eventWithTime[] = [];
    for (const chunk of chunks) {
      for (const event of chunk.events) {
        if (event.timestamp >= fromMs && !this.added.has(event)) {
          events.push(event);
        }
      }
    }
    // Chunks are in order and sorted within; a gen without Meta may overlap its neighbour.
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Events to create the Replayer with for a start at `offsetMs`: the track's
   * anchor (so offsets count from the track start) and what the start needs.
   * Undefined while the start is not loaded, or too little to play (rrweb
   * needs two events).
   */
  initialEvents(offsetMs: number): eventWithTime[] | undefined {
    const track = this.current;
    if (!readyAt(track, offsetMs)) {
      return undefined;
    }
    const events = this.fresh(this.needed(offsetMs)).filter((event) => event !== track.anchor);
    if (events.length === 0) {
      return undefined;
    }
    const initial = [track.anchor, ...events];
    initial.forEach((event) => this.added.add(event));
    return initial;
  }

  /**
   * Seek: add what the target needs, then play or pause there (which rebuilds
   * the page, so events added behind the playhead are harmless). Returns
   * whether the target is loaded; if not, the caller waits for it.
   */
  seek(replayer: FeedReplayer, offsetMs: number, play: boolean): boolean {
    for (const event of this.fresh(this.needed(offsetMs))) {
      replayer.addEvent(event);
      this.added.add(event);
    }
    const ready = readyAt(this.current, offsetMs);
    if (play && ready) {
      replayer.play(offsetMs);
    } else {
      replayer.pause(offsetMs);
    }
    return ready;
  }

  /** Whether a seek to `offsetMs` would add events held so far. */
  hasHeld(offsetMs: number): boolean {
    return this.fresh(this.needed(offsetMs)).length > 0;
  }

  /**
   * New chunks arrived: add the events that continue the loaded run ahead of
   * the playhead. Events behind it are held (see the class comment).
   */
  append(replayer: FeedReplayer): number {
    const track = this.current;
    const offsetMs = replayer.getCurrentTime();
    const index = chunkIndexAt(track, offsetMs);
    const run: ReplayChunk[] = [];
    for (let i = index; i < track.chunks.length && isReady(track, i); i++) {
      run.push(track.chunks[i]);
    }
    const events = this.fresh(run, track.startMs + offsetMs);
    for (const event of events) {
      replayer.addEvent(event);
      this.added.add(event);
    }
    return events.length;
  }
}
