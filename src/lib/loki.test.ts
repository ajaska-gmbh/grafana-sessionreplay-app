jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { Observable, of } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { compareNs, createLokiFetcher, framesToLines, logqlString, readForward, type LokiFetcher } from './loki';
import type { LokiLine } from '../types';

describe('framesToLines', () => {
  it('reads Line and tsNs from Loki frames', () => {
    const lines = framesToLines({
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [{ name: 'labels' }, { name: 'Time' }, { name: 'Line' }, { name: 'tsNs' }, { name: 'id' }],
              },
              data: {
                values: [
                  [{}, {}],
                  [1, 2],
                  ['a', 'b'],
                  ['1000000001', '2000000002'],
                  ['x', 'y'],
                ],
              },
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      { tsNs: '1000000001', line: 'a' },
      { tsNs: '2000000002', line: 'b' },
    ]);
  });

  it('supports the dataplane format (body/timestamp)', () => {
    const lines = framesToLines({
      results: {
        A: {
          frames: [
            { schema: { fields: [{ name: 'timestamp' }, { name: 'body' }] }, data: { values: [[1700], ['x']] } },
          ],
        },
      },
    });

    expect(lines).toEqual([{ tsNs: '1700000000', line: 'x' }]);
  });

  it('throws query errors', () => {
    expect(() => framesToLines({ results: { A: { error: 'parse error' } } })).toThrow('parse error');
  });
});

describe('compareNs', () => {
  it('orders decimal nanosecond strings numerically', () => {
    expect(compareNs('999', '1000')).toBeLessThan(0);
    expect(compareNs('1793708142737900353', '1793708142737880933')).toBeGreaterThan(0);
    expect(compareNs('5', '5')).toBe(0);
  });
});

describe('logqlString', () => {
  it('quotes and escapes', () => {
    expect(logqlString('session_id="x"\\')).toBe('"session_id=\\"x\\"\\\\"');
  });
});

/** In-memory Loki: forward queries with an inclusive start in ms. */
function fakeLoki(all: LokiLine[]): { fetcher: LokiFetcher; calls: number[] } {
  const calls: number[] = [];
  const fetcher: LokiFetcher = async ({ fromMs, toMs, limit }) => {
    calls.push(fromMs);
    return all
      .filter((entry) => Number(entry.tsNs) >= fromMs * 1e6 && Number(entry.tsNs) < toMs * 1e6)
      .sort((a, b) => compareNs(a.tsNs, b.tsNs))
      .slice(0, limit);
  };
  return { fetcher, calls };
}

async function collect(generator: AsyncGenerator<LokiLine[]>): Promise<LokiLine[]> {
  const out: LokiLine[] = [];
  for await (const page of generator) {
    out.push(...page);
  }
  return out;
}

describe('readForward', () => {
  it('pages through all lines without gaps or duplicates', async () => {
    // 25 lines, several within the same millisecond and some sharing a nanosecond.
    const all: LokiLine[] = [];
    for (let i = 0; i < 25; i++) {
      const ms = 1000 + Math.floor(i / 3);
      const ns = i % 5 === 4 ? `${ms}000000` : `${ms}000${String(i).padStart(3, '0')}`;
      all.push({ tsNs: ns, line: `line-${i}` });
    }
    const { fetcher, calls } = fakeLoki(all);

    const lines = await collect(readForward(fetcher, '{x="y"}', 1000, 2000, 4));

    expect(lines.map((entry) => entry.line).sort()).toEqual(all.map((entry) => entry.line).sort());
    expect(new Set(lines.map((entry) => entry.line)).size).toBe(all.length);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('stops when a full page shares one timestamp', async () => {
    const all = Array.from({ length: 10 }, (_, i) => ({ tsNs: '1500000000', line: `same-${i}` }));
    const { fetcher } = fakeLoki(all);

    const lines = await collect(readForward(fetcher, '{x="y"}', 1000, 2000, 4));

    expect(lines).toHaveLength(4);
  });
});

describe('createLokiFetcher', () => {
  const args = { expr: '{a="b"}', fromMs: 1, toMs: 2, limit: 10, direction: 'forward' as const };
  const frame = {
    results: {
      A: { frames: [{ schema: { fields: [{ name: 'Line' }, { name: 'tsNs' }] }, data: { values: [['x'], ['5']] } }] },
    },
  };

  it('gives every request its own requestId, so Grafana never cancels one for another', async () => {
    const fetch = jest.fn(() => of({ data: frame }));
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const fetcher = createLokiFetcher('loki');

    expect(await fetcher(args)).toEqual([{ tsNs: '5', line: 'x' }]);
    await fetcher(args);

    const ids = (fetch.mock.calls as unknown as Array<[{ requestId: string }]>).map(([request]) => request.requestId);
    expect(new Set(ids).size).toBe(2);
  });

  it('cancels the HTTP request when aborted', async () => {
    let unsubscribed = false;
    const fetch = jest.fn(
      () =>
        new Observable(() => () => {
          unsubscribed = true;
        })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const abort = new AbortController();

    const pending = createLokiFetcher('loki')({ ...args, signal: abort.signal });
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(unsubscribed).toBe(true);
  });

  it('does not start an aborted request', async () => {
    const fetch = jest.fn();
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const abort = new AbortController();
    abort.abort();

    await expect(createLokiFetcher('loki')({ ...args, signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('readForward cancellation', () => {
  it('stops between pages once aborted, and passes the signal to every request', async () => {
    const abort = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const fetcher: LokiFetcher = async ({ fromMs, signal }) => {
      signals.push(signal);
      return [
        { tsNs: `${fromMs + 1}000000`, line: 'a' },
        { tsNs: `${fromMs + 2}000000`, line: 'b' },
      ];
    };
    const pages: number[] = [];

    await expect(
      (async () => {
        for await (const page of readForward(fetcher, 'x', 0, 100, 2, abort.signal)) {
          pages.push(page.length);
          abort.abort();
        }
      })()
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(pages).toEqual([2]);
    expect(signals).toEqual([abort.signal]);
  });
});
