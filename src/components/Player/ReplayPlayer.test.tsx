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
  /** The iframe's and the mouse tail's size attributes: rrweb sets them to every recorded viewport, then the player may change them. */
  readonly sized: Record<string, Record<string, string>> = { iframe: {}, tail: {} };
  readonly wrapper = {
    style: {} as Record<string, string>,
    querySelector: (selector: string) =>
      selector === 'canvas.replayer-mouse-tail'
        ? {
            getAttribute: (name: string) => this.sized.tail[name] ?? null,
            setAttribute: (name: string, value: string) => (this.sized.tail[name] = value),
          }
        : null,
  };
  readonly iframe = {
    contentDocument: null,
    contentWindow: { scrollTo: jest.fn() },
    getAttribute: (name: string) => this.sized.iframe[name] ?? null,
    setAttribute: (name: string, value: string) => (this.sized.iframe[name] = value),
  };
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
  emit(event: string, payload?: unknown) {
    this.handlers.get(event)?.forEach((handler) => handler(payload));
  }
  /** Applies an event as rrweb does: a viewport size resizes the iframe and tells the resize listeners, then "event-cast". */
  cast(event: { type: number; timestamp: number; data: Record<string, unknown> }) {
    const { width, height, source } = event.data as { width?: number; height?: number; source?: number };
    if (event.type === 4 || (event.type === 3 && source === 4)) {
      this.sized.iframe = { width: String(width), height: String(height) };
      this.sized.tail = { width: String(width), height: String(height) };
      this.emit('resize', { width, height });
    }
    this.emit('event-cast', event);
  }
  /** A page load at this size. */
  meta(width: number, height: number, timestamp = 0) {
    this.cast({ type: 4, timestamp, data: { href: 'https://x/', width, height } });
  }
  /** A resize (rrweb's ViewportResize) to this size. */
  resize(width: number, height: number, timestamp = 0) {
    this.cast({ type: 3, timestamp, data: { source: 4, width, height } });
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
import { PlayerClock } from '../../lib/playerClock';
import { decodeReplayLines, ReplayTimeline } from '../../lib/replayEvents';
import { REPLAY_STYLE_RULES } from '../../lib/replayStyles';
import type { ZoomSample } from '../../lib/viewportZoom';
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

describe('ReplayPlayer, edge cases', () => {
  beforeEach(() => {
    MockReplayer.instances = [];
  });

  it('does not re-target the loader from playback while a drag is about to', () => {
    jest.useFakeTimers();
    try {
      const replay = new ReplayTimeline(indexFromLines(lines));
      ['rec1:0', 'rec1:1', 'rec1:2'].forEach((key) => replay.addChunk(key, all.get(key)!));
      const onTarget = jest.fn();
      render(<ReplayPlayer track={replay.tracks[0]} onTarget={onTarget} autoPlay />);
      const [replayer] = MockReplayer.instances;
      onTarget.mockClear();

      fireEvent.change(screen.getByTestId(testIds.player.timeline), { target: { value: String(12 * MIN) } });
      // Playback runs on into another chunk while the thumb has not rested yet.
      replayer.current = 6 * MIN;
      act(() => jest.advanceTimersByTime(FOCUS_DEBOUNCE_MS / 2));
      expect(onTarget).not.toHaveBeenCalled();

      act(() => jest.advanceTimersByTime(FOCUS_DEBOUNCE_MS));
      // The drag's target first; only then playback's own position again.
      expect(onTarget.mock.calls[0]).toEqual([12 * MIN]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('replays pinch zooms of a touch recording at the layout width, other resizes as recorded', () => {
    const touchLines = linesOf([
      { event: meta(0) as Event, gen: 0 },
      { event: snapshot(1) as Event, gen: 0 },
      { event: { type: 3, timestamp: 2, data: { source: 6, positions: [] } } as Event, gen: 0 },
      { event: incremental(MIN) as Event, gen: 0 },
    ]);
    const replay = new ReplayTimeline(indexFromLines(touchLines));
    replay.addChunk('rec1:0', chunksOf(touchLines).get('rec1:0')!);
    render(<ReplayPlayer track={replay.tracks[0]} />);
    const [replayer] = MockReplayer.instances;

    act(() => replayer.meta(320, 582));
    expect(replayer.sized.iframe).toEqual({ width: '320', height: '582' });

    // Zoomed in: rrweb sized the iframe 274 px wide; the page stays laid out at 320.
    act(() => replayer.resize(274, 506));
    expect(replayer.sized.iframe).toEqual({ width: '320', height: '591' });
    expect(replayer.sized.tail).toEqual({ width: '320', height: '591' });
    // rrweb's resize on creation (a timer) sizes the iframe again: the player keeps its size.
    act(() => replayer.emit('resize', { width: 274, height: 506 }));
    expect(replayer.sized.iframe).toEqual({ width: '320', height: '591' });

    // Turned to landscape: a real resize.
    act(() => replayer.resize(640, 300));
    expect(replayer.sized.iframe).toEqual({ width: '640', height: '300' });

    // A new page at the narrower size is a page, not a zoom.
    act(() => replayer.meta(274, 506));
    expect(replayer.sized.iframe).toEqual({ width: '274', height: '506' });
  });

  it('keeps a phone recording steady while the URL bar shows and hides', () => {
    jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(408);
    const touchLines = linesOf([
      { event: meta(0) as Event, gen: 0 },
      { event: snapshot(1) as Event, gen: 0 },
      { event: { type: 3, timestamp: 2, data: { source: 2, type: 7, id: 1, x: 1, y: 1 } } as Event, gen: 0 },
      { event: incremental(MIN) as Event, gen: 0 },
    ]);
    const replay = new ReplayTimeline(indexFromLines(touchLines));
    replay.addChunk('rec1:0', chunksOf(touchLines).get('rec1:0')!);
    render(<ReplayPlayer track={replay.tracks[0]} />);
    const [replayer] = MockReplayer.instances;
    const style = replayer.wrapper.style;

    act(() => replayer.meta(430, 816));
    const steady = { transform: style.transform, left: style.left, top: style.top };
    expect(steady).toEqual({ transform: 'scale(0.5)', left: '392.5px', top: '0px' });

    // iOS Safari: the URL bar shows (shorter viewport) and hides again while the buyer scrolls.
    for (const height of [775, 790, 816, 775]) {
      act(() => replayer.resize(430, height));
      expect({ transform: style.transform, left: style.left, top: style.top }).toEqual(steady);
    }
    jest.restoreAllMocks();
  });

  it('styles the replayed page: card fields as stars, no scroll anchoring', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    render(<ReplayPlayer track={replay.tracks[0]} />);

    expect(MockReplayer.instances[0].config.insertStyleRules).toEqual(REPLAY_STYLE_RULES);
  });

  it('lays out a page that opened zoomed out at its real width, also after URL bar changes', () => {
    // The page was wider than the 412 px screen: the browser showed 576 px of it; the page sent its layout size.
    const zoom: ZoomSample[] = [
      {
        timeMs: 10,
        scale: 1,
        offsetLeft: 0,
        offsetTop: 0,
        width: 412,
        height: 839,
        layoutWidth: 412,
        layoutHeight: 839,
      },
    ];
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    render(<ReplayPlayer track={replay.tracks[0]} zoom={zoom} />);
    const [replayer] = MockReplayer.instances;

    act(() => replayer.meta(576, 1173, 0));
    expect(replayer.sized.iframe).toEqual({ width: '412', height: '839' });
    act(() => replayer.resize(576, 1229, 20));
    expect(replayer.sized.iframe).toEqual({ width: '412', height: '879' });
    // Turned to landscape (it fits there), and back.
    act(() => replayer.resize(839, 412, 30));
    expect(replayer.sized.iframe).toEqual({ width: '839', height: '412' });
    act(() => replayer.resize(576, 1173, 40));
    expect(replayer.sized.iframe).toEqual({ width: '412', height: '839' });
  });

  it('starts a page reached by a seek at its own scroll position, unless it was scrolled since', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    render(<ReplayPlayer track={replay.tracks[0]} />);
    const [replayer] = MockReplayer.instances;
    const snapshotAt = (top: number) => ({
      type: 2,
      timestamp: 1,
      data: { node: { id: 1 }, initialOffset: { left: 0, top } },
    });

    act(() => {
      replayer.cast(snapshotAt(120));
      replayer.emit('flush');
    });
    expect(replayer.iframe.contentWindow.scrollTo).toHaveBeenLastCalledWith(0, 120);

    replayer.iframe.contentWindow.scrollTo.mockClear();
    act(() => {
      replayer.cast(snapshotAt(0));
      replayer.cast({ type: 3, timestamp: 2, data: { source: 3, id: 7, x: 0, y: 50 } });
      replayer.cast({ type: 3, timestamp: 3, data: { source: 3, id: 1, x: 0, y: 400 } });
      replayer.emit('flush');
      // A flush without a page load in between leaves the scroll alone.
      replayer.emit('flush');
    });
    expect(replayer.iframe.contentWindow.scrollTo).not.toHaveBeenCalled();
  });

  it("shows the visitor's zoom over the page at its layout width, and turns it off on request", () => {
    jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1164);
    const zoomed = (timeMs: number, scale: number, offsetLeft: number, offsetTop: number): ZoomSample => ({
      timeMs,
      scale,
      offsetLeft,
      offsetTop,
      width: 320 / scale,
      height: 582 / scale,
      layoutWidth: 320,
      layoutHeight: 582,
    });
    const zoom = [zoomed(MIN, 2, 100, 200), zoomed(MIN + 300, 1, 0, 0)];
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    const clock = new PlayerClock();
    render(<ReplayPlayer track={replay.tracks[0]} clock={clock} zoom={zoom} />);
    const [replayer] = MockReplayer.instances;
    const style = replayer.wrapper.style;

    act(() => replayer.meta(320, 582));
    expect(style.transform).toBe('scale(1)');
    expect(style.clipPath).toBe('');

    // Pinched to 2x: rrweb resizes to the visible 160 px; the page stays 320 px wide, the visible area fills the stage.
    act(() => clock.update({ startTimeMs: 0, offsetMs: MIN }));
    act(() => replayer.resize(160, 291));
    expect(replayer.sized.iframe).toEqual({ width: '320', height: '582' });
    expect(style.transform).toBe('scale(2) translate(-100px, -200px)');
    expect(style.clipPath).toBe('inset(200px 60px 91px 100px)');
    // Halfway back to 1x.
    act(() => clock.update({ offsetMs: MIN + 150 }));
    expect(style.transform).toBe('scale(1.5) translate(-50px, -100px)');

    fireEvent.click(screen.getByTestId(testIds.player.zoom));
    expect(style.transform).toBe('scale(1)');
    expect(style.clipPath).toBe('');
    fireEvent.click(screen.getByTestId(testIds.player.zoom));
    expect(style.transform).toBe('scale(1.5) translate(-50px, -100px)');

    act(() => clock.update({ offsetMs: MIN + 1000 }));
    expect(style.transform).toBe('scale(1)');
    jest.restoreAllMocks();
  });

  it('offers the zoom only for recordings with zoom data', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:0', all.get('rec1:0')!);
    render(<ReplayPlayer track={replay.tracks[0]} />);
    expect(screen.queryByTestId(testIds.player.zoom)).not.toBeInTheDocument();
  });

  it('says nothing was recorded where the start chunk is loaded but empty and nothing follows', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    ['rec1:4', 'rec1:5'].forEach((key) => replay.addChunk(key, []));

    render(<ReplayPlayer track={replay.tracks[0]} initialOffsetMs={26 * MIN} />);

    expect(screen.getByTestId(testIds.player.waiting)).toHaveTextContent('Nothing was recorded here.');
    expect(MockReplayer.instances).toHaveLength(0);
  });
});

describe('ReplayPlayer, live', () => {
  beforeEach(() => {
    MockReplayer.instances = [];
  });

  it('says it waits for the newest chunk, and that it retries one that failed', () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    const { rerender } = render(<ReplayPlayer track={replay.tracks[0]} live />);
    expect(screen.getByTestId(testIds.player.waiting)).toHaveTextContent('Loading…');

    replay.failChunk('rec1:5');
    rerender(<ReplayPlayer track={replay.tracks[0]} live />);
    expect(screen.getByTestId(testIds.player.waiting)).toHaveTextContent('retrying');

    replay.retryChunk('rec1:5');
    replay.addChunk('rec1:5', all.get('rec1:5')!);
    rerender(<ReplayPlayer track={replay.tracks[0]} live />);
    expect(screen.queryByTestId(testIds.player.waiting)).not.toBeInTheDocument();
    expect(MockReplayer.instances).toHaveLength(1);
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

  it("follows the visitor's zoom live too", () => {
    const replay = new ReplayTimeline(indexFromLines(lines));
    replay.addChunk('rec1:5', all.get('rec1:5')!);
    const clock = new PlayerClock();
    const zoom: ZoomSample[] = [
      { timeMs: 25 * MIN, scale: 2, offsetLeft: 0, offsetTop: 0, width: 1, height: 1, layoutWidth: 2, layoutHeight: 2 },
    ];
    render(<ReplayPlayer track={replay.tracks[0]} live clock={clock} zoom={zoom} />);
    const [replayer] = MockReplayer.instances;
    act(() => replayer.meta(2, 2));
    act(() => clock.update({ startTimeMs: 25 * MIN, offsetMs: 10 }));
    expect(replayer.wrapper.style.transform).toMatch(/^scale\([\d.e-]+\) translate\(0px, 0px\)$/);
    expect(screen.getByTestId(testIds.player.zoom)).toBeInTheDocument();
  });
});
