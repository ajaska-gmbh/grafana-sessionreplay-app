jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { ChunkLoader, priorityOrder } from './chunkLoader';
import { abortError } from './loki';

/** A load whose requests the test settles by hand. */
function controlledLoad() {
  const requests = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: unknown) => void; signal: AbortSignal }
  >();
  const started: string[] = [];
  const load = (key: string, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      started.push(key);
      requests.set(key, { resolve, reject, signal });
      signal.addEventListener('abort', () => reject(abortError()));
    });
  return { load, requests, started };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const keys = (count: number) => Array.from({ length: count }, (_, i) => `c${i}`);

describe('ChunkLoader', () => {
  it('runs at most four requests, in priority order, and the next as each finishes', async () => {
    const { load, requests, started } = controlledLoad();
    const loaded: string[] = [];
    const loader = new ChunkLoader({ load, onLoaded: (key) => loaded.push(key) });

    loader.prioritise(['c5', 'c6', 'c7', 'c4', 'c8', 'c3']);
    expect(started).toEqual(['c5', 'c6', 'c7', 'c4']);

    requests.get('c6')!.resolve('six');
    await flush();

    expect(loaded).toEqual(['c6']);
    expect(started).toEqual(['c5', 'c6', 'c7', 'c4', 'c8']);
    expect(loader.loading.sort()).toEqual(['c4', 'c5', 'c7', 'c8']);
    expect(loader.idle).toBe(false);
  });

  it('frees a slot at once for a new target, aborting the least wanted request', async () => {
    const { load, requests, started } = controlledLoad();
    const loader = new ChunkLoader({ load, onLoaded: () => undefined });
    loader.prioritise(keys(10));

    // A seek far away: c9 first, then the requests that run still matter.
    loader.prioritise(['c9', 'c0', 'c1', 'c2', 'c3']);
    await flush();

    expect(requests.get('c3')!.signal.aborted).toBe(true);
    expect(['c0', 'c1', 'c2'].every((key) => !requests.get(key)!.signal.aborted)).toBe(true);
    expect(loader.loading.sort()).toEqual(['c0', 'c1', 'c2', 'c9']);
    expect(started[started.length - 1]).toBe('c9');
    expect(loader.statusOf('c3')).toBe('pending');
  });

  it('never fetches a loaded chunk again, and loads nothing outside the order', async () => {
    const { load, requests, started } = controlledLoad();
    const loader = new ChunkLoader({ load, onLoaded: () => undefined });

    loader.prioritise(['a']);
    requests.get('a')!.resolve('A');
    await flush();
    loader.prioritise(['a', 'b']);

    expect(started).toEqual(['a', 'b']);
    expect(loader.statusOf('a')).toBe('loaded');
  });

  it('cancels everything on dispose, and reports nothing afterwards', async () => {
    const { load, requests } = controlledLoad();
    const onLoaded = jest.fn();
    const loader = new ChunkLoader({ load, onLoaded });
    loader.prioritise(keys(6));

    loader.dispose();
    loader.prioritise(['c5']);
    await flush();

    expect([...requests.values()].every((request) => request.signal.aborted)).toBe(true);
    expect(requests.size).toBe(4);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('retries a failing chunk, then gives it up until it is asked for again', async () => {
    let attempts = 0;
    const onFailed = jest.fn();
    const loader = new ChunkLoader({
      load: async () => {
        attempts++;
        throw new Error('loki timeout');
      },
      onLoaded: () => undefined,
      onFailed,
      retries: 2,
      retryDelayMs: 1,
    });

    loader.prioritise(['x']);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(attempts).toBe(3);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(loader.statusOf('x')).toBe('failed');
    expect(loader.idle).toBe(true);

    loader.prioritise(['x']);
    await flush();
    expect(attempts).toBe(4);
  });
});

describe('priorityOrder', () => {
  const chunks = keys(10).map((key) => ({ key }));

  it('loads the target, the next two, then outward from it', () => {
    expect(priorityOrder(chunks, 4)).toEqual(['c4', 'c5', 'c6', 'c7', 'c3', 'c8', 'c2', 'c9', 'c1', 'c0']);
    expect(priorityOrder(chunks, 0)).toEqual(keys(10));
    expect(priorityOrder(chunks, 9)).toEqual(['c9', 'c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0']);
  });

  it('puts what a chunk without Meta depends on before it', () => {
    const withGap = chunks.map((chunk) =>
      chunk.key === 'c5' ? { ...chunk, dependsOn: 'c4' } : chunk.key === 'c4' ? { ...chunk, dependsOn: 'c3' } : chunk
    );

    expect(priorityOrder(withGap, 5).slice(0, 5)).toEqual(['c3', 'c4', 'c5', 'c6', 'c7']);
  });

  it('clamps the target and is empty without chunks', () => {
    expect(priorityOrder(chunks, Infinity)[0]).toBe('c9');
    expect(priorityOrder(chunks, -3)[0]).toBe('c0');
    expect(priorityOrder([], 0)).toEqual([]);
  });
});
