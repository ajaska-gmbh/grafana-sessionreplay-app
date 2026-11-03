import { faroTimeMs } from './journey';
import { parseLogfmt } from './logfmt';

export const REPLAY_STARTED_EVENT = 'faro.session_recording.started';

export interface SessionSummary {
  sessionId: string;
  appName: string;
  environment: string;
  appVersion?: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  /** First recording start in the queried range (epoch ms). */
  startedMs: number;
  /** Last recording (re)start in the range: reloads start a new recording. */
  lastStartedMs: number;
  /** Distinct recordings (one per page load); markers without an id count once each. */
  recordings: number;
  firstPageUrl?: string;
  browser?: string;
  os?: string;
  errors?: number;
}

/**
 * Group `faro.session_recording.started` markers by session. Every page load
 * of a recorded session starts a recording, so the first marker gives the
 * start and the distinct recording ids give the number of page loads.
 */
export function summariseSessions(entries: Array<{ tsNs: string; line: string }>): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  // On reload Faro re-announces the previous recording before starting the
  // new one, so count recording ids rather than markers.
  const recordingIds = new Map<string, Set<string>>();
  let anonymous = 0;

  for (const { tsNs, line } of entries) {
    const fields = parseLogfmt(line);
    if (fields.event_name !== REPLAY_STARTED_EVENT || !fields.session_id) {
      continue;
    }
    const timeMs = faroTimeMs(fields, tsNs);
    const existing = sessions.get(fields.session_id);
    const ids = recordingIds.get(fields.session_id) ?? new Set<string>();
    ids.add(fields.event_data_recording_id || `marker-${anonymous++}`);
    recordingIds.set(fields.session_id, ids);

    if (!existing) {
      sessions.set(fields.session_id, {
        sessionId: fields.session_id,
        appName: fields.app_name ?? '',
        environment: fields.app_environment ?? '',
        appVersion: fields.app_version,
        userId: fields.user_id,
        userEmail: fields.user_email,
        userName: fields.user_fullName || fields.user_username,
        startedMs: timeMs,
        lastStartedMs: timeMs,
        recordings: 1,
        firstPageUrl: fields.page_url,
        browser: [fields.browser_name, fields.browser_version].filter(Boolean).join(' ') || undefined,
        os: fields.browser_os,
      });
      continue;
    }

    existing.recordings = ids.size;
    if (timeMs < existing.startedMs) {
      existing.startedMs = timeMs;
      existing.firstPageUrl = fields.page_url ?? existing.firstPageUrl;
    }
    existing.lastStartedMs = Math.max(existing.lastStartedMs, timeMs);
    existing.userEmail ??= fields.user_email;
    existing.userId ??= fields.user_id;
    existing.userName ??= fields.user_fullName || fields.user_username;
  }

  return [...sessions.values()].sort((a, b) => b.startedMs - a.startedMs);
}

/** Case-insensitive search over the visible session fields. */
export function matchesSearch(session: SessionSummary, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    session.sessionId,
    session.appName,
    session.environment,
    session.userId,
    session.userEmail,
    session.userName,
    session.firstPageUrl,
    session.browser,
    session.os,
  ].some((value) => value?.toLowerCase().includes(needle));
}
