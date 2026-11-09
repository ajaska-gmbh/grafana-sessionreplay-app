import { getBackendSrv } from '@grafana/runtime';
import { LOKI_PAGE_SIZE } from '../constants';
import type { LokiLine } from '../types';

interface FrameField {
  name: string;
}

interface Frame {
  schema?: { fields?: FrameField[] };
  data?: { values?: unknown[][] };
}

interface DsQueryResponse {
  results?: Record<string, { frames?: Frame[]; error?: string }>;
}

export type Direction = 'forward' | 'backward';

/** Fetches one page of Loki log lines; injectable for tests. */
export type LokiFetcher = (args: {
  expr: string;
  fromMs: number;
  toMs: number;
  limit: number;
  direction: Direction;
  /** Aborting cancels the request in flight (the promise rejects with an AbortError). */
  signal?: AbortSignal;
}) => Promise<LokiLine[]>;

/** The error an aborted request or read rejects with. */
export function abortError(): Error {
  const error = new Error('The request was cancelled');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError';
}

let requestCounter = 0;

/**
 * Quote a value for a LogQL string literal (line filters and matchers).
 */
export function logqlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Extract log lines from a Grafana data frame response. Loki frames carry the
 * line in `Line` (or `body` with the dataplane format) and the nanosecond
 * timestamp in `tsNs` (or derived from `Time`/`timestamp` in ms).
 */
export function framesToLines(response: DsQueryResponse): LokiLine[] {
  const lines: LokiLine[] = [];

  for (const result of Object.values(response.results ?? {})) {
    if (result.error) {
      throw new Error(result.error);
    }
    for (const frame of result.frames ?? []) {
      const fields = frame.schema?.fields ?? [];
      const values = frame.data?.values ?? [];
      const index = (...names: string[]) => fields.findIndex((field) => names.includes(field.name));

      const lineIdx = index('Line', 'body');
      if (lineIdx === -1) {
        continue;
      }
      const nsIdx = index('tsNs');
      const timeIdx = index('Time', 'timestamp');
      const lineValues = values[lineIdx] ?? [];

      for (let row = 0; row < lineValues.length; row++) {
        const tsNs =
          nsIdx !== -1 ? String(values[nsIdx]?.[row]) : `${Math.round(Number(values[timeIdx]?.[row] ?? 0))}000000`;
        lines.push({ tsNs, line: String(lineValues[row]) });
      }
    }
  }

  return lines;
}

/**
 * Fetcher that runs LogQL through Grafana's /api/ds/query (respects datasource
 * access). Every request has its own requestId, so Grafana never cancels one
 * request for another; aborting `signal` unsubscribes, which cancels the HTTP
 * request.
 */
export function createLokiFetcher(datasourceUid: string): LokiFetcher {
  return ({ expr, fromMs, toMs, limit, direction, signal }) =>
    new Promise<LokiLine[]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      let response: DsQueryResponse | undefined;
      const onAbort = () => {
        subscription.unsubscribe();
        reject(abortError());
      };
      const subscription = getBackendSrv()
        .fetch<DsQueryResponse>({
          url: '/api/ds/query',
          method: 'POST',
          requestId: `sessionreplay-${++requestCounter}`,
          data: {
            from: String(Math.floor(fromMs)),
            to: String(Math.ceil(toMs)),
            queries: [
              {
                refId: 'A',
                datasource: { uid: datasourceUid, type: 'loki' },
                expr,
                queryType: 'range',
                maxLines: limit,
                direction,
              },
            ],
          },
          showErrorAlert: false,
        })
        .subscribe({
          next: (value) => {
            response = value.data;
          },
          error: (error: unknown) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
          complete: () => {
            signal?.removeEventListener('abort', onAbort);
            try {
              resolve(framesToLines(response ?? {}));
            } catch (error) {
              reject(error);
            }
          },
        });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Compare two nanosecond timestamps given as decimal strings. */
export function compareNs(a: string, b: string): number {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read all lines of a query in time order, page by page. Each next page
 * starts at the last timestamp of the previous one (Loki's start is
 * inclusive), and lines already seen at that exact nanosecond are skipped,
 * so large sessions load without gaps or duplicates.
 */
export async function* readForward(
  fetcher: LokiFetcher,
  expr: string,
  fromMs: number,
  toMs: number,
  pageSize = LOKI_PAGE_SIZE,
  signal?: AbortSignal
): AsyncGenerator<LokiLine[]> {
  let startMs = fromMs;
  let boundaryNs: string | undefined;
  let seenAtBoundary = new Set<string>();

  for (;;) {
    if (signal?.aborted) {
      throw abortError();
    }
    const page = await fetcher({ expr, fromMs: startMs, toMs, limit: pageSize, direction: 'forward', signal });
    page.sort((a, b) => compareNs(a.tsNs, b.tsNs));

    // The next page restarts at the boundary's millisecond, so it repeats
    // everything earlier in that millisecond: keep only lines after the
    // boundary, or at it but not yet seen.
    const fresh = page.filter((entry) => {
      if (boundaryNs === undefined) {
        return true;
      }
      const order = compareNs(entry.tsNs, boundaryNs);
      return order > 0 || (order === 0 && !seenAtBoundary.has(entry.line));
    });
    if (fresh.length > 0) {
      yield fresh;
    }

    if (page.length < pageSize) {
      return;
    }

    const lastNs = page[page.length - 1].tsNs;
    const atLast = page.filter((entry) => entry.tsNs === lastNs).map((entry) => entry.line);
    if (fresh.length === 0) {
      // A full page of lines sharing one timestamp: we cannot page past it.
      return;
    }
    seenAtBoundary = lastNs === boundaryNs ? new Set([...seenAtBoundary, ...atLast]) : new Set(atLast);
    boundaryNs = lastNs;
    // Loki takes ms here; flooring keeps the boundary nanosecond inside the next page.
    startMs = Math.floor(Number(lastNs.slice(0, -6)));
  }
}
