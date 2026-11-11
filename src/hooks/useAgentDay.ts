import { useEffect, useState } from 'react';
import {
  daySpans,
  dayCalls,
  dayEventsOf,
  dayEventsQuery,
  latestClockOffset,
  spanOf,
  type DayCall,
  type DaySpan,
} from '../lib/agentDay';
import { dayQueryRange, mayReachInto, type Day } from '../lib/agents';
import { createLokiFetcher } from '../lib/loki';
import { fetchReplayIndex } from '../lib/replaySource';
import type { PayloadBuckets } from '../lib/sessionBucket';
import { fetchActiveSessionIds, fetchUserSessions } from '../lib/sessionQueries';
import { LIVE_WINDOW_MS } from '../lib/sessionStore';
import { sessionRange } from '../lib/sessions';

/** Session indexes read at once (each is a small query on its own payload bucket). */
const INDEX_CONCURRENCY = 4;
/** Today's day is read again this often: new sessions, longer spans, new calls. */
export const TODAY_REFRESH_MS = 60_000;

export interface AgentDayState {
  loading: boolean;
  error?: string;
  spans: DaySpan[];
  calls: DayCall[];
  /** Server minus the agent's computer's clock (ms), for times of day. */
  clockOffsetMs: number;
  /** Sessions recorded in the last minutes: the agent can be followed live. */
  active: Set<string>;
}

const EMPTY: AgentDayState = { loading: true, spans: [], calls: [], clockOffsetMs: 0, active: new Set() };

async function mapLimited<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One agent's day: the sessions' spans, the calls, and whether the agent is live now. */
export function useAgentDay(params: {
  lokiUid: string;
  appName: string;
  userId: string;
  day: Day;
  payloadBuckets?: PayloadBuckets;
}): AgentDayState {
  const { lokiUid, appName, userId, day, payloadBuckets } = params;
  const [state, setState] = useState<AgentDayState & { key?: string }>(EMPTY);
  const key = JSON.stringify({
    lokiUid,
    appName,
    userId,
    day: day.key,
    buckets: payloadBuckets?.count,
    since: payloadBuckets?.sinceMs,
  });

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const fetcher = createLokiFetcher(lokiUid);

    const load = async () => {
      const now = Date.now();
      const range = dayQueryRange(day, now);
      const sessions = (await fetchUserSessions(lokiUid, appName, userId, range.from, range.to)).filter((session) =>
        mayReachInto(session, day)
      );
      const [spans, lines, active] = await Promise.all([
        mapLimited(sessions, INDEX_CONCURRENCY, async (session) => {
          const index = await fetchReplayIndex(
            fetcher,
            session.sessionId,
            sessionRange(session, now),
            payloadBuckets,
            abort.signal
          );
          return spanOf(session, index.recordings);
        }),
        fetcher({
          expr: dayEventsQuery(appName, userId),
          fromMs: day.startMs,
          toMs: Math.min(day.endMs, now),
          limit: 5000,
          direction: 'forward',
          signal: abort.signal,
        }),
        day.endMs > now
          ? fetchActiveSessionIds(lokiUid, [appName], now, LIVE_WINDOW_MS).catch(() => new Set<string>())
          : Promise.resolve(new Set<string>()),
      ]);
      const events = dayEventsOf(lines, appName, userId);
      return {
        loading: false,
        spans: daySpans(spans, day),
        calls: dayCalls(events),
        clockOffsetMs: latestClockOffset(events),
        active,
      };
    };

    const run = () =>
      load()
        .then((next) => {
          if (!cancelled) {
            setState({ ...next, key });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled && !abort.signal.aborted) {
            const message = (error as { data?: { message?: string } })?.data?.message ?? String(error);
            setState((previous) => ({ ...previous, loading: false, error: message, key }));
          }
        });

    void run();
    const timer = day.endMs > Date.now() ? setInterval(run, TODAY_REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      abort.abort();
      clearInterval(timer);
    };
    // `key` stands for every input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state.key === key ? state : EMPTY;
}
