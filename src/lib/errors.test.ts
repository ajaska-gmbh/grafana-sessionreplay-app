jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { errorText, isTransient } from './errors';
import { abortError, withRetries, type LokiFetcher } from './loki';

describe('errorText', () => {
  it('never says [object Object]', () => {
    expect(
      errorText({
        status: 500,
        statusText: 'Internal Server Error',
        data: { message: 'too many outstanding requests' },
      })
    ).toBe('too many outstanding requests (500 Internal Server Error)');
    expect(errorText({ status: 400, data: { error: 'parse error at line 1' } })).toBe('parse error at line 1 (400)');
    expect(errorText({ status: 502, statusText: 'Bad Gateway', data: '<html><body>502</body></html>' })).toBe(
      '502 Bad Gateway'
    );
    expect(errorText({ status: 504, data: 'upstream timed out' })).toBe('upstream timed out (504)');
    expect(errorText({ status: -1, data: {} })).toBe(
      'The request did not reach Grafana (network error or Grafana restarting)'
    );
    expect(errorText({ status: 0 })).toBe('The request did not reach Grafana (network error or Grafana restarting)');
    expect(errorText({ data: { message: 'only a message' } })).toBe('only a message');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText({ weird: true })).toBe('{"weird":true}');
    expect(errorText({})).toBe('Unknown error');
    expect(errorText('plain')).toBe('plain');
    expect(errorText('')).toBe('Unknown error');
    expect(errorText(undefined)).toBe('Unknown error');
    expect(errorText(null)).toBe('Unknown error');
    expect(errorText(42)).toBe('42');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorText(circular)).toBe('Unknown error');
    expect(errorText('x'.repeat(400))).toHaveLength(300);
  });

  it('knows which failures are worth a retry', () => {
    for (const status of [0, -1, 429, 502, 503, 504]) {
      expect(isTransient({ status })).toBe(true);
    }
    for (const error of [{ status: 400 }, { status: 500 }, new Error('x'), null, 'x']) {
      expect(isTransient(error)).toBe(false);
    }
  });
});

describe('withRetries', () => {
  const args = { expr: '{}', fromMs: 0, toMs: 1, limit: 1, direction: 'forward' as const };

  it('tries a transient failure again, then gives up', async () => {
    const fetcher = jest
      .fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>()
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValueOnce([{ tsNs: '1', line: 'a' }]);
    await expect(withRetries(fetcher, [1, 1])(args)).resolves.toEqual([{ tsNs: '1', line: 'a' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const failing = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>().mockRejectedValue({ status: 503 });
    await expect(withRetries(failing, [1, 1])(args)).rejects.toEqual({ status: 503 });
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it('does not retry real errors or cancelled requests', async () => {
    const bad = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>().mockRejectedValue({ status: 400 });
    await expect(withRetries(bad, [1])(args)).rejects.toEqual({ status: 400 });
    expect(bad).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const transient = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>().mockImplementation(async () => {
      controller.abort();
      throw { status: 502 };
    });
    await expect(withRetries(transient, [1])({ ...args, signal: controller.signal })).rejects.toEqual({ status: 502 });
    expect(transient).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the request is cancelled during the pause', async () => {
    const controller = new AbortController();
    const fetcher = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>().mockRejectedValue({ status: 504 });
    const result = withRetries(fetcher, [10_000])({ ...args, signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toEqual(abortError());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
