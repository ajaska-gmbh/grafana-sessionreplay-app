import { useEffect, useMemo, useRef, useState } from 'react';
import type { eventWithTime } from '@grafana/rrweb-types';
import { REPLAY_PAGE_SIZE } from '../constants';
import type { JourneyEvent } from '../lib/journey';
import { createLokiFetcher, readForward, type LokiFetcher } from '../lib/loki';
import { eventLineFilter, sessionLineFilter, STREAMS } from '../lib/logql';
import { REPLAY_STARTED_EVENT, sessionRange, summariseSessions, type SessionSummary } from '../lib/sessions';
import { SessionStore } from '../lib/sessionStore';

/** How often live mode asks Loki for new events. */
export const LIVE_POLL_MS = 3000;

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
  /** Loki time of the newest replay line (epoch ms); decides whether live is offered. */
  lastReplayMs?: number;
  error?: string;
  /** Last failed live poll; transient, the next poll retries. */
  liveError?: string;
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

function errorMessage(error: unknown): string {
  return (
    (error as { data?: { message?: string } })?.data?.message ??
    (error instanceof Error ? error.message : String(error))
  );
}

/**
 * Load one session's replay and journey; with `live`, keep polling Loki for
 * the newest events. State is not reset when the session changes: render the
 * consumer with a `key` per session instead.
 */
export function useSessionData(params: {
  lokiUid: string;
  sessionId: string;
  from?: number;
  to?: number;
  live?: boolean;
}): SessionDataState {
  const { lokiUid, sessionId, from, to, live = false } = params;
  const fetcher = useMemo(() => createLokiFetcher(lokiUid), [lokiUid]);
  const storeRef = useRef<SessionStore | null>(null);
  const [state, setState] = useState<SessionDataState>({
    tracks: [],
    journey: [],
    loadingReplay: true,
    loadingJourney: true,
    skippedEvents: 0,
    notFound: false,
  });

  // Initial load of the session's time range.
  useEffect(() => {
    let cancelled = false;
    const store = new SessionStore(sessionId);
    storeRef.current = store;
    const update = (patch: Partial<SessionDataState>) => {
      if (!cancelled) {
        setState((previous) => ({ ...previous, ...patch }));
      }
    };
    const publish = () =>
      update({
        tracks: store.tracks,
        journey: store.journey,
        skippedEvents: store.skipped,
        lastReplayMs: store.lastReplayMs,
      });

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
        const expr = STREAMS.payloads + sessionLineFilter(sessionId);
        for await (const page of readForward(fetcher, expr, range.from, range.to, REPLAY_PAGE_SIZE)) {
          if (cancelled) {
            return;
          }
          store.addReplayLines(page);
          publish();
        }
        update({ loadingReplay: false });
      })();

      const journey = (async () => {
        const expr = STREAMS.faro + sessionLineFilter(sessionId);
        for await (const page of readForward(fetcher, expr, range.from, range.to)) {
          if (cancelled) {
            return;
          }
          store.addJourneyLines(page);
          publish();
        }
        update({ loadingJourney: false });
      })();

      await Promise.all([replay, journey]);
    })().catch((error: unknown) => {
      update({ error: errorMessage(error), loadingReplay: false, loadingJourney: false });
    });

    return () => {
      cancelled = true;
    };
  }, [fetcher, sessionId, from, to]);

  // Live mode: after the initial load, fetch what arrived since the cursors.
  const initialDone = !state.loadingReplay && !state.loadingJourney;
  useEffect(() => {
    const store = storeRef.current;
    if (!live || !initialDone || !store) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const nowMs = Date.now();
      const fallbackMs = nowMs - LIVE_POLL_MS * 2;
      const replayExpr = STREAMS.payloads + sessionLineFilter(sessionId);
      const journeyExpr = STREAMS.faro + sessionLineFilter(sessionId);
      try {
        for await (const page of readForward(
          fetcher,
          replayExpr,
          store.replayCursorMs(fallbackMs),
          nowMs,
          REPLAY_PAGE_SIZE
        )) {
          store.addReplayLines(page);
        }
        for await (const page of readForward(fetcher, journeyExpr, store.journeyCursorMs(fallbackMs), nowMs)) {
          store.addJourneyLines(page);
        }
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            tracks: store.tracks,
            journey: store.journey,
            skippedEvents: store.skipped,
            lastReplayMs: store.lastReplayMs,
            liveError: undefined,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({ ...previous, liveError: errorMessage(error) }));
        }
      }
      if (!cancelled) {
        timer = setTimeout(poll, LIVE_POLL_MS);
      }
    };
    timer = setTimeout(poll, 0);

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [live, initialDone, fetcher, sessionId]);

  return state;
}
