jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import type { eventWithTime } from '@grafana/rrweb-types';
import { chunksOf, indexFromLines, linesOf } from './fixtures';
import { ReplayTimeline, type ReplayTrack } from './replayEvents';
import {
  chunkIndexAt,
  isReady,
  nextChunkOffset,
  readyAt,
  trackLength,
  TrackFeed,
  unloadedSpans,
  type FeedReplayer,
} from './replayFeed';

type Event = Record<string, unknown> & { timestamp: number };
const meta = (timestamp: number) => ({
  type: 4,
  timestamp,
  data: { href: `https://x/${timestamp}`, width: 1, height: 1 },
});
const snapshot = (timestamp: number) => ({
  type: 2,
  timestamp,
  data: { node: {}, initialOffset: { top: 0, left: 0 } },
});
const incremental = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, positions: [] } });
const MIN = 60_000;

/**
 * rrweb's rule, reduced: play/pause(offset) sets the baseline; addEvent of an
 * event before the baseline is applied at once (out of order: a flashback).
 */
class FakeReplayer implements FeedReplayer {
  events: eventWithTime[] = [];
  appliedOutOfOrder: eventWithTime[] = [];
  calls: string[] = [];
  private baseline = 0;
  current = 0;

  constructor(private readonly startMs: number) {}

  addEvent(event: eventWithTime) {
    this.events.push(event);
    if (event.timestamp < this.startMs + this.baseline) {
      this.appliedOutOfOrder.push(event);
    }
  }
  play(offset = this.current) {
    this.baseline = offset;
    this.current = offset;
    this.calls.push(`play ${offset}`);
  }
  pause(offset?: number) {
    if (offset !== undefined) {
      this.baseline = offset;
      this.current = offset;
    }
    this.calls.push(`pause ${offset}`);
  }
  getCurrentTime() {
    return this.current;
  }
}

/** One recording, a checkout every 5 minutes: gens 0–5, 30 minutes. */
const lines = linesOf(
  Array.from({ length: 6 }, (_, gen) => [
    { event: meta(gen * 5 * MIN) as Event, gen },
    { event: snapshot(gen * 5 * MIN + 1) as Event, gen },
    { event: incremental(gen * 5 * MIN + 2 * MIN) as Event, gen },
    { event: incremental(gen * 5 * MIN + 4 * MIN) as Event, gen },
  ]).flat()
);
const all = chunksOf(lines);

function timeline(loaded: number[]) {
  const replay = new ReplayTimeline(indexFromLines(lines));
  for (const gen of loaded) {
    replay.addChunk(`rec1:${gen}`, all.get(`rec1:${gen}`)!);
  }
  return replay;
}
const track = (loaded: number[]): ReplayTrack => timeline(loaded).tracks[0];
/** Loads more chunks into the same timeline (the same event objects), as the loader does. */
const load = (replay: ReplayTimeline, ...gens: number[]) => {
  gens.forEach((gen) => replay.addChunk(`rec1:${gen}`, all.get(`rec1:${gen}`)!));
  return replay.tracks[0];
};
const times = (events: ReadonlyArray<{ timestamp: number }>) => events.map((event) => event.timestamp / MIN);

describe('track geometry', () => {
  it('has its length from the index and finds the chunk at an offset', () => {
    const empty = track([]);

    expect(trackLength(empty)).toBe(29 * MIN);
    expect(chunkIndexAt(empty, 0)).toBe(0);
    expect(chunkIndexAt(empty, 12 * MIN)).toBe(2);
    expect(chunkIndexAt(empty, 10 * MIN)).toBe(2);
    expect(chunkIndexAt(empty, 99 * MIN)).toBe(5);
    expect(nextChunkOffset(empty, 12 * MIN)).toBe(15 * MIN);
    expect(nextChunkOffset(empty, 26 * MIN)).toBeUndefined();
  });

  it('hatches what is not loaded, merged into spans', () => {
    expect(unloadedSpans(track([0, 3]))).toEqual([
      { fromMs: 5 * MIN, toMs: 15 * MIN },
      { fromMs: 20 * MIN, toMs: 29 * MIN },
    ]);
    expect(unloadedSpans(track([0, 1, 2, 3, 4, 5]))).toEqual([]);
  });

  it('is ready where the chunk and what it depends on are loaded', () => {
    const replay = timeline([1]);
    const base = replay.tracks[0];
    // As for a gen whose Meta was lost: gen 2 depends on gen 1.
    const gap = {
      ...base,
      chunks: base.chunks.map((chunk) => (chunk.gen === 2 ? { ...chunk, dependsOn: 'rec1:1', loaded: true } : chunk)),
    };

    expect(isReady(gap, 2)).toBe(true);
    expect(isReady(gap, 0)).toBe(false);
    expect(readyAt(gap, 12 * MIN)).toBe(true);
    expect(
      readyAt(
        { ...gap, chunks: gap.chunks.map((chunk) => (chunk.gen === 1 ? { ...chunk, loaded: false } : chunk)) },
        12 * MIN
      )
    ).toBe(false);
  });
});

describe('TrackFeed', () => {
  it('starts at a target an hour in with the anchor and the target chunk only', () => {
    const current = track([3]);
    const feed = new TrackFeed(current);

    const initial = feed.initialEvents(16 * MIN)!;

    expect(initial[0]).toBe(current.anchor);
    expect(times(initial)).toEqual([0, 15, 15 + 1 / MIN, 17, 19]);
  });

  it('cannot start where nothing is loaded, or with fewer than two events', () => {
    expect(new TrackFeed(track([3])).initialEvents(6 * MIN)).toBeUndefined();
    expect(new TrackFeed(track([])).initialEvents(0)).toBeUndefined();
  });

  it('adds chunks ahead of the playhead as they arrive, only while the loaded run continues', () => {
    const replay = timeline([1]);
    const feed = new TrackFeed(replay.tracks[0]);
    const replayer = new FakeReplayer(0);
    feed.initialEvents(6 * MIN);
    replayer.play(6 * MIN);

    // Gen 3 arrives: gen 2 between is not loaded, so it waits (skip inactivity must not race over the gap).
    feed.setTrack(load(replay, 3));
    expect(feed.append(replayer)).toBe(0);
    // Gen 2 arrives: 2 and 3 continue the run.
    feed.setTrack(load(replay, 2));
    feed.append(replayer);

    expect(times(replayer.events)).toEqual([10, 10 + 1 / MIN, 12, 14, 15, 15 + 1 / MIN, 17, 19]);
    expect(replayer.appliedOutOfOrder).toEqual([]);
  });

  it('holds chunks behind the playhead, and merges them at the next seek there', () => {
    const replay = timeline([3]);
    const feed = new TrackFeed(replay.tracks[0]);
    const replayer = new FakeReplayer(0);
    feed.initialEvents(16 * MIN);
    replayer.play(16 * MIN);

    feed.setTrack(load(replay, 0));
    feed.append(replayer);
    expect(replayer.events).toEqual([]);
    expect(feed.hasHeld(16 * MIN)).toBe(false);
    expect(feed.hasHeld(1 * MIN)).toBe(true);

    expect(feed.seek(replayer, 1 * MIN, true)).toBe(true);

    // Gen 0 without its Meta: that is the anchor, given at creation.
    expect(times(replayer.events)).toEqual([1 / MIN, 2, 4]);
    // Added behind the old position, then rebuilt by the seek that follows at once.
    expect(replayer.calls[replayer.calls.length - 1]).toBe(`play ${MIN}`);
  });

  it('pauses at a seek into a part not loaded yet, and reports it', () => {
    const replay = timeline([0]);
    const feed = new TrackFeed(replay.tracks[0]);
    const replayer = new FakeReplayer(0);
    feed.initialEvents(0);

    expect(feed.seek(replayer, 12 * MIN, true)).toBe(false);
    expect(replayer.calls).toEqual([`pause ${12 * MIN}`]);

    feed.setTrack(load(replay, 2));
    expect(feed.seek(replayer, 12 * MIN, true)).toBe(true);
    expect(replayer.calls[1]).toBe(`play ${12 * MIN}`);
    expect(times(replayer.events)).toEqual([10, 10 + 1 / MIN, 12, 14]);
  });

  it('never adds an event twice', () => {
    const feed = new TrackFeed(track([0, 1]));
    const replayer = new FakeReplayer(0);
    const initial = feed.initialEvents(0)!;

    feed.seek(replayer, 0, false);
    feed.seek(replayer, 6 * MIN, false);
    feed.append(replayer);

    expect(initial).toHaveLength(8);
    expect(replayer.events).toEqual([]);
  });
});
