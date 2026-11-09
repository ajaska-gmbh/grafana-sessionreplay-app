jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import type { LokiLine } from '../types';

interface Call {
  expr: string;
  fromMs: number;
  toMs: number;
  limit: number;
  direction: string;
  signal?: AbortSignal;
}

/** Every request, and the chunk requests held until the test releases them. */
const calls: Call[] = [];
const held = new Map<string, { release: () => void; signal?: AbortSignal }>();
let answer: (call: Call) => LokiLine[] = () => [];
let holdChunks = false;

jest.mock('../lib/loki', () => {
  const actual = jest.requireActual('../lib/loki');
  return {
    ...actual,
    createLokiFetcher: () => (call: Call) => {
      calls.push(call);
      const gen = /event_data_gen=(\d+) event_data_recording_id=(\S+) /.exec(call.expr);
      if (!gen || !holdChunks) {
        return Promise.resolve(answer(call));
      }
      return new Promise<LokiLine[]>((resolve, reject) => {
        held.set(gen[1], { release: () => resolve(answer(call)), signal: call.signal });
        call.signal?.addEventListener('abort', () => reject(actual.abortError()));
      });
    },
  };
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { linesOf } from '../lib/fixtures';
import { META_LINE_FILTER } from '../lib/replaySource';
import { useSessionData } from './useSessionData';

const MIN = 60_000;
const SESSION = 'p033owWikG';
const START = 1_800_000_000_000;
type Event = Record<string, unknown> & { timestamp: number };
const meta = (timestamp: number) => ({ type: 4, timestamp, data: { href: 'https://x/', width: 1, height: 1 } });
const snapshot = (timestamp: number) => ({
  type: 2,
  timestamp,
  data: { node: {}, initialOffset: { top: 0, left: 0 } },
});
const incremental = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, positions: [] } });

/** One recording of eight checkouts, 5 minutes apart; lines arrive in Loki 2 s after they happen. */
const lines = linesOf(
  Array.from({ length: 8 }, (_, gen) => [
    { event: meta(START + gen * 5 * MIN) as Event, gen },
    { event: snapshot(START + gen * 5 * MIN + 1) as Event, gen },
    { event: incremental(START + gen * 5 * MIN + 2 * MIN) as Event, gen },
  ]).flat(),
  2000,
  SESSION
);
const chunkGen = (call: Call) => /event_data_gen=(\d+) /.exec(call.expr)?.[1];
const chunkCalls = () => calls.filter((call) => chunkGen(call) !== undefined);

function answerFromLines(call: Call): LokiLine[] {
  const inRange = lines.filter(({ tsNs }) => {
    const ms = Number(tsNs.slice(0, -6));
    return ms >= call.fromMs && ms <= call.toMs;
  });
  if (call.expr.endsWith(META_LINE_FILTER)) {
    return inRange.filter(({ line }) => line.includes('event_data_event="{\\"type\\":4,'));
  }
  const gen = chunkGen(call);
  if (gen !== undefined) {
    return inRange.filter(({ line }) => line.includes(` event_data_gen=${gen} `));
  }
  if (call.expr.startsWith('{source="faro_replay", replay="payload"') && call.direction === 'backward') {
    return inRange.slice(-1);
  }
  return [];
}

const range = { from: START - 10 * MIN, to: START + 60 * MIN };

describe('useSessionData progressive replay', () => {
  beforeEach(() => {
    calls.length = 0;
    held.clear();
    holdChunks = false;
    answer = answerFromLines;
  });

  it('knows the whole timeline from the index, then loads the link target first', async () => {
    holdChunks = true;
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range, t: 31 * MIN })
    );

    await waitFor(() => expect(result.current.loadingReplay).toBe(false));
    const [track] = result.current.tracks;
    expect(track.endMs - track.startMs).toBe(37 * MIN);
    expect(track.chunks.map((chunk) => chunk.loaded)).toEqual(Array(8).fill(false));
    // Target gen 6, the next one, then outward; four at once.
    await waitFor(() => expect(chunkCalls().map(chunkGen)).toEqual(['6', '7', '5', '4']));

    act(() => held.get('6')!.release());
    await waitFor(() => expect(result.current.tracks[0].chunks[6].loaded).toBe(true));
    expect(chunkCalls().map(chunkGen)).toEqual(['6', '7', '5', '4', '3']);
    unmount();
  });

  it('re-prioritises on a seek, aborting what is no longer wanted, and cancels everything on unmount', async () => {
    holdChunks = true;
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range, t: 31 * MIN })
    );
    await waitFor(() => expect(chunkCalls()).toHaveLength(4));

    act(() => result.current.focus(0, 1 * MIN));

    await waitFor(() => expect(chunkCalls().map(chunkGen).slice(4)).toEqual(['0', '1', '2', '3']));
    expect(
      ['6', '7', '5', '4'].every((gen) => chunkCalls().find((call) => chunkGen(call) === gen)!.signal!.aborted)
    ).toBe(true);

    unmount();
    expect(['0', '1', '2', '3'].every((gen) => held.get(gen)!.signal!.aborted)).toBe(true);
  });

  it('loads every chunk in the end, at most four at a time', async () => {
    holdChunks = true;
    const { result } = renderHook(() => useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range }));
    await waitFor(() => expect(held.size).toBeGreaterThan(0));

    for (let round = 0; round < 8 && !result.current.tracks[0].chunks.every((chunk) => chunk.loaded); round++) {
      const waiting = [...held.entries()];
      expect(waiting.length).toBeLessThanOrEqual(4);
      held.clear();
      act(() => waiting.forEach(([, request]) => request.release()));
      await waitFor(() => expect(held.size > 0 || result.current.tracks[0].chunks.every((c) => c.loaded)).toBe(true));
    }

    expect(result.current.tracks[0].chunks.every((chunk) => chunk.loaded)).toBe(true);
    expect(result.current.tracks[0].chunks[0].events).toHaveLength(3);
    expect(chunkCalls()).toHaveLength(8);
    await waitFor(() => expect(result.current.loadingChunks).toBe(false));
  });

  it('follows live from the end of the index, while chunks still load, and starts with the newest chunk', async () => {
    holdChunks = true;
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range, live: true })
    );
    try {
      await waitFor(() => expect(result.current.loadingReplay).toBe(false));
      const lastLokiMs = Number(lines[lines.length - 1].tsNs.slice(0, -6));
      await waitFor(() =>
        expect(
          calls.some(
            (call) =>
              call.direction === 'forward' &&
              call.expr === `{source="faro_replay", replay="payload"} |= "session_id=${SESSION}"` &&
              call.fromMs === lastLokiMs
          )
        ).toBe(true)
      );
      expect(chunkGen(chunkCalls()[0])).toBe('7');
      expect(result.current.tracks[0].chunks.some((chunk) => chunk.loaded)).toBe(false);
    } finally {
      unmount();
    }
  });

  it('reads chunks and live lines on the session bucket where the index found the session', async () => {
    const { result, unmount } = renderHook(() =>
      useSessionData({
        lokiUid: 'loki',
        sessionId: SESSION,
        ...range,
        live: true,
        payloadBuckets: { count: 256, sinceMs: 0 },
      })
    );
    try {
      await waitFor(() => expect(result.current.tracks[0]?.chunks.every((chunk) => chunk.loaded)).toBe(true));
      const payload = calls.filter((call) => call.expr.startsWith('{source="faro_replay", replay="payload"'));
      expect(payload.length).toBeGreaterThan(10);
      expect(payload.every((call) => /session_bucket="\d{3}"/.test(call.expr))).toBe(true);
    } finally {
      unmount();
    }
  });
});
