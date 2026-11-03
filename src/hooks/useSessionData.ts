import { useEffect, useMemo, useState } from 'react';
import type { eventWithTime } from '@grafana/rrweb-types';
import { REPLAY_PAGE_SIZE } from '../constants';
import { buildJourney, type JourneyEvent } from '../lib/journey';
import { createLokiFetcher, readForward, type LokiFetcher } from '../lib/loki';
import { eventLineFilter, sessionLineFilter, STREAMS } from '../lib/logql';
import { decodeReplayLines, mergeReplayEvents, type DecodedReplayEvent } from '../lib/replayEvents';
import { REPLAY_STARTED_EVENT, sessionRange, summariseSessions, type SessionSummary } from '../lib/sessions';
import type { LokiLine } from '../types';

export interface SessionDataState {
  /** Resolved time range of the session (epoch ms). */
  range?: { from: number; to: number };
  session?: SessionSummary;
  /**
   * Playable rrweb event lists (grow while pages load). Usually one; a session
   * open in several tabs at once has one track per tab.
   */
  tracks: eventWithTime[][];
  journey: JourneyEvent[];
  loadingReplay: boolean;
  loadingJourney: boolean;
  skippedEvents: number;
  error?: string;
  notFound: boolean;
}

/**
 * Find a session's recordings when the link carries no time range: look for
 * its `started` markers in the last day first, then the full retention.
 */
async function locateSession(
  fetcher: LokiFetcher,
  sessionId: string,
  nowMs: number
): Promise<SessionSummary | undefined> {
  const expr = STREAMS.markers + eventLineFilter(REPLAY_STARTED_EVENT) + sessionLineFilter(sessionId);
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
  sessionId: string;
  from?: number;
  to?: number;
}): SessionDataState {
  const { lokiUid, sessionId, from, to } = params;
  const fetcher = useMemo(() => createLokiFetcher(lokiUid), [lokiUid]);
  const [state, setState] = useState<SessionDataState>({
    tracks: [],
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
        session = await locateSession(fetcher, sessionId, nowMs);
        if (!session) {
          update({ notFound: true, loadingReplay: false, loadingJourney: false });
          return;
        }
        range = sessionRange(session, nowMs);
      }
      update({ range, session });

      const replay = (async () => {
        const known = new Map<string, DecodedReplayEvent>();
        let skipped = 0;
        const expr = STREAMS.payloads + sessionLineFilter(sessionId);
        for await (const page of readForward(fetcher, expr, range.from, range.to, REPLAY_PAGE_SIZE)) {
          const { decoded, skipped: pageSkipped } = decodeReplayLines(page, sessionId);
          skipped += pageSkipped;
          update({ tracks: mergeReplayEvents(known, decoded), skippedEvents: skipped });
          if (cancelled) {
            return;
          }
        }
        update({ loadingReplay: false });
      })();

      const journey = (async () => {
        const lines: LokiLine[] = [];
        const expr = STREAMS.faro + sessionLineFilter(sessionId);
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
  }, [fetcher, sessionId, from, to]);

  return state;
}
