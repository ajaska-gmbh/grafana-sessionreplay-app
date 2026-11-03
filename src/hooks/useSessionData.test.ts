jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { CLOCK_SLACK_MS, MAX_SESSION_MS } from '../constants';
import { SESSION_ID, startedLine } from '../lib/fixtures';
import type { LokiFetcher } from '../lib/loki';
import { findSessionAround } from './useSessionData';

describe('findSessionAround', () => {
  it('finds the session start up to the maximum session length before the link range', async () => {
    const fetcher = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>(async () => [
      { tsNs: '1', line: startedLine('2026-11-03 10:00:00.000 +0000 UTC') },
      { tsNs: '2', line: startedLine('2026-11-03 11:30:00.000 +0000 UTC', SESSION_ID, 'rec2') },
    ]);
    const link = { from: Date.UTC(2026, 10, 3, 12), to: Date.UTC(2026, 10, 3, 13) };

    const session = await findSessionAround(fetcher, SESSION_ID, link);

    expect(session?.startedMs).toBe(Date.UTC(2026, 10, 3, 10));
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        fromMs: link.from - MAX_SESSION_MS - CLOCK_SLACK_MS,
        toMs: link.to,
        expr: expect.stringContaining(SESSION_ID),
      })
    );
  });

  it('is undefined without start markers', async () => {
    expect(await findSessionAround(async () => [], SESSION_ID, { from: 0, to: 1 })).toBeUndefined();
  });
});
