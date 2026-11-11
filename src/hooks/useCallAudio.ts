import { useEffect, useMemo, useRef, useState } from 'react';
import { CallAudioEngine } from '../lib/audioEngine';
import {
  audioSourcesOf,
  clockOffsetsOf,
  connectionLost,
  listingRange,
  LIST_CLOCK_SLACK_MS,
  type AudioSources,
  DEFAULT_AUDIBLE,
  missing,
  type CallAudioTrack,
  type Interval,
} from '../lib/callAudio';
import type { JourneyEvent } from '../lib/journey';
import { type PlayerClock, useClockEffect } from '../lib/playerClock';
import {
  fetchSegmentAudio,
  listSessionAudio,
  mergeSegments,
  noSegments,
  type CallAudioSegments,
} from '../lib/recorderClient';

/**
 * While live, the newest audio is listed this often (one small listing: the
 * recorder lists only keys from the range's start on), so live with sound can
 * trail the agent by little more than a segment (10 s) and its upload.
 */
export const LIVE_TAIL_MS = 3_000;
/** How far back a live tail listing reaches: segments arrive after they end, and late after a network gap. */
export const LIVE_TAIL_SPAN_MS = 3 * 60_000;
/** While live, the whole session is listed again this often, for segments that arrived later than the tail reaches. */
export const LIVE_RELIST_MS = 60_000;

export interface CallAudio {
  /** Whether the session has call audio at all. */
  available: boolean;
  loading: boolean;
  error?: string;
  segments: CallAudioSegments;
  /** Where the agent's microphone was not recorded within the session. */
  micMissing: Interval[];
  /** Where the agent's browser had no network. */
  connectionLost: Interval[];
  audible: ReadonlySet<CallAudioTrack>;
  toggle: (track: CallAudioTrack) => void;
  volume: number;
  setVolume: (volume: number) => void;
  stereo: boolean;
  setStereo: (stereo: boolean) => void;
}

/**
 * The session's call audio (see lib/callAudio), played in step with `clock`.
 * Nothing is requested when the recorder is not configured or the session has
 * no recording events, as for every app but the dialer.
 */
export function useCallAudio(options: {
  journey: JourneyEvent[];
  range?: { from: number; to: number };
  clock: PlayerClock;
  enabled: boolean;
  live?: boolean;
}): CallAudio {
  const { journey, range, clock, enabled, live } = options;
  const sources = useMemo(() => audioSourcesOf(journey), [journey]);
  const sourcesKey = JSON.stringify(sources);
  const offsetsKey = useMemo(() => JSON.stringify(clockOffsetsOf(journey)), [journey]);
  const available = enabled && sources.browser !== undefined && range !== undefined;

  const [segments, setSegments] = useState<CallAudioSegments>(noSegments);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [audible, setAudible] = useState<ReadonlySet<CallAudioTrack>>(DEFAULT_AUDIBLE);
  const [volume, setVolume] = useState(1);
  const [stereo, setStereo] = useState(false);

  // Made (and disposed) by an effect, so a remount gets a working one; opens no AudioContext until something is heard.
  const engineRef = useRef<CallAudioEngine | null>(null);
  useEffect(() => {
    const engine = new CallAudioEngine({ fetchAudio: fetchSegmentAudio, onError: setError });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const fromMs = range?.from;
  const toMs = range?.to;
  useEffect(() => {
    if (!available || fromMs === undefined || toMs === undefined) {
      return;
    }
    let cancelled = false;
    const sessionSources: AudioSources = JSON.parse(sourcesKey);
    const load = () => {
      setLoading(true);
      // While live, the session goes on past the range loaded at the start.
      const span = listingRange(
        { startMs: fromMs, endMs: live ? Math.max(toMs, Date.now()) : toMs },
        JSON.parse(offsetsKey)
      );
      listSessionAudio(sessionSources, span.startMs, span.endMs)
        .then((listed) => {
          if (!cancelled) {
            // Live: keep what a tail brought meanwhile.
            setSegments((known) => (live ? mergeSegments(listed, known) : listed));
            setError(undefined);
          }
        })
        .catch((failure: unknown) => {
          if (!cancelled) {
            setError((failure as { data?: { message?: string } })?.data?.message ?? String(failure));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    };
    // Live: the newest minutes, often (server clock: the recorder files new segments on it).
    let tailing = false;
    const tail = () => {
      if (tailing) {
        return;
      }
      tailing = true;
      const now = Date.now();
      listSessionAudio(sessionSources, now - LIVE_TAIL_SPAN_MS, now + LIST_CLOCK_SLACK_MS)
        .then((listed) => {
          if (!cancelled) {
            setSegments((known) => mergeSegments(known, listed));
          }
        })
        // A failed tail is retried by the next one; the full listing reports errors.
        .catch(() => undefined)
        .finally(() => {
          tailing = false;
        });
    };
    load();
    const timers = live ? [setInterval(load, LIVE_RELIST_MS), setInterval(tail, LIVE_TAIL_MS)] : [];
    return () => {
      cancelled = true;
      timers.forEach(clearInterval);
    };
  }, [available, sourcesKey, offsetsKey, fromMs, toMs, live]);

  useEffect(() => engineRef.current?.setSegments(segments), [segments]);
  useEffect(() => engineRef.current?.setAudible(audible), [audible]);
  useEffect(() => engineRef.current?.setVolume(volume), [volume]);
  useEffect(() => engineRef.current?.setStereo(stereo), [stereo]);
  useClockEffect(clock, (state) => {
    if (available) {
      engineRef.current?.sync(state);
    }
  });

  const micMissing = useMemo(
    () => (fromMs === undefined || toMs === undefined ? [] : missing(segments.mic, { startMs: fromMs, endMs: toMs })),
    [segments, fromMs, toMs]
  );
  const offline = useMemo(() => connectionLost(journey), [journey]);

  return {
    available,
    loading,
    error,
    segments,
    micMissing,
    connectionLost: offline,
    audible,
    toggle: (track) =>
      setAudible((previous) => {
        const next = new Set(previous);
        if (next.has(track)) {
          next.delete(track);
        } else {
          next.add(track);
        }
        return next;
      }),
    volume,
    setVolume,
    stereo,
    setStereo,
  };
}
