import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLOCK_SLACK_MS, MAX_SESSION_MS, REPLAY_PAGE_SIZE } from '../constants';
import { ChunkLoader, priorityOrder } from '../lib/chunkLoader';
import type { JourneyEvent } from '../lib/journey';
import { createLokiFetcher, isAbortError, readForward, type LokiFetcher } from '../lib/loki';
import { eventLineFilter, sessionLineFilter, STREAMS } from '../lib/logql';
import { linkOffset } from '../lib/playerEvents';
import type { DecodedReplayEvent, ReplayTrack } from '../lib/replayEvents';
import { chunkIndexAt, chunksFrom, withDependencies } from '../lib/replayFeed';
import { fetchChunk, fetchReplayIndex } from '../lib/replaySource';
import type { PayloadBuckets } from '../lib/sessionBucket';
import { loadRange, REPLAY_STARTED_EVENT, sessionRange, summariseSessions, type SessionSummary } from '../lib/sessions';
import { SessionStore } from '../lib/sessionStore';
import { journeyQuery } from '../lib/journeyQuery';
import { audioLevelsQuery, type AudioLevelWindow } from '../lib/audioLevels';

/** How often live mode asks Loki for new events. */
export const LIVE_POLL_MS = 3000;

/**
 * Live retries a given-up newest chunk (it plays nothing without it) after
 * this pause, doubled for every further round, at most 5 minutes; each round
 * is the loader's own attempts with their pauses.
 */
export function liveRetryDelayMs(rounds: number): number {
  return rounds === 0 ? 0 : Math.min(5 * 60 * 1000, 15_000 * 2 ** (rounds - 1));
}

export interface SessionDataState {
  /** Resolved time range of the session (epoch ms). */
  range?: { from: number; to: number };
  session?: SessionSummary;
  /**
   * Playable tracks, complete in length from the index on; their chunks fill
   * in as they load. Usually one; a session open in several tabs at once has
   * one track per tab.
   */
  tracks: ReplayTrack[];
  journey: JourneyEvent[];
  /** The dialer's per-second audio levels for the level graph (empty for other apps). */
  audioLevels: AudioLevelWindow[];
  /** Until the replay's index is known (tracks, lengths, where every chunk is). */
  loadingReplay: boolean;
  /** Chunks are still being fetched. */
  loadingChunks: boolean;
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
 * Where playback is: chunks there load first, then outward from it. Live:
 * only the newest chunks load (live plays from the newest checkout on).
 */
export type FocusReplay = (track: number, offsetMs: number, live?: boolean) => void;

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
 *
 * The replay loads progressively: first its index (every recording, checkout
 * and tab, with times), so the full timeline is known at once; then its
 * chunks, a few at a time, the one at the playback target first (the link's
 * `t` and `track`, then wherever `focus` points). Journey and audio levels
 * load alongside.
 */
export function useSessionData(params: {
  lokiUid: string;
  sessionId: string;
  from?: number;
  to?: number;
  /** The link's start offset and tab: loaded first. */
  t?: number;
  track?: number;
  live?: boolean;
  /** Where the payload stream is split by session (app config); none: read the whole stream. */
  payloadBuckets?: PayloadBuckets;
  /** For tests: the chunk loader's first retry pause (default 1 s, doubling). */
  chunkRetryDelayMs?: number;
}): SessionDataState & { focus: FocusReplay } {
  const { lokiUid, sessionId, from, to, live = false, payloadBuckets, chunkRetryDelayMs } = params;
  const bucketCount = payloadBuckets?.count;
  const bucketsSinceMs = payloadBuckets?.sinceMs;
  const fetcher = useMemo(() => createLokiFetcher(lokiUid), [lokiUid]);
  const storeRef = useRef<SessionStore | null>(null);
  const loaderRef = useRef<ChunkLoader<{ events: DecodedReplayEvent[]; skipped: number }> | null>(null);
  /** The payload selector the index settled on; chunks and live mode read the same. */
  const payloadStreamRef = useRef<string>(STREAMS.payloads);
  /** The playback target: the link's until the player names one. */
  const focusRef = useRef<{ track: number; offsetMs?: number; live: boolean }>({
    track: params.track ?? 0,
    live,
  });
  const linkRef = useRef({ t: params.t, live });
  /** Publishes the store's state (set by the load effect). */
  const publishRef = useRef<() => void>(() => undefined);
  const [state, setState] = useState<SessionDataState>({
    tracks: [],
    journey: [],
    audioLevels: [],
    loadingReplay: true,
    loadingChunks: false,
    loadingJourney: true,
    loadingAudioLevels: true,
    skippedEvents: 0,
    unresolvedStylesheets: 0,
    droppedStylesheets: 0,
    notFound: false,
  });

  /** Hands the loader the order for the current focus: its track first, the other tabs after. */
  const reprioritise = useCallback(() => {
    const loader = loaderRef.current;
    const store = storeRef.current;
    if (!loader || !store) {
      return;
    }
    const tracks = store.tracks;
    const focused = tracks[focusRef.current.track] ?? tracks[0];
    if (!focused) {
      return;
    }
    const others = tracks.filter((track) => track !== focused);
    const newest = (track: ReplayTrack) => withDependencies(track, track.chunks.length - 1).map((chunk) => chunk.key);
    // Live plays from where it starts (the newest checkout, or further back
    // with sound) on: older chunks would only cost Loki scans (they load once
    // live is left and the player asks for them).
    const liveOffset = focusRef.current.offsetMs ?? Infinity;
    const order = focusRef.current.live
      ? [
          ...(Number.isFinite(liveOffset) ? chunksFrom(focused, liveOffset) : newest(focused)),
          ...others.flatMap(newest),
        ]
      : [
          ...priorityOrder(focused.chunks, chunkIndexAt(focused, focusRef.current.offsetMs ?? Infinity)),
          ...others.flatMap((track) => track.chunks.map((chunk) => chunk.key)),
        ];
    loader.prioritise(order.filter((key) => !store.replay.isLoaded(key)));
  }, []);

  const focus = useCallback<FocusReplay>(
    (track, offsetMs, live = false) => {
      focusRef.current = { track, offsetMs, live };
      // Playback wants this point: chunks there that were given up are tried again.
      const loader = loaderRef.current;
      const store = storeRef.current;
      const focused = store?.tracks[track];
      if (loader && store && focused) {
        const failed = withDependencies(focused, chunkIndexAt(focused, offsetMs)).filter((chunk) => chunk.failed);
        for (const chunk of failed) {
          store.replay.retryChunk(chunk.key);
          loader.retry(chunk.key);
        }
        if (failed.length > 0) {
          publishRef.current();
        }
      }
      reprioritise();
    },
    [reprioritise]
  );

  // Initial load of the session's time range.
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
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
        loadingChunks: loaderRef.current !== null && !loaderRef.current.idle,
      });
    publishRef.current = publish;

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
      if (cancelled) {
        return;
      }
      update({ range, session });

      const replay = (async () => {
        const buckets =
          bucketCount !== undefined && bucketsSinceMs !== undefined
            ? { count: bucketCount, sinceMs: bucketsSinceMs }
            : undefined;
        const index = await fetchReplayIndex(fetcher, sessionId, range, buckets, abort.signal);
        // A cancelled run (the session changed meanwhile) must not set the new one's selector.
        if (cancelled) {
          return;
        }
        const stream = index.stream;
        payloadStreamRef.current = stream;
        store.setIndex(index);
        const loader = new ChunkLoader({
          retryDelayMs: chunkRetryDelayMs,
          load: (key, signal) => {
            const info = store.replay.chunkInfo(key);
            return info
              ? fetchChunk(fetcher, stream, sessionId, info, signal)
              : Promise.resolve({ events: [], skipped: 0 });
          },
          onLoaded: (key, chunk) => {
            store.replay.addChunk(key, chunk.events, chunk.skipped);
            publish();
          },
          onFailed: (key) => {
            store.replay.failChunk(key);
            publish();
          },
        });
        loaderRef.current = loader;
        if (focusRef.current.offsetMs === undefined) {
          // The link's target until the player names one; live starts at the end.
          const track = store.tracks[focusRef.current.track] ?? store.tracks[0];
          focusRef.current.offsetMs =
            linkRef.current.live || !track ? Infinity : linkOffset(track, from, linkRef.current.t);
        }
        reprioritise();
        update({ loadingReplay: false });
        publish();
      })();

      const journey = (async () => {
        const expr = journeyQuery(sessionId);
        for await (const page of readForward(fetcher, expr, range.from, range.to, undefined, abort.signal)) {
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
          for await (const page of readForward(
            fetcher,
            audioLevelsQuery(sessionId),
            range.from,
            range.to,
            undefined,
            abort.signal
          )) {
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
      if (cancelled || isAbortError(error)) {
        return;
      }
      update({ error: errorMessage(error), loadingReplay: false, loadingJourney: false, loadingAudioLevels: false });
    });

    return () => {
      cancelled = true;
      abort.abort();
      loaderRef.current?.dispose();
      loaderRef.current = null;
    };
  }, [fetcher, sessionId, from, to, bucketCount, bucketsSinceMs, reprioritise, chunkRetryDelayMs]);

  // Live mode: from the index's end on, fetch what arrived since the cursors —
  // new events, checkouts, reloads and tabs alike. The journey and the levels
  // join once their initial load is done.
  const indexDone = !state.loadingReplay;
  const journeyDoneRef = useRef(false);
  const levelsDoneRef = useRef(false);
  useEffect(() => {
    journeyDoneRef.current = !state.loadingJourney;
    levelsDoneRef.current = !state.loadingAudioLevels;
  }, [state.loadingJourney, state.loadingAudioLevels]);
  useEffect(() => {
    const store = storeRef.current;
    if (!live || !indexDone || !store) {
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** Given-up chunks live needs (from where it starts on): retried with growing pauses (live shows nothing without them). */
    const rounds = new Map<string, { atMs: number; count: number }>();
    const retryNewest = (nowMs: number) => {
      const loader = loaderRef.current;
      if (!loader) {
        return;
      }
      let retried = false;
      const focused = store.tracks[focusRef.current.track] ?? store.tracks[0];
      const liveFrom = focusRef.current.offsetMs ?? Infinity;
      for (const track of store.tracks) {
        const needed =
          track === focused && Number.isFinite(liveFrom)
            ? chunksFrom(track, liveFrom).map((key) => track.chunks.find((chunk) => chunk.key === key)!)
            : withDependencies(track, track.chunks.length - 1);
        for (const chunk of needed) {
          const last = rounds.get(chunk.key) ?? { atMs: 0, count: 0 };
          if (chunk.failed && nowMs - last.atMs >= liveRetryDelayMs(last.count)) {
            rounds.set(chunk.key, { atMs: nowMs, count: last.count + 1 });
            store.replay.retryChunk(chunk.key);
            loader.retry(chunk.key);
            retried = true;
          }
        }
      }
      if (retried) {
        publishRef.current();
      }
    };

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
          REPLAY_PAGE_SIZE,
          abort.signal
        )) {
          store.addReplayLines(page);
        }
        if (journeyDoneRef.current) {
          for await (const page of readForward(
            fetcher,
            journeyExpr,
            store.journeyCursorMs(fallbackMs),
            nowMs,
            undefined,
            abort.signal
          )) {
            store.addJourneyLines(page);
          }
        }
        if (!cancelled) {
          // A new reload or tab adds chunks: keep the loader's order complete.
          reprioritise();
          retryNewest(nowMs);
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
        if (!cancelled && !isAbortError(error)) {
          setState((previous) => ({ ...previous, liveError: errorMessage(error) }));
        }
      }
      // After the replay and journey are out, and on its own: a failing or slow
      // level query must never hold up or break the live replay. The next poll
      // retries from the same cursor.
      if (levelsDoneRef.current && !cancelled) {
        try {
          for await (const page of readForward(
            fetcher,
            audioLevelsQuery(sessionId),
            store.audioLevelCursorMs(fallbackMs),
            nowMs,
            undefined,
            abort.signal
          )) {
            store.addAudioLevelLines(page);
          }
          if (!cancelled) {
            setState((previous) => ({ ...previous, audioLevels: store.audioLevels }));
          }
        } catch {
          // The graph lags until the next poll.
        }
      }
      if (!cancelled) {
        timer = setTimeout(poll, LIVE_POLL_MS);
      }
    };
    timer = setTimeout(poll, 0);

    return () => {
      cancelled = true;
      abort.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [live, indexDone, fetcher, sessionId, reprioritise]);

  return { ...state, focus };
}
