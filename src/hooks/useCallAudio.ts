import { useEffect, useMemo, useState } from 'react';
import { CallAudioEngine } from '../lib/audioEngine';
import {
  audioSourcesOf,
  connectionLost,
  DEFAULT_AUDIBLE,
  losses,
  type CallAudioTrack,
  type Interval,
  type Losses,
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
  losses: Losses;
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
  const hasSources = sources.browser !== undefined || sources.legSids.length > 0;
  const available = enabled && hasSources && range !== undefined;

  const [segments, setSegments] = useState<CallAudioSegments>(noSegments);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [audible, setAudible] = useState<ReadonlySet<CallAudioTrack>>(DEFAULT_AUDIBLE);
  const [volume, setVolume] = useState(1);
  const [stereo, setStereo] = useState(false);

  // Opens no AudioContext until something is to be heard.
  const [engine] = useState(() => new CallAudioEngine({ fetchAudio: fetchSegmentAudio, onError: setError }));
  useEffect(() => () => engine.dispose(), [engine]);

  const fromMs = range?.from;
  const toMs = range?.to;
  useEffect(() => {
    if (!available || fromMs === undefined || toMs === undefined) {
      return;
    }
    let cancelled = false;
    const load = () => {
      setLoading(true);
      listSessionAudio(JSON.parse(sourcesKey), fromMs, toMs)
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
  }, [available, sourcesKey, fromMs, toMs, live]);

  useEffect(() => engine.setSegments(segments), [engine, segments]);
  useEffect(() => engine.setAudible(audible), [engine, audible]);
  useEffect(() => engine.setVolume(volume), [engine, volume]);
  useEffect(() => engine.setStereo(stereo), [engine, stereo]);
  useClockEffect(clock, (state) => {
    if (available) {
      engine.sync(state);
    }
  });

  const lost = useMemo(() => losses(segments), [segments]);
  const offline = useMemo(() => connectionLost(journey), [journey]);

  return {
    available,
    loading,
    error,
    segments,
    losses: lost,
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
