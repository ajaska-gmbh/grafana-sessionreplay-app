import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { appFilter, appLineFilter, eventLineFilter, sessionLineFilter, STREAMS } from './logql';
import { createLokiFetcher, logqlString } from './loki';
import { REPLAY_STARTED_EVENT, summariseSessions, type SessionSummary } from './sessions';
import { sessionSearchQuery } from './sessionSearch';
import { furthestStep } from './insights';

/** The shop's frustration events (see journey.ts): counted per session for the list. */
export const FRUSTRATION_EVENTS = ['dead_click', 'rage_click', 'error_click', 'form_invalid'] as const;

interface MetricFrame {
  schema?: { fields?: Array<{ name: string; labels?: Record<string, string> }> };
  data?: { values?: unknown[][] };
}

/** Run an instant LogQL metric query; returns one entry per series (labels + last value). */
async function instantSeries(
  lokiUid: string,
  expr: string,
  fromMs: number,
  toMs: number
): Promise<Array<{ labels: Record<string, string>; value: number }>> {
  const response = await lastValueFrom(
    getBackendSrv().fetch<{ results?: Record<string, { frames?: MetricFrame[]; error?: string }> }>({
      url: '/api/ds/query',
      method: 'POST',
      data: {
        from: String(Math.floor(fromMs)),
        to: String(Math.ceil(toMs)),
        queries: [{ refId: 'A', datasource: { uid: lokiUid, type: 'loki' }, expr, queryType: 'instant' }],
      },
      showErrorAlert: false,
    })
  );

  const series: Array<{ labels: Record<string, string>; value: number }> = [];
  for (const result of Object.values(response.data.results ?? {})) {
    if (result.error) {
      throw new Error(result.error);
    }
    for (const frame of result.frames ?? []) {
      const fields = frame.schema?.fields ?? [];
      const valueIndex = fields.findIndex((field) => field.labels !== undefined);
      if (valueIndex === -1) {
        continue;
      }
      const values = frame.data?.values?.[valueIndex] ?? [];
      series.push({ labels: fields[valueIndex].labels ?? {}, value: Number(values[values.length - 1] ?? 0) });
    }
  }
  return series;
}

/** Range of a LogQL range vector covering [fromMs, toMs]. */
function rangeSeconds(fromMs: number, toMs: number): number {
  return Math.max(60, Math.ceil((toMs - fromMs) / 1000));
}

/** Apps with recorded sessions in the range (from the markers' structured metadata). */
export async function fetchAppNames(lokiUid: string, fromMs: number, toMs: number): Promise<string[]> {
  const expr = `sum by (app_name) (count_over_time(${STREAMS.markers} [${rangeSeconds(fromMs, toMs)}s]))`;
  const series = await instantSeries(lokiUid, expr, fromMs, toMs);
  return [...new Set(series.map((entry) => entry.labels.app_name).filter(Boolean))].sort();
}

/**
 * Sessions with a replay recording in the range, newest first; optionally only
 * one session. `truncated` means the marker limit was hit: older sessions in
 * the range are missing and the oldest ones listed may start earlier.
 */
export async function fetchSessions(
  lokiUid: string,
  apps: string[],
  fromMs: number,
  toMs: number,
  limit = 5000,
  sessionId?: string
): Promise<{ sessions: SessionSummary[]; truncated: boolean }> {
  const fetcher = createLokiFetcher(lokiUid);
  const expr =
    STREAMS.markers +
    appFilter(apps) +
    eventLineFilter(REPLAY_STARTED_EVENT) +
    (sessionId ? sessionLineFilter(sessionId) : '');
  const lines = await fetcher({ expr, fromMs, toMs, limit, direction: 'backward' });
  return { sessions: summariseSessions(lines), truncated: lines.length >= limit };
}

/** Exceptions per session in the range: `session_id -> count`. */
export async function fetchErrorCounts(
  lokiUid: string,
  apps: string[],
  fromMs: number,
  toMs: number
): Promise<Map<string, number>> {
  const expr = `sum by (session_id) (count_over_time(${STREAMS.faro}${appLineFilter(apps)}${appFilter(apps)} |= "kind=exception" | logfmt session_id [${rangeSeconds(fromMs, toMs)}s]))`;
  const counts = new Map<string, number>();
  for (const { labels, value } of await instantSeries(lokiUid, expr, fromMs, toMs)) {
    if (labels.session_id) {
      counts.set(labels.session_id, (counts.get(labels.session_id) ?? 0) + value);
    }
  }
  return counts;
}

/** Frustration events (dead, rage, error taps, form errors) per session in the range. */
export async function fetchFrustrationCounts(
  lokiUid: string,
  apps: string[],
  fromMs: number,
  toMs: number
): Promise<Map<string, number>> {
  const names = logqlString(`event_name=(?:${FRUSTRATION_EVENTS.join('|')})( |$)`);
  const expr = `sum by (session_id) (count_over_time(${STREAMS.faro}${appLineFilter(apps)}${appFilter(apps)} |~ ${names} | logfmt session_id [${rangeSeconds(fromMs, toMs)}s]))`;
  const counts = new Map<string, number>();
  for (const { labels, value } of await instantSeries(lokiUid, expr, fromMs, toMs)) {
    if (labels.session_id) {
      counts.set(labels.session_id, (counts.get(labels.session_id) ?? 0) + value);
    }
  }
  return counts;
}

/**
 * The furthest funnel step per session (`session_attr_outcome`, which LP Shop
 * puts on every signal of a visit): `session_id -> step`.
 */
export async function fetchOutcomes(
  lokiUid: string,
  apps: string[],
  fromMs: number,
  toMs: number
): Promise<Map<string, string>> {
  const expr = `sum by (session_id, session_attr_outcome) (count_over_time(${STREAMS.faro}${appLineFilter(apps)}${appFilter(apps)} |= "session_attr_outcome=" | logfmt session_id, session_attr_outcome [${rangeSeconds(fromMs, toMs)}s]))`;
  const steps = new Map<string, string[]>();
  for (const { labels } of await instantSeries(lokiUid, expr, fromMs, toMs)) {
    if (labels.session_id && labels.session_attr_outcome) {
      steps.set(labels.session_id, [...(steps.get(labels.session_id) ?? []), labels.session_attr_outcome]);
    }
  }
  return new Map([...steps].map(([id, reached]) => [id, furthestStep(reached)!]));
}

/** Sessions whose recording received data in the last `windowMs` (epoch ms "now" given). */
export async function fetchActiveSessionIds(
  lokiUid: string,
  apps: string[],
  nowMs: number,
  windowMs: number
): Promise<Set<string>> {
  const expr = `sum by (session_id) (count_over_time(${STREAMS.payloads}${appLineFilter(apps)}${appFilter(apps)} | logfmt session_id [${Math.ceil(windowMs / 1000)}s]))`;
  const series = await instantSeries(lokiUid, expr, nowMs - windowMs, nowMs);
  return new Set(
    series
      .filter((entry) => entry.value > 0)
      .map((entry) => entry.labels.session_id)
      .filter(Boolean)
  );
}

/** Sessions with an event whose search field is exactly `value` (see sessionSearchQuery). */
export async function fetchMatchingSessionIds(
  lokiUid: string,
  fields: string[],
  value: string,
  apps: string[],
  fromMs: number,
  toMs: number
): Promise<Set<string>> {
  if (fields.length === 0) {
    return new Set();
  }
  const series = await instantSeries(
    lokiUid,
    sessionSearchQuery(fields, value, apps, rangeSeconds(fromMs, toMs)),
    fromMs,
    toMs
  );
  return new Set(
    series
      .filter((entry) => entry.value > 0)
      .map((entry) => entry.labels.session_id)
      .filter(Boolean)
  );
}

/**
 * One agent's sessions in the range: the markers of the app with the user's
 * id on the line (`user_id` compared exactly once parsed).
 */
export async function fetchUserSessions(
  lokiUid: string,
  appName: string,
  userId: string,
  fromMs: number,
  toMs: number
): Promise<SessionSummary[]> {
  const fetcher = createLokiFetcher(lokiUid);
  const expr =
    STREAMS.markers +
    appFilter([appName]) +
    eventLineFilter(REPLAY_STARTED_EVENT) +
    ` |= ${logqlString(` user_id=${userId} `)}`;
  const lines = await fetcher({ expr, fromMs, toMs, limit: 5000, direction: 'backward' });
  return summariseSessions(lines).filter((session) => session.userId === userId && session.appName === appName);
}
