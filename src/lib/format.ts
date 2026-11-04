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

/** `hh:mm:ss` of an epoch time, in the viewer's local time zone (24 h). */
export function formatWallClock(epochMs: number): string {
  const date = new Date(epochMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * The offset of a wall-clock time typed as `h:mm` or `h:mm:ss` (local time)
 * within a recording, or undefined if it is not a time or not inside the
 * recording. The recording's own day is tried first, then the day after and
 * before, so recordings across midnight work.
 */
export function wallClockOffset(text: string, startMs: number, totalMs: number): number | undefined {
  const match = text.trim().match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/);
  if (!match) {
    return undefined;
  }
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return undefined;
  }
  const day = new Date(startMs);
  day.setHours(hours, minutes, seconds, 0);
  for (const shift of [0, DAY_MS, -DAY_MS]) {
    const offset = day.getTime() + shift - startMs;
    // A time typed to the second may sit up to a second before the recording's first event.
    if (offset > -1000 && offset <= totalMs) {
      return Math.max(0, offset);
    }
  }
  return undefined;
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
  options: { t?: number; from?: number; to?: number; track?: number; live?: boolean } = {}
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
  if (options.live) {
    params.set('live', '1');
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
