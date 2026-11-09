jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

/**
 * rrweb's Replayer, reduced to what the player calls; every instance is kept.
 * Like rrweb, play() emits "start" and pause() emits "pause"; the skip speed
 * survives both and ends only when skip inactivity is turned off.
 */
class MockReplayer {
  static instances: MockReplayer[] = [];
  readonly calls: string[] = [];
  readonly added: Array<{ timestamp: number }> = [];
  readonly handlers = new Map<string, Array<(payload?: unknown) => void>>();
  readonly wrapper = { style: {} as Record<string, string> };
  readonly iframe = { contentDocument: null };
  current = 0;
  speed = 1;
  readonly service = { state: { context: { events: this.added } } };

  constructor(
    readonly events: Array<{ timestamp: number }>,
    readonly config: Record<string, unknown>
  ) {
    MockReplayer.instances.push(this);
  }
  on(event: string, handler: (payload?: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string) {
    this.handlers.get(event)?.forEach((handler) => handler());
  }
  play(offset = this.current) {
    this.current = offset;
    this.calls.push(`play ${offset}`);
    this.emit('start');
  }
  pause(offset?: number) {
    if (offset !== undefined) {
      this.current = offset;
    }
    this.calls.push(`pause ${offset}`);
    this.emit('pause');
  }
  startLive(baseline: number) {
    this.calls.push(`live ${baseline}`);
  }
  getMetaData() {
    const times = this.added.map((event) => event.timestamp);
    return { startTime: Math.min(...times), endTime: Math.max(...times), totalTime: 0 };
  }
  addEvent(event: { timestamp: number }) {
    this.added.push(event);
  }
  getCurrentTime() {
    return this.current;
  }
  setConfig(config: { skipInactive?: boolean }) {
    if (config.skipInactive === false) {
      this.speed = 1;
    }
    this.calls.push(`setConfig ${JSON.stringify(config)}`);
  }
  destroy() {}
}

jest.mock('@grafana/rrweb', () => ({
  get Replayer() {
    return MockReplayer;
  },
}));

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { chunksOf, indexFromLines, linesOf, SESSION_ID } from '../../lib/fixtures';
import { decodeReplayLines, ReplayTimeline } from '../../lib/replayEvents';
import { testIds } from '../testIds';
import { FOCUS_DEBOUNCE_MS, ReplayPlayer } from './ReplayPlayer';

global.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as unknown as typeof ResizeObserver;

const MIN = 60_000;
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

/** Six checkouts, 5 minutes apart: 29 minutes. */
const lines = linesOf(
  Array.from({ length: 6 }, (_, gen) => [
    { event: meta(gen * 5 * MIN) as Event, gen },
    { event: snapshot(gen * 5 * MIN + 1) as Event, gen },
    { event: incremental(gen * 5 * MIN + 4 * MIN) as Event, gen },
  ]).flat()
);
const all = chunksOf(lines);

describe('ReplayPlayer, loading progressively', () => {
  beforeEach(() => {
    MockReplayer.instances = [];
  });

  it('shows the full length and what is not loaded yet before any chunk is there, then starts at the target', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    const onTarget = jest.fn();
    const { rerender } = render(
      <ReplayPlayer track={replay.tracks[0]} initialOffsetMs={12 * MIN} onTarget={onTarget} />
    );

    expect(screen.getByTestId(testIds.player.clock)).toHaveTextContent('/ 29:00');
    expect(screen.getByTestId(testIds.player.waiting)).toHaveTextContent('Loading…');
    expect(screen.getByTestId(testIds.player.unloaded)).toBeInTheDocument();
    expect(onTarget).toHaveBeenCalledWith(12 * MIN);
    expect(MockReplayer.instances).toHaveLength(0);

    // Another chunk arrives first: still nothing to show at the target.
    replay.addChunk('rec1:4', all.get('rec1:4')!);
    rerender(<ReplayPlayer track={replay.tracks[0]} initialOffsetMs={12 * MIN} onTarget={onTarget} />);
    expect(MockReplayer.instances).toHaveLength(0);

    replay.addChunk('rec1:2', all.get('rec1:2')!);
    rerender(<ReplayPlayer track={replay.tracks[0]} initialOffsetMs={12 * MIN} onTarget={onTarget} />);

    const [replayer] = MockReplayer.instances;
    // The anchor (offsets count from the track start), the target chunk, and the loaded run after it is not
    // loaded (gen 3 is missing), so gen 4 waits.
    expect(replayer.events.map((event) => event.timestamp / MIN)).toEqual([0, 10, 10 + 1 / MIN, 14]);
    expect(replayer.events[0]).toBe(replay.tracks[0].anchor);
    expect(replayer.calls).toEqual([`pause ${12 * MIN}`]);
    expect(screen.queryByTestId(testIds.player.waiting)).not.toBeInTheDocument();
  });

  it('waits with "Loading…" where playback runs out of loaded chunks, and goes on when the next arrives', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    const { rerender } = render(<ReplayPlayer track={replay.tracks[0]} autoPlay />);
    const [replayer] = MockReplayer.instances;
    expect(replayer.calls).toEqual(['play 0']);

    // rrweb played the last loaded event; gen 1 is not there yet.
    replayer.current = 4 * MIN;
    act(() => replayer.emit('finish'));
    expect(screen.getByTestId(testIds.player.waiting)).toHaveTextContent('Loading…');

    replay.addChunk('rec1:1', all.get('rec1:1')!);
    rerender(<ReplayPlayer track={replay.tracks[0]} autoPlay />);

    expect(replayer.added.map((event) => event.timestamp / MIN)).toEqual([5, 5 + 1 / MIN, 9]);
    expect(replayer.calls[replayer.calls.length - 1]).toBe(`play ${4 * MIN}`);
    expect(screen.queryByTestId(testIds.player.waiting)).not.toBeInTheDocument();
  });

  it('stops at the real end', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    ['rec1:4', 'rec1:5'].forEach((key) => replay.addChunk(key, all.get(key)!));
    render(<ReplayPlayer track={replay.tracks[0]} initialOffsetMs={26 * MIN} autoPlay />);
    const [replayer] = MockReplayer.instances;

    replayer.current = 29 * MIN;
    act(() => replayer.emit('finish'));

    expect(screen.queryByTestId(testIds.player.waiting)).not.toBeInTheDocument();
    expect(screen.getByTestId(testIds.player.play)).toHaveAttribute('aria-label', 'Play');
  });

  it('seeks into a part not loaded yet: waits there and asks for it', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    const onTarget = jest.fn();
    const { rerender } = render(<ReplayPlayer track={replay.tracks[0]} onTarget={onTarget} />);
    const [replayer] = MockReplayer.instances;

    rerender(
      <ReplayPlayer track={replay.tracks[0]} onTarget={onTarget} seekRequest={{ offsetMs: 21 * MIN, nonce: 1 }} />
    );

    expect(onTarget).toHaveBeenLastCalledWith(21 * MIN);
    expect(replayer.calls[replayer.calls.length - 1]).toBe(`pause ${21 * MIN}`);
    expect(screen.getByTestId(testIds.player.waiting)).toBeInTheDocument();

    replay.addChunk('rec1:4', all.get('rec1:4')!);
    rerender(
      <ReplayPlayer track={replay.tracks[0]} onTarget={onTarget} seekRequest={{ offsetMs: 21 * MIN, nonce: 1 }} />
    );

    expect(replayer.added.map((event) => event.timestamp / MIN)).toEqual([20, 20 + 1 / MIN, 24]);
    expect(screen.queryByTestId(testIds.player.waiting)).not.toBeInTheDocument();
  });

  it('pauses at a part not loaded yet during playback, out of any fast-forward, and stops its ticker', async () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    replay.addChunk('rec1:2', all.get('rec1:2')!);
    const { rerender } = render(<ReplayPlayer track={replay.tracks[0]} autoPlay />);
    const [replayer] = MockReplayer.instances;

    // rrweb raced at 360× past the loaded chunk into gen 1, which is not loaded.
    replayer.speed = 360;
    replayer.current = 6 * MIN;
    await waitFor(() => expect(screen.getByTestId(testIds.player.waiting)).toBeInTheDocument());

    expect(replayer.speed).toBe(1);
    const calls = replayer.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nothing more while it waits: no pause, sync or re-render every frame.
    expect(replayer.calls.length).toBe(calls);

    replay.addChunk('rec1:1', all.get('rec1:1')!);
    rerender(<ReplayPlayer track={replay.tracks[0]} autoPlay />);
    expect(replayer.calls[replayer.calls.length - 1]).toBe(`play ${6 * MIN}`);
    expect(replayer.speed).toBe(1);
    expect(screen.queryByTestId(testIds.player.waiting)).not.toBeInTheDocument();
  });

  it('passes over a loaded chunk without events instead of finishing again and again', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    replay.addChunk('rec1:1', []);
    const { rerender } = render(<ReplayPlayer track={replay.tracks[0]} autoPlay />);
    const [replayer] = MockReplayer.instances;

    replayer.current = 4 * MIN;
    act(() => replayer.emit('finish'));

    // Gen 1 is empty: playback waits for gen 2.
    expect(screen.getByTestId(testIds.player.waiting)).toBeInTheDocument();
    const plays = replayer.calls.filter((call) => call.startsWith('play')).length;
    replay.addChunk('rec1:2', all.get('rec1:2')!);
    rerender(<ReplayPlayer track={replay.tracks[0]} autoPlay />);
    expect(replayer.calls.filter((call) => call.startsWith('play')).length).toBe(plays + 1);
  });

  it('asks the loader for a dragged position once the thumb rests', () => {
    jest.useFakeTimers();
    try {
      const replay = new ReplayTimeline(indexFromLines(lines));
      replay.addChunk('rec1:0', all.get('rec1:0')!);
      const onTarget = jest.fn();
      render(<ReplayPlayer track={replay.tracks[0]} onTarget={onTarget} />);
      onTarget.mockClear();
      const timeline = screen.getByTestId(testIds.player.timeline);

      for (const minute of [3, 6, 9, 12, 15, 18]) {
        fireEvent.change(timeline, { target: { value: String(minute * MIN) } });
        act(() => jest.advanceTimersByTime(FOCUS_DEBOUNCE_MS / 5));
      }
      expect(onTarget).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(FOCUS_DEBOUNCE_MS));

      expect(onTarget).toHaveBeenCalledTimes(1);
      expect(onTarget).toHaveBeenCalledWith(18 * MIN);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ReplayPlayer, live', () => {
  beforeEach(() => {
    MockReplayer.instances = [];
  });

  it('starts at the newest snapshot and never feeds it older chunks that load later', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    const { rerender } = render(<ReplayPlayer track={replay.tracks[0]} live />);
    expect(MockReplayer.instances).toHaveLength(0);

    replay.addChunk('rec1:5', all.get('rec1:5')!);
    rerender(<ReplayPlayer track={replay.tracks[0]} live />);
    const [replayer] = MockReplayer.instances;
    expect(replayer.added.map((event) => event.timestamp / MIN)).toEqual([25, 25 + 1 / MIN, 29]);

    // An older checkout finishes loading: rrweb would apply it at once over the live page.
    replay.addChunk('rec1:3', all.get('rec1:3')!);
    replay.addLive(
      decodeReplayLines(
        linesOf([{ event: incremental(29 * MIN + 5000) as Event, gen: 5 }]).map((entry) => ({
          ...entry,
          line: entry.line.replace('event_data_seq=0', 'event_data_seq=99'),
        })),
        SESSION_ID
      ).decoded
    );
    rerender(<ReplayPlayer track={replay.tracks[0]} live />);

    expect(replayer.added.map((event) => event.timestamp / MIN)).toEqual([25, 25 + 1 / MIN, 29, 29 + 5000 / MIN]);
  });
});
