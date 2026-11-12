import { useEffect, useMemo, useState } from 'react';
import {
  INHERIT_LOOKBACK_MS,
  inheritRecording,
  inheritedRecordingQuery,
  needsInheritance,
  sessionRecordingFacts,
} from '../lib/inheritedRecording';
import type { JourneyEvent } from '../lib/journey';
import { createLokiFetcher, type LokiFetcher } from '../lib/loki';

/** Lines asked for: the agent's recording events of a day are a few dozen. */
export const INHERIT_LIMIT = 5000;
/** Past the session's start (Loki time): the previous session's last lines may be indexed a little later. */
export const INHERIT_QUERY_AFTER_MS = 3600_000;
/** Live waits for the lookup: past this it starts without the inherited recording (as before). */
export const INHERIT_TIMEOUT_MS = 10_000;

/**
 * The journey as the call audio reads it: with the recording.started (and
 * clocks) of the recording the session continues, when it has none of its own
 * (see lib/inheritedRecording). Looked up once, after the journey has loaded;
 * dropped as soon as the session announces the recording itself (live).
 * `resolving` holds while the lookup runs, so live starts once, in the right mode.
 */
export function useInheritedRecording(options: {
  lokiUid: string;
  sessionId: string;
  journey: JourneyEvent[];
  loadingJourney: boolean;
  range?: { from: number; to: number };
  enabled: boolean;
  fetcher?: LokiFetcher;
}): { journey: JourneyEvent[]; resolving: boolean } {
  const { lokiUid, sessionId, journey, loadingJourney, range, enabled, fetcher } = options;
  const [result, setResult] = useState<{ key: string; events: JourneyEvent[]; done: boolean }>();
  const key = `${lokiUid}|${sessionId}`;

  // Decided once per session, when its journey has loaded.
  const facts = useMemo(
    () => (loadingJourney ? undefined : sessionRecordingFacts(sessionId, journey)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadingJourney, sessionId]
  );
  const wanted = enabled && facts !== undefined && range !== undefined && needsInheritance(facts);
  const fromMs = range?.from;

  useEffect(() => {
    if (!wanted || !facts || fromMs === undefined) {
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), INHERIT_TIMEOUT_MS);
    (fetcher ?? createLokiFetcher(lokiUid))({
      expr: inheritedRecordingQuery(facts.appName!, facts.userId!),
      fromMs: fromMs - INHERIT_LOOKBACK_MS,
      toMs: Math.min(Date.now(), fromMs + INHERIT_QUERY_AFTER_MS),
      limit: INHERIT_LIMIT,
      direction: 'backward',
      signal: abort.signal,
    })
      .then((lines) => inheritRecording(lines, facts))
      // Optional: without it the session plays without sound, as before.
      .catch(() => [])
      .then((events) => {
        clearTimeout(timeout);
        if (!cancelled) {
          setResult({ key, events, done: true });
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [wanted, facts, fromMs, key, lokiUid, fetcher]);

  const inherited = result?.key === key ? result.events : undefined;
  const merged = useMemo(() => {
    const own = journey.some((event) => event.attributes.event_name === 'recording.started');
    return inherited && inherited.length > 0 && !own ? [...inherited, ...journey] : journey;
  }, [inherited, journey]);
  return {
    journey: merged,
    resolving: enabled && (loadingJourney || (wanted && !(result?.key === key && result.done))),
  };
}
