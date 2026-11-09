jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

const queries: string[] = [];
/** What the bucketed payload query answers (the whole-stream one answers nothing). */
let bucketAnswers: Array<{ tsNs: string; line: string }> = [];

jest.mock('../lib/loki', () => {
  const actual = jest.requireActual('../lib/loki');
  return {
    ...actual,
    createLokiFetcher:
      () =>
      async ({ expr }: { expr: string }) => {
        queries.push(expr);
        return expr.includes('session_bucket=') ? bucketAnswers : [];
      },
  };
});

import { renderHook, waitFor } from '@testing-library/react';
import { replayLine } from '../lib/fixtures';
import { useSessionData } from './useSessionData';

const SESSION = 'XNtXWqeUtk';
const BUCKETED = '{source="faro_replay", replay="payload", session_bucket="212"}';
const WHOLE = '{source="faro_replay", replay="payload"}';
const isPayloadQuery = (expr: string) => expr.startsWith('{source="faro_replay", replay="payload"');
const buckets = { count: 256, sinceMs: 1_000 };

describe('useSessionData payload buckets', () => {
  beforeEach(() => {
    queries.length = 0;
    bucketAnswers = [];
  });

  it('reads a session from after the switch through its own bucket only', async () => {
    bucketAnswers = [
      {
        tsNs: '1500000000000',
        line: replayLine(
          { type: 4, data: { href: 'x', width: 1, height: 1 }, timestamp: 1_500 },
          { sessionId: SESSION }
        ),
      },
    ];
    const { result } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, from: 1_000_000, to: 2_000_000, payloadBuckets: buckets })
    );

    await waitFor(() => expect(result.current.loadingReplay).toBe(false));
    const payloadQueries = queries.filter(isPayloadQuery);
    expect(payloadQueries.length).toBeGreaterThan(0);
    expect(payloadQueries.every((expr) => expr.startsWith(BUCKETED))).toBe(true);
  });

  it('reads the whole stream for a session from before the switch, or without the setting', async () => {
    const before = renderHook(() =>
      useSessionData({
        lokiUid: 'loki',
        sessionId: SESSION,
        from: 0,
        to: 500,
        payloadBuckets: { count: 256, sinceMs: 10_000_000 },
      })
    );
    await waitFor(() => expect(before.result.current.loadingReplay).toBe(false));
    const unset = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, from: 1_000_000, to: 2_000_000 })
    );
    await waitFor(() => expect(unset.result.current.loadingReplay).toBe(false));

    expect(queries.filter(isPayloadQuery).every((expr) => expr.startsWith(`${WHOLE} `))).toBe(true);
  });

  it('falls back to the whole stream when the bucket holds nothing of the session', async () => {
    const { result } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, from: 1_000_000, to: 2_000_000, payloadBuckets: buckets })
    );

    await waitFor(() => expect(result.current.loadingReplay).toBe(false));
    const payloadQueries = queries.filter(isPayloadQuery);
    expect(payloadQueries[0].startsWith(BUCKETED)).toBe(true);
    expect(payloadQueries.some((expr) => expr.startsWith(`${WHOLE} `))).toBe(true);
  });
});
