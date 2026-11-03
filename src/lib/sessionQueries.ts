import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { FARO_SOURCE } from '../constants';
import { createLokiFetcher, logqlString } from './loki';
import { REPLAY_STARTED_EVENT, summariseSessions, type SessionSummary } from './sessions';

/** Escape a value for use inside a LogQL/RE2 regex alternative. */
function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `{source="faro", app_name=~"a|b"}`, or any app when none is selected. */
export function faroSelector(apps: string[]): string {
  const appMatcher = apps.length > 0 ? apps.map(regexEscape).join('|') : '.+';
  return `{source=${logqlString(FARO_SOURCE)}, app_name=~${logqlString(appMatcher)}}`;
}

/** App names that sent Faro data in the range (Loki label values). */
export async function fetchAppNames(lokiUid: string, fromMs: number, toMs: number): Promise<string[]> {
  const response = await getBackendSrv().get<{ data?: string[] }>(
    `/api/datasources/uid/${lokiUid}/resources/label/app_name/values`,
    { query: `{source=${logqlString(FARO_SOURCE)}}`, start: `${fromMs}000000`, end: `${toMs}000000` },
    undefined,
    { showErrorAlert: false }
  );
  return [...(response.data ?? [])].sort();
}

/** Sessions with a replay recording in the range, newest first; optionally only one session. */
export async function fetchSessions(
  lokiUid: string,
  apps: string[],
  fromMs: number,
  toMs: number,
  limit = 5000,
  sessionId?: string
): Promise<SessionSummary[]> {
  const fetcher = createLokiFetcher(lokiUid);
  const sessionFilter = sessionId ? ` |= ${logqlString(`session_id=${sessionId}`)}` : '';
  const expr = `${faroSelector(apps)} |= ${logqlString(`event_name=${REPLAY_STARTED_EVENT}`)}${sessionFilter}`;
  const lines = await fetcher({ expr, fromMs, toMs, limit, direction: 'backward' });
  return summariseSessions(lines);
}

interface MetricFrame {
  schema?: { fields?: Array<{ name: string; labels?: Record<string, string> }> };
  data?: { values?: unknown[][] };
}

/** Exceptions per session in the range: `session_id -> count`. */
export async function fetchErrorCounts(
  lokiUid: string,
  apps: string[],
  fromMs: number,
  toMs: number
): Promise<Map<string, number>> {
  const rangeSeconds = Math.max(60, Math.ceil((toMs - fromMs) / 1000));
  const expr = `sum by (session_id) (count_over_time(${faroSelector(apps)} |= "kind=exception" | logfmt session_id [${rangeSeconds}s]))`;
  const response = await lastValueFrom(
    getBackendSrv().fetch<{ results?: Record<string, { frames?: MetricFrame[] }> }>({
      url: '/api/ds/query',
      method: 'POST',
      data: {
        from: String(fromMs),
        to: String(toMs),
        queries: [{ refId: 'A', datasource: { uid: lokiUid, type: 'loki' }, expr, queryType: 'instant' }],
      },
      showErrorAlert: false,
    })
  );

  const counts = new Map<string, number>();
  for (const result of Object.values(response.data.results ?? {})) {
    for (const frame of result.frames ?? []) {
      const fields = frame.schema?.fields ?? [];
      const valueIndex = fields.findIndex((field) => field.labels?.session_id);
      if (valueIndex === -1) {
        continue;
      }
      const sessionId = fields[valueIndex].labels!.session_id;
      const values = frame.data?.values?.[valueIndex] ?? [];
      const count = Number(values[values.length - 1] ?? 0);
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + count);
    }
  }
  return counts;
}
