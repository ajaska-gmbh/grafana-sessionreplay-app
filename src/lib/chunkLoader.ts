import { isAbortError } from './loki';

/** Chunk requests in flight at once (Grafana's backend holds every response in memory). */
export const CHUNK_CONCURRENCY = 4;
/** Chunks right after the target are loaded next, so playback runs on without waiting. */
export const CHUNKS_AHEAD = 2;
/** Further attempts of a failed chunk before it is given up (until `retry`, e.g. a seek there). */
export const CHUNK_RETRIES = 2;
/** First pause before a retry; doubled for each further one. */
const RETRY_DELAY_MS = 1000;

/** `retrying`: failed, waiting for its next attempt. `failed`: given up. */
export type ChunkStatus = 'pending' | 'loading' | 'retrying' | 'loaded' | 'failed';

export interface ChunkLoaderOptions<T> {
  /** Fetches one chunk; must reject (AbortError) when the signal aborts. */
  load: (key: string, signal: AbortSignal) => Promise<T>;
  onLoaded: (key: string, value: T) => void;
  /** A chunk failed all its attempts. */
  onFailed?: (key: string, error: unknown) => void;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Loads chunks by priority with bounded parallelism. The caller gives the
 * full order (`prioritise`); the loader keeps `concurrency` requests running
 * on the first chunks of it that are not loaded. A new order (a seek, another
 * tab) aborts requests far down it when the first ones need their slots; a
 * request still among the next few needed runs on (Loki keeps scanning a
 * cancelled query anyway). Loaded chunks are remembered and never fetched
 * again. A failing chunk is retried with growing pauses, then given up until
 * `retry` — a new order does not reset that. `dispose` aborts everything.
 */
export class ChunkLoader<T> {
  private order: string[] = [];
  private readonly status = new Map<string, ChunkStatus>();
  private readonly attempts = new Map<string, number>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: ChunkLoaderOptions<T>) {
    this.concurrency = options.concurrency ?? CHUNK_CONCURRENCY;
    this.retries = options.retries ?? CHUNK_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  statusOf(key: string): ChunkStatus {
    return this.status.get(key) ?? 'pending';
  }

  /** Keys requested right now. */
  get loading(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Nothing in flight and nothing left to load in the current order. */
  get idle(): boolean {
    return this.inFlight.size === 0 && this.timers.size === 0 && this.next() === undefined;
  }

  /** Tries a given-up chunk again, with fresh attempts (the user asked for it). */
  retry(key: string): void {
    if (this.statusOf(key) === 'failed') {
      this.status.set(key, 'pending');
      this.attempts.delete(key);
      this.pump();
    }
  }

  /** Load in this order (most wanted first); keys not listed are not loaded. */
  prioritise(order: string[]): void {
    if (this.disposed) {
      return;
    }
    this.order = order;
    const open = this.order.filter((key) => this.statusOf(key) === 'pending' || this.inFlight.has(key));
    const wanted = open.slice(0, this.concurrency);
    // Requests still among the next few needed are worth finishing.
    const kept = new Set(open.slice(0, this.concurrency * 2));
    // Free a slot for every wanted chunk that is waiting, lowest priority first.
    const waiting = wanted.filter((key) => !this.inFlight.has(key)).length;
    const free = this.concurrency - this.inFlight.size;
    if (waiting > free) {
      const unwanted = [...this.inFlight.keys()]
        .filter((key) => !kept.has(key))
        .sort((a, b) => this.rank(b) - this.rank(a))
        .slice(0, waiting - free);
      for (const key of unwanted) {
        this.inFlight.get(key)?.abort();
        this.inFlight.delete(key);
        this.status.set(key, 'pending');
      }
    }
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private rank(key: string): number {
    const index = this.order.indexOf(key);
    return index === -1 ? Infinity : index;
  }

  private next(): string | undefined {
    return this.order.find((key) => this.statusOf(key) === 'pending' && !this.inFlight.has(key));
  }

  private pump(): void {
    while (!this.disposed && this.inFlight.size < this.concurrency) {
      const key = this.next();
      if (key === undefined) {
        return;
      }
      this.start(key);
    }
  }

  private start(key: string): void {
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    this.status.set(key, 'loading');
    this.options.load(key, controller.signal).then(
      (value) => {
        if (this.inFlight.get(key) !== controller) {
          return;
        }
        this.inFlight.delete(key);
        this.status.set(key, 'loaded');
        this.options.onLoaded(key, value);
        this.pump();
      },
      (error: unknown) => {
        if (this.inFlight.get(key) !== controller) {
          // Aborted (re-prioritised or disposed): its state was set there.
          return;
        }
        this.inFlight.delete(key);
        if (isAbortError(error) || controller.signal.aborted) {
          this.status.set(key, 'pending');
          this.pump();
          return;
        }
        const attempt = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, attempt);
        if (attempt > this.retries) {
          this.status.set(key, 'failed');
          this.options.onFailed?.(key, error);
          this.pump();
          return;
        }
        // Try again after a growing pause; other chunks use the slot meanwhile.
        this.status.set(key, 'retrying');
        const timer = setTimeout(
          () => {
            this.timers.delete(timer);
            if (this.statusOf(key) === 'retrying') {
              this.status.set(key, 'pending');
            }
            this.pump();
          },
          this.retryDelayMs * 2 ** (attempt - 1)
        );
        this.timers.add(timer);
        this.pump();
      }
    );
  }
}

/**
 * Load order for a track: the target chunk's dependencies (a chunk without
 * Meta needs the one before it), the target, the next CHUNKS_AHEAD, then the
 * rest outward from the target, alternating forward and back.
 */
export function priorityOrder(
  chunks: ReadonlyArray<{ key: string; dependsOn?: string }>,
  target: number,
  ahead = CHUNKS_AHEAD
): string[] {
  if (chunks.length === 0) {
    return [];
  }
  const at = Math.max(0, Math.min(target, chunks.length - 1));
  const byKey = new Map(chunks.map((chunk) => [chunk.key, chunk]));
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  };
  const withDependencies = (index: number) => {
    const chain: string[] = [];
    let chunk: { key: string; dependsOn?: string } | undefined = chunks[index];
    while (chunk && !seen.has(chunk.key) && !chain.includes(chunk.key)) {
      chain.unshift(chunk.key);
      chunk = chunk.dependsOn ? byKey.get(chunk.dependsOn) : undefined;
    }
    chain.forEach(add);
  };

  withDependencies(at);
  for (let i = 1; i <= ahead && at + i < chunks.length; i++) {
    withDependencies(at + i);
  }
  for (let step = 1; at + ahead + step < chunks.length || at - step >= 0; step++) {
    if (at + ahead + step < chunks.length) {
      withDependencies(at + ahead + step);
    }
    if (at - step >= 0) {
      withDependencies(at - step);
    }
  }
  return order;
}
