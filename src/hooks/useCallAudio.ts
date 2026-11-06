import { useEffect, useMemo, useRef, useState } from 'react';
import { CallAudioEngine } from '../lib/audioEngine';
import {
  audioSourcesOf,
  clockOffsetsOf,
  connectionLost,
  listingRange,
  type AudioSources,
  DEFAULT_AUDIBLE,
  missing,
  type CallAudioTrack,
  type Interval,
} from '../lib/callAudio';
import type { JourneyEvent } from '../lib/journey';
import { type PlayerClock, useClockEffect } from '../lib/playerClock';
import { fetchSegmentAudio, listSessionAudio, noSegments, type CallAudioSegments } from '../lib/recorderClient';

/** While live, the session's audio is listed again this often. */
export const LIVE_RELIST_MS = 30_000;

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
    const load = () => {
      setLoading(true);
      const sessionSources: AudioSources = JSON.parse(sourcesKey);
      // While live, the session goes on past the range loaded at the start.
      const span = listingRange(
        { startMs: fromMs, endMs: live ? Math.max(toMs, Date.now()) : toMs },
        JSON.parse(offsetsKey)
      );
      listSessionAudio(sessionSources, span.startMs, span.endMs)
        .then((listed) => {
          if (!cancelled) {
            setSegments(listed);
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
    load();
    const timer = live ? setInterval(load, LIVE_RELIST_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
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
