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
import { liveRetryDelayMs, useSessionData } from './useSessionData';

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

  it('re-prioritises on a seek (requests still needed soon finish), and cancels everything on unmount', async () => {
    holdChunks = true;
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range, t: 31 * MIN })
    );
    await waitFor(() => expect(chunkCalls()).toHaveLength(4));

    act(() => result.current.focus(0, 1 * MIN));
    // All eight chunks are among the next ones needed: what runs is not thrown away.
    expect(chunkCalls().some((call) => call.signal!.aborted)).toBe(false);

    act(() => {
      held.get('6')!.release();
      held.get('7')!.release();
    });
    await waitFor(() => expect(chunkCalls().map(chunkGen).slice(4)).toEqual(['0', '1']));

    unmount();
    expect(['0', '1', '5', '4'].every((gen) => held.get(gen)!.signal!.aborted)).toBe(true);
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

  it('loads only the newest chunk while live, and the rest once live is left', async () => {
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range, live: true })
    );
    try {
      await waitFor(() => expect(result.current.tracks[0]?.chunks[7].loaded).toBe(true));
      // A few live polls later, still nothing older: it would only cost Loki scans.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(chunkCalls().map(chunkGen)).toEqual(['7']);

      // Exit live: the player asks for a position.
      act(() => result.current.focus(0, 2 * MIN, false));
      await waitFor(() => expect(result.current.tracks[0].chunks.every((chunk) => chunk.loaded)).toBe(true));
      expect(chunkGen(chunkCalls()[1])).toBe('0');
    } finally {
      unmount();
    }
  });

  it('gives a failing chunk up after its retries, says so only then, and tries again on a seek there', async () => {
    let failing = true;
    answer = (call) => {
      if (chunkGen(call) === '0' && failing) {
        throw new Error('loki timeout');
      }
      return answerFromLines(call);
    };
    const { result, unmount } = renderHook(() => useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range }));
    try {
      await waitFor(() => expect(result.current.loadingReplay).toBe(false));
      expect(result.current.tracks[0].chunks[0].failed).toBe(false);
      // Retries after 1 s and 2 s.
      await waitFor(() => expect(result.current.tracks[0].chunks[0].failed).toBe(true), { timeout: 6000 });
      expect(chunkCalls().filter((call) => chunkGen(call) === '0')).toHaveLength(3);

      failing = false;
      act(() => result.current.focus(0, 0));
      expect(result.current.tracks[0].chunks[0].failed).toBe(false);
      await waitFor(() => expect(result.current.tracks[0].chunks[0].loaded).toBe(true));
    } finally {
      unmount();
    }
  }, 15_000);

  it('retries a given-up newest chunk from live polling, which plays nothing without it', async () => {
    let failures = 0;
    answer = (call) => {
      if (chunkGen(call) === '7' && failures < 3) {
        failures++;
        throw new Error('loki timeout');
      }
      return answerFromLines(call);
    };
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, ...range, live: true })
    );
    try {
      // The loader's attempts (now, +1 s, +2 s), given up; the next live poll tries again.
      await waitFor(() => expect(result.current.tracks[0]?.chunks[7].failed).toBe(true), { timeout: 6000 });
      await waitFor(() => expect(result.current.tracks[0].chunks[7].loaded).toBe(true), { timeout: 6000 });
      expect(chunkCalls().filter((call) => chunkGen(call) === '7')).toHaveLength(4);
    } finally {
      unmount();
    }
  }, 15_000);

  it('spaces live retries of a newest chunk out: at once, then 15 s, doubling to 5 minutes', () => {
    expect([0, 1, 2, 3, 6, 20].map(liveRetryDelayMs)).toEqual([0, 15_000, 30_000, 60_000, 300_000, 300_000]);
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
      await waitFor(() => expect(result.current.tracks[0]?.chunks[7].loaded).toBe(true));
      await waitFor(() =>
        expect(calls.filter((call) => call.expr.endsWith(`"session_id=${SESSION}"`)).length).toBeGreaterThan(0)
      );
      const payload = calls.filter((call) => call.expr.startsWith('{source="faro_replay", replay="payload"'));
      expect(payload.length).toBeGreaterThan(3);
      expect(payload.every((call) => /session_bucket="\d{3}"/.test(call.expr))).toBe(true);
    } finally {
      unmount();
    }
  });
});
