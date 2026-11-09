import { useEffect, useMemo, useRef, useState } from 'react';
import type { eventWithTime } from '@grafana/rrweb-types';
import { CLOCK_SLACK_MS, MAX_SESSION_MS, REPLAY_PAGE_SIZE } from '../constants';
import type { JourneyEvent } from '../lib/journey';
import { createLokiFetcher, readForward, type LokiFetcher } from '../lib/loki';
import { eventLineFilter, sessionLineFilter, sessionPayloads, STREAMS } from '../lib/logql';
import type { PayloadBuckets } from '../lib/sessionBucket';
import { loadRange, REPLAY_STARTED_EVENT, sessionRange, summariseSessions, type SessionSummary } from '../lib/sessions';
import { SessionStore } from '../lib/sessionStore';
import { journeyQuery } from '../lib/journeyQuery';
import { audioLevelsQuery, type AudioLevelWindow } from '../lib/audioLevels';

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
  /** The dialer's per-second audio levels for the level graph (empty for other apps). */
  audioLevels: AudioLevelWindow[];
  loadingReplay: boolean;
  loadingJourney: boolean;
  loadingAudioLevels: boolean;
  skippedEvents: number;
  unresolvedStylesheets: number;
  droppedStylesheets: number;
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

/**
 * The session's recordings as seen from a link's own range: its start markers
 * up to Faro's maximum session length before the range. Undefined if none.
 */
export async function findSessionAround(
  fetcher: LokiFetcher,
  sessionId: string,
  link: { from: number; to: number }
): Promise<SessionSummary | undefined> {
  const expr = STREAMS.markers + eventLineFilter(REPLAY_STARTED_EVENT) + sessionLineFilter(sessionId);
  const lines = await fetcher({
    expr,
    fromMs: link.from - MAX_SESSION_MS - CLOCK_SLACK_MS,
    toMs: link.to,
    limit: 1000,
    direction: 'forward',
  });
  return summariseSessions(lines).find((candidate) => candidate.sessionId === sessionId);
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
  /** Where the payload stream is split by session (app config); none: read the whole stream. */
  payloadBuckets?: PayloadBuckets;
}): SessionDataState {
  const { lokiUid, sessionId, from, to, live = false, payloadBuckets } = params;
  const bucketCount = payloadBuckets?.count;
  const bucketsSinceMs = payloadBuckets?.sinceMs;
  const fetcher = useMemo(() => createLokiFetcher(lokiUid), [lokiUid]);
  const storeRef = useRef<SessionStore | null>(null);
  /** The payload selector the initial load settled on; live mode polls the same. */
  const payloadStreamRef = useRef<string>(STREAMS.payloads);
  const [state, setState] = useState<SessionDataState>({
    tracks: [],
    journey: [],
    audioLevels: [],
    loadingReplay: true,
    loadingJourney: true,
    loadingAudioLevels: true,
    skippedEvents: 0,
    unresolvedStylesheets: 0,
    droppedStylesheets: 0,
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
        audioLevels: store.audioLevels,
        skippedEvents: store.skipped,
        unresolvedStylesheets: store.unresolvedStylesheets,
        droppedStylesheets: store.droppedStylesheets,
        lastReplayMs: store.lastReplayMs,
      });

    (async () => {
      const nowMs = Date.now();
      let range: { from: number; to: number } | undefined;
      let session: SessionSummary | undefined;

      if (from !== undefined && to !== undefined) {
        // Load from the session's first recording start even if the link starts later.
        range = loadRange({ from, to }, await findSessionAround(fetcher, sessionId, { from, to }));
      } else {
        session = await locateSession(fetcher, sessionId, nowMs);
        if (!session) {
          update({ notFound: true, loadingReplay: false, loadingJourney: false, loadingAudioLevels: false });
          return;
        }
        range = sessionRange(session, nowMs);
      }
      update({ range, session });

      const replay = (async () => {
        const buckets =
          bucketCount !== undefined && bucketsSinceMs !== undefined
            ? { count: bucketCount, sinceMs: bucketsSinceMs }
            : undefined;
        const readPayloads = async (stream: string): Promise<number> => {
          payloadStreamRef.current = stream;
          let lines = 0;
          for await (const page of readForward(
            fetcher,
            stream + sessionLineFilter(sessionId),
            range.from,
            range.to,
            REPLAY_PAGE_SIZE
          )) {
            if (cancelled) {
              return lines;
            }
            lines += page.length;
            store.addReplayLines(page);
            publish();
          }
          return lines;
        };
        const stream = sessionPayloads(sessionId, range.from, buckets);
        // Nothing in the bucket: a session from before the pipeline labelled
        // buckets, seen through an agent clock running ahead. Read it whole.
        if ((await readPayloads(stream)) === 0 && stream !== STREAMS.payloads && !cancelled) {
          await readPayloads(STREAMS.payloads);
        }
        update({ loadingReplay: false });
      })();

      const journey = (async () => {
        const expr = journeyQuery(sessionId);
        for await (const page of readForward(fetcher, expr, range.from, range.to)) {
          if (cancelled) {
            return;
          }
          store.addJourneyLines(page);
          publish();
        }
        update({ loadingJourney: false });
      })();

      // Optional: a failure here must not hide the replay or the journey.
      const audioLevels = (async () => {
        try {
          for await (const page of readForward(fetcher, audioLevelsQuery(sessionId), range.from, range.to)) {
            if (cancelled) {
              return;
            }
            store.addAudioLevelLines(page);
            publish();
          }
        } catch {
          // The graph stays empty.
        }
        update({ loadingAudioLevels: false });
      })();

      await Promise.all([replay, journey, audioLevels]);
    })().catch((error: unknown) => {
      update({ error: errorMessage(error), loadingReplay: false, loadingJourney: false, loadingAudioLevels: false });
    });

    return () => {
      cancelled = true;
    };
  }, [fetcher, sessionId, from, to, bucketCount, bucketsSinceMs]);

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
      const replayExpr = payloadStreamRef.current + sessionLineFilter(sessionId);
      const journeyExpr = journeyQuery(sessionId);
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
            unresolvedStylesheets: store.unresolvedStylesheets,
            droppedStylesheets: store.droppedStylesheets,
            lastReplayMs: store.lastReplayMs,
            liveError: undefined,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({ ...previous, liveError: errorMessage(error) }));
        }
      }
      // After the replay and journey are out, and on its own: a failing or slow
      // level query must never hold up or break the live replay. The next poll
      // retries from the same cursor.
      try {
        for await (const page of readForward(
          fetcher,
          audioLevelsQuery(sessionId),
          store.audioLevelCursorMs(fallbackMs),
          nowMs
        )) {
          store.addAudioLevelLines(page);
        }
        if (!cancelled) {
          setState((previous) => ({ ...previous, audioLevels: store.audioLevels }));
        }
      } catch {
        // The graph lags until the next poll.
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
