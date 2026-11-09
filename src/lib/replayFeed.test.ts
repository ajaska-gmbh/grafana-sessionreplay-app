jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import type { eventWithTime } from '@grafana/rrweb-types';
import { chunksOf, indexFromLines, linesOf } from './fixtures';
import { ReplayTimeline, type ReplayTrack } from './replayEvents';
import {
  afterRun,
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
 * rrweb's rules, reduced: play/pause(offset) sets the baseline; addEvent of an
 * event before the baseline is applied at once (out of order: a flashback),
 * a later one is queued. A fast-forward through inactivity keeps its speed
 * across play/pause; only turning skip inactivity off ends it (backToNormal).
 */
class FakeReplayer implements FeedReplayer {
  events: eventWithTime[] = [];
  appliedOutOfOrder: eventWithTime[] = [];
  calls: string[] = [];
  private baseline = 0;
  current = 0;
  speed = 1;
  skipInactive = true;

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
  setConfig(config: { skipInactive: boolean }) {
    this.skipInactive = config.skipInactive;
    if (!config.skipInactive) {
      this.speed = 1;
    }
    this.calls.push(`skipInactive ${config.skipInactive}`);
  }
  /** rrweb found inactivity ahead and fast-forwards. */
  startSkipping() {
    this.speed = 360;
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
    expect(replayer.calls.filter((call) => !call.startsWith('skip'))).toEqual([`pause ${12 * MIN}`]);

    feed.setTrack(load(replay, 2));
    expect(feed.seek(replayer, 12 * MIN, true)).toBe(true);
    expect(replayer.calls[replayer.calls.length - 1]).toBe(`play ${12 * MIN}`);
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

  it('ends a fast-forward through inactivity at every seek, keeping the setting', () => {
    const feed = new TrackFeed(track([0, 1, 2]));
    const replayer = new FakeReplayer(0);
    feed.initialEvents(0);
    replayer.play(0);
    replayer.startSkipping();

    feed.seek(replayer, 6 * MIN, true);

    expect(replayer.speed).toBe(1);
    expect(replayer.skipInactive).toBe(true);
    // Reset before the seek plays, so it plays at normal speed.
    expect(replayer.calls.slice(-3)).toEqual(['skipInactive false', 'skipInactive true', `play ${6 * MIN}`]);
  });

  it('leaves skip inactivity off when the user turned it off', () => {
    const feed = new TrackFeed(track([0]));
    feed.setSkipInactive(false);
    const replayer = new FakeReplayer(0);

    feed.seek(replayer, 1 * MIN, true);

    expect(replayer.skipInactive).toBe(false);
  });

  it('pauses at a gap reached while skipping out of the fast-forward, so resuming plays at normal speed', () => {
    // A share link an hour in, then a jump back to 5 min with chunk 2 missing.
    const replay = timeline([1, 3]);
    const feed = new TrackFeed(replay.tracks[0]);
    const replayer = new FakeReplayer(0);
    feed.initialEvents(16 * MIN);
    replayer.play(16 * MIN);
    feed.seek(replayer, 5 * MIN, true);
    replayer.startSkipping();
    replayer.current = 11 * MIN;
    expect(readyAt(replay.tracks[0], replayer.current)).toBe(false);

    feed.pauseForGap(replayer);
    expect(replayer.speed).toBe(1);
    feed.setTrack(load(replay, 2));
    feed.seek(replayer, 11 * MIN, true);

    expect(replayer.speed).toBe(1);
    expect(replayer.calls[replayer.calls.length - 1]).toBe(`play ${11 * MIN}`);
  });

  it('seeks back after a seek forward: adds what the earlier target needs, once, and rebuilds there', () => {
    const replay = timeline([3]);
    const feed = new TrackFeed(replay.tracks[0]);
    const replayer = new FakeReplayer(0);
    feed.initialEvents(16 * MIN);
    replayer.pause(16 * MIN);
    feed.setTrack(load(replay, 0, 4));
    feed.seek(replayer, 21 * MIN, true);
    const forward = replayer.events.length;

    feed.seek(replayer, 3 * MIN, true);
    feed.seek(replayer, 21 * MIN, true);
    feed.seek(replayer, 3 * MIN, false);

    expect(times(replayer.events.slice(0, forward))).toEqual([20, 20 + 1 / MIN, 22, 24]);
    // Gen 0 (its Meta is the anchor, given at creation), added once though sought to twice.
    expect(times(replayer.events.slice(forward))).toEqual([1 / MIN, 2, 4]);
    // Added behind the playhead (applied at once), then rebuilt by the seek that follows.
    expect(times(replayer.appliedOutOfOrder)).toEqual([1 / MIN, 2, 4]);
    expect(replayer.calls[replayer.calls.length - 1]).toBe(`pause ${3 * MIN}`);
  });
});

describe('afterRun', () => {
  it('passes over loaded chunks without events, then waits, plays on or ends', () => {
    const replay = timeline([0, 1]);
    const base = replay.tracks[0];
    const emptyThird = {
      ...base,
      chunks: base.chunks.map((chunk) => (chunk.gen === 2 ? { ...chunk, loaded: true, events: [] } : chunk)),
    };

    expect(afterRun(base, 4 * MIN)).toEqual({ kind: 'play' });
    expect(afterRun(emptyThird, 9 * MIN)).toEqual({ kind: 'wait', waitFor: 15 * MIN });
    const allEmptyAfter = {
      ...emptyThird,
      chunks: emptyThird.chunks.map((chunk) => (chunk.gen > 2 ? { ...chunk, loaded: true, events: [] } : chunk)),
    };
    expect(afterRun(allEmptyAfter, 9 * MIN)).toEqual({ kind: 'end' });
  });
});
