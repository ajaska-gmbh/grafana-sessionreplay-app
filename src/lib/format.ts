import { PLUGIN_BASE_URL, ROUTES } from '../constants';

/** `m:ss` (or `h:mm:ss`) for player times. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** `m:ss.mmm` offset from the recording start, as in the user journey. */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(Math.round(ms));
  return `${sign}${formatClock(abs)}.${String(abs % 1000).padStart(3, '0')}`;
}

/** Full-screen viewer URL, same shape as Grafana's: /app/<app>/session/<id>?t=<ms>. */
export function replayUrl(
  appName: string,
  sessionId: string,
  options: { t?: number; from?: number; to?: number; track?: number } = {}
): string {
  const params = new URLSearchParams();
  if (options.t !== undefined && options.t > 0) {
    params.set('t', String(Math.round(options.t)));
  }
  if (options.track !== undefined && options.track > 0) {
    params.set('track', String(options.track));
  }
  if (options.from !== undefined) {
    params.set('from', String(Math.floor(options.from)));
  }
  if (options.to !== undefined) {
    params.set('to', String(Math.ceil(options.to)));
  }
  const query = params.toString();
  return `${PLUGIN_BASE_URL}/${ROUTES.App}/${encodeURIComponent(appName)}/session/${encodeURIComponent(sessionId)}${
    query ? `?${query}` : ''
  }`;
}

/** Explore link that opens one trace in the configured Tempo datasource. */
export function traceExploreUrl(tempoUid: string, traceId: string, aroundMs: number): string {
  const panes = {
    trace: {
      datasource: tempoUid,
      queries: [{ refId: 'A', datasource: { uid: tempoUid, type: 'tempo' }, queryType: 'traceql', query: traceId }],
      range: { from: String(aroundMs - 30 * 60 * 1000), to: String(aroundMs + 30 * 60 * 1000) },
    },
  };
  return `/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}
