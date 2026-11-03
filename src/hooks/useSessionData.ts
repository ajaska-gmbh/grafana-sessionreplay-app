import { useEffect, useMemo, useState } from 'react';
import type { eventWithTime } from '@grafana/rrweb-types';
import { FARO_REPLAY_SOURCE, FARO_SOURCE, MAX_SESSION_MS } from '../constants';
import { buildJourney, type JourneyEvent } from '../lib/journey';
import { createLokiFetcher, logqlString, readForward, type LokiFetcher } from '../lib/loki';
import { decodeReplayLines, mergeReplayEvents, playableEvents, type DecodedReplayEvent } from '../lib/replayEvents';
import { REPLAY_STARTED_EVENT, summariseSessions, type SessionSummary } from '../lib/sessions';
import type { LokiLine } from '../types';

export interface SessionDataState {
  /** Resolved time range of the session (epoch ms). */
  range?: { from: number; to: number };
  session?: SessionSummary;
  /** rrweb events ready for the player (grows while pages load). */
  events: eventWithTime[];
  journey: JourneyEvent[];
  loadingReplay: boolean;
  loadingJourney: boolean;
  skippedEvents: number;
  error?: string;
  notFound: boolean;
}

/** LogQL selector for one app's stream; the app name is a label (see Alloy). */
export function streamSelector(source: string, appName: string): string {
  return `{source=${logqlString(source)}, app_name=${logqlString(appName)}}`;
}

/** LogQL line filter that narrows to one session before parsing. */
export function sessionFilter(sessionId: string): string {
  return `|= ${logqlString(`session_id=${sessionId}`)}`;
}

/**
 * Find a session's recordings when the link carries no time range: look for
 * its `started` markers in the last day first, then the full retention.
 */
async function locateSession(
  fetcher: LokiFetcher,
  appName: string,
  sessionId: string,
  nowMs: number
): Promise<SessionSummary | undefined> {
  const expr = `${streamSelector(FARO_SOURCE, appName)} |= ${logqlString(`event_name=${REPLAY_STARTED_EVENT}`)} ${sessionFilter(sessionId)}`;
  for (const lookbackMs of [24 * 3600 * 1000, 14 * 24 * 3600 * 1000]) {
    const lines = await fetcher({ expr, fromMs: nowMs - lookbackMs, toMs: nowMs, limit: 1000, direction: 'forward' });
    const session = summariseSessions(lines).find((candidate) => candidate.sessionId === sessionId);
    if (session) {
      return session;
    }
  }
  return undefined;
}

/**
 * Load one session's replay and journey. State is not reset when the
 * parameters change: render the consumer with a `key` per session instead.
 */
export function useSessionData(params: {
  lokiUid: string;
  appName: string;
  sessionId: string;
  from?: number;
  to?: number;
}): SessionDataState {
  const { lokiUid, appName, sessionId, from, to } = params;
  const fetcher = useMemo(() => createLokiFetcher(lokiUid), [lokiUid]);
  const [state, setState] = useState<SessionDataState>({
    events: [],
    journey: [],
    loadingReplay: true,
    loadingJourney: true,
    skippedEvents: 0,
    notFound: false,
  });

  useEffect(() => {
    let cancelled = false;
    const update = (patch: Partial<SessionDataState>) => {
      if (!cancelled) {
        setState((previous) => ({ ...previous, ...patch }));
      }
    };

    (async () => {
      const nowMs = Date.now();
      let range = from !== undefined && to !== undefined ? { from, to } : undefined;
      let session: SessionSummary | undefined;

      if (!range) {
        session = await locateSession(fetcher, appName, sessionId, nowMs);
        if (!session) {
          update({ notFound: true, loadingReplay: false, loadingJourney: false });
          return;
        }
        // Faro ends a session after 4h; a minute of slack for clock skew.
        range = {
          from: session.startedMs - 60_000,
          to: Math.min(nowMs, session.lastStartedMs + MAX_SESSION_MS),
        };
      }
      update({ range, session });

      const replay = (async () => {
        const known = new Map<string, DecodedReplayEvent>();
        let skipped = 0;
        const expr = `${streamSelector(FARO_REPLAY_SOURCE, appName)} ${sessionFilter(sessionId)}`;
        for await (const page of readForward(fetcher, expr, range.from, range.to)) {
          const { decoded, skipped: pageSkipped } = decodeReplayLines(page, sessionId);
          skipped += pageSkipped;
          update({ events: playableEvents(mergeReplayEvents(known, decoded)), skippedEvents: skipped });
          if (cancelled) {
            return;
          }
        }
        update({ loadingReplay: false });
      })();

      const journey = (async () => {
        const lines: LokiLine[] = [];
        const expr = `${streamSelector(FARO_SOURCE, appName)} ${sessionFilter(sessionId)}`;
        for await (const page of readForward(fetcher, expr, range.from, range.to)) {
          lines.push(...page);
          update({ journey: buildJourney(lines, sessionId) });
          if (cancelled) {
            return;
          }
        }
        update({ loadingJourney: false });
      })();

      await Promise.all([replay, journey]);
    })().catch((error: unknown) => {
      const message =
        (error as { data?: { message?: string } })?.data?.message ??
        (error instanceof Error ? error.message : String(error));
      update({ error: message, loadingReplay: false, loadingJourney: false });
    });

    return () => {
      cancelled = true;
    };
  }, [fetcher, appName, sessionId, from, to]);

  return state;
}
