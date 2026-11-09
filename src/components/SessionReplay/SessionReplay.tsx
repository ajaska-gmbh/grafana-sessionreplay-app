import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AppEvents, GrafanaTheme2, locationUtil } from '@grafana/data';
import { getAppEvents } from '@grafana/runtime';
import { Alert, Button, LoadingPlaceholder, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { useSessionData } from '../../hooks/useSessionData';
import { formatClock, replayUrl } from '../../lib/format';
import { linkOffset } from '../../lib/playerEvents';
import { LIVE_WINDOW_MS } from '../../lib/sessionStore';
import { PlayerClock } from '../../lib/playerClock';
import { eventMatches } from '../../lib/sessionSearch';
import type { JourneyEvent } from '../../lib/journey';
import { clockOffsetsOf } from '../../lib/callAudio';
import { UserJourney } from '../Journey/UserJourney';
import { CallAudioTimeline } from '../Player/CallAudioTimeline';
import { useCallAudio } from '../../hooks/useCallAudio';
import type { PayloadBuckets } from '../../lib/sessionBucket';
import { ReplayPlayer, type SeekRequest, type TimelineMarker } from '../Player/ReplayPlayer';
import { testIds } from '../testIds';

export interface SessionReplayProps {
  appName: string;
  sessionId: string;
  from?: number;
  to?: number;
  /** Start offset in ms from the recording start. */
  t?: number;
  /** Which tab to play when the session ran in several tabs at once (0-based). */
  track?: number;
  /** Start in live mode (follow the session as it is recorded). */
  live?: boolean;
  lokiUid: string;
  tempoUid: string;
  /** Whether the call recorder is configured (app config): then the session's call audio is played with it. */
  recorder?: boolean;
  /** A searched value (e.g. a lead id): events carrying it in a search field are marked, the first one is jumped to. */
  highlight?: string;
  searchFields?: string[];
  /** Where the replay payload stream is split by session (app config). */
  payloadBuckets?: PayloadBuckets;
  /** Height of the player + journey area; the full-screen page fills the view. */
  height?: number | string;
}

/** The nonce of the one seek to a search match; the player's own seeks use the time. */
const MATCH_SEEK_NONCE = 1;

/** Absolute link to this session at a given offset (what "Share" copies). */
export function shareLink(
  props: Pick<SessionReplayProps, 'appName' | 'sessionId' | 'from' | 'to' | 'track'>,
  offsetMs: number
) {
  const path = replayUrl(props.appName, props.sessionId, {
    t: offsetMs,
    from: props.from,
    to: props.to,
    track: props.track,
  });
  // assureBaseUrl adds Grafana's sub path (appSubUrl) when Grafana is served below the domain root.
  return `${window.location.origin}${locationUtil.assureBaseUrl(path)}`;
}

/** Wall clock for "is this session still active", refreshed every few seconds. */
function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function SessionReplay(props: SessionReplayProps) {
  const { appName, sessionId, from, to, t, lokiUid, tempoUid, height = '100%' } = props;
  const styles = useStyles2(getStyles);
  const [live, setLive] = useState(props.live ?? false);
  const data = useSessionData({ lokiUid, sessionId, from, to, live, payloadBuckets: props.payloadBuckets });
  const now = useNow();
  const sinceLastEventMs = data.lastReplayMs !== undefined ? now - data.lastReplayMs : undefined;
  const active = sinceLastEventMs !== undefined && sinceLastEventMs < LIVE_WINDOW_MS;
  const [seekRequest, setSeekRequest] = useState<SeekRequest>();
  // The player's time, shared with the journey without re-rendering this view every frame.
  const [clock] = useState(() => new PlayerClock());
  const [selectedTrack, setSelectedTrack] = useState(props.track ?? 0);

  const track = Math.min(selectedTrack, Math.max(0, data.tracks.length - 1));
  const events = useMemo(() => data.tracks[track] ?? [], [data.tracks, track]);
  const recordingStartMs = events[0]?.timestamp;
  // The link's `t` counts from where its own range started; loading may start earlier.
  const linkStartOffset = linkOffset(events, from, t);
  const initialOffsetMs = track !== (props.track ?? 0) ? 0 : (linkStartOffset ?? (data.loadingReplay ? undefined : t));

  const markers = useMemo<TimelineMarker[]>(() => {
    if (recordingStartMs === undefined) {
      return [];
    }
    return data.journey
      .filter((event) => event.category === 'error' || event.category === 'navigation')
      .map((event) => ({
        offsetMs: event.timeMs - recordingStartMs,
        kind: event.category === 'error' ? 'error' : 'navigation',
        title: event.title,
      }));
  }, [data.journey, recordingStartMs]);

  // Times of day are shown on the server's clock: the last offset the agent's computer measured.
  const clockOffsetMs = useMemo(() => clockOffsetsOf(data.journey).at(-1) ?? 0, [data.journey]);
  useEffect(() => clock.update({ clockOffsetMs }), [clock, clockOffsetMs]);

  const { highlight, searchFields } = props;
  const callAudio = useCallAudio({
    journey: data.journey,
    range: data.range,
    clock,
    enabled: Boolean(props.recorder),
    live,
  });
  const seekTo = useCallback((offsetMs: number) => setSeekRequest({ offsetMs, nonce: Date.now() }), []);
  const isHighlighted = useMemo(
    () =>
      highlight && searchFields?.length
        ? (event: JourneyEvent) => eventMatches(event.attributes, searchFields, highlight)
        : undefined,
    [highlight, searchFields]
  );
  // A search result opens where the searched value first appears, unless the link names a time.
  // Derived, with a fixed nonce, so the player seeks there once, however often the journey grows.
  const matchSeek = useMemo<SeekRequest | undefined>(() => {
    if (t !== undefined || !isHighlighted || recordingStartMs === undefined) {
      return undefined;
    }
    const first = data.journey.find(isHighlighted);
    return first ? { offsetMs: Math.max(0, first.timeMs - recordingStartMs), nonce: MATCH_SEEK_NONCE } : undefined;
  }, [t, isHighlighted, recordingStartMs, data.journey]);

  const onJump = useCallback(
    (event: JourneyEvent) => {
      if (recordingStartMs !== undefined) {
        setSeekRequest({ offsetMs: event.timeMs - recordingStartMs, nonce: Date.now() });
      }
    },
    [recordingStartMs]
  );

  const onShare = useCallback(
    async (offsetMs: number) => {
      const range = data.range ?? (from !== undefined && to !== undefined ? { from, to } : undefined);
      const link = shareLink({ appName, sessionId, from: range?.from, to: range?.to, track }, offsetMs);
      try {
        await navigator.clipboard.writeText(link);
        getAppEvents().publish({ type: AppEvents.alertSuccess.name, payload: ['Link to this moment copied'] });
      } catch {
        getAppEvents().publish({ type: AppEvents.alertWarning.name, payload: ['Could not copy the link', link] });
      }
    },
    [appName, sessionId, data.range, from, to, track]
  );

  if (data.error) {
    return (
      <Alert severity="error" title="Could not load the session">
        {data.error}
      </Alert>
    );
  }

  if (data.notFound) {
    return (
      <Alert severity="info" title="No recording found">
        No session replay for session {sessionId} of {appName} in the retained data (14 days).
      </Alert>
    );
  }

  const noRecording = !data.loadingReplay && events.length === 0;

  return (
    <div className={styles.layout} style={{ height }} data-testid={testIds.replay.container}>
      <div className={styles.player}>
        {data.tracks.length > 1 && (
          <div className={styles.tracks}>
            <span>This session was open in {data.tracks.length} tabs at the same time:</span>
            <RadioButtonGroup
              size="sm"
              options={data.tracks.map((_, index) => ({ label: `Tab ${index + 1}`, value: index }))}
              value={track}
              onChange={(value) => {
                setSelectedTrack(value);
                clock.update({ offsetMs: 0, totalMs: 0, startTimeMs: undefined });
              }}
            />
          </div>
        )}
        {(active || live) && events.length > 0 && (
          <div className={styles.liveBar}>
            {live ? (
              <span>
                Following the session live (new events every few seconds).
                {sinceLastEventMs !== undefined && sinceLastEventMs > 30_000 && (
                  <> No new recording data for {formatClock(sinceLastEventMs)}: the user may be idle or gone.</>
                )}
                {data.liveError && <> Last update failed, retrying: {data.liveError}</>}
              </span>
            ) : (
              <>
                <span>This session is still being recorded.</span>
                <Button size="sm" variant="destructive" icon="circle-mono" onClick={() => setLive(true)}>
                  Go live
                </Button>
              </>
            )}
          </div>
        )}
        {events.length > 0 && initialOffsetMs !== undefined ? (
          <ReplayPlayer
            key={`${track}-${live ? 'live' : 'replay'}`}
            events={events}
            initialOffsetMs={initialOffsetMs}
            seekRequest={seekRequest ?? matchSeek}
            markers={markers}
            audioLevels={data.audioLevels}
            clock={clock}
            belowTimeline={
              callAudio.available ? <CallAudioTimeline audio={callAudio} clock={clock} onSeek={seekTo} /> : undefined
            }
            onShare={onShare}
            live={live}
            liveReceivedAtMs={data.lastReplayMs}
            onExitLive={() => setLive(false)}
          />
        ) : noRecording ? (
          <Alert severity="info" title="Nothing to replay">
            This session has no complete recording (no full page snapshot) in the selected time range.
          </Alert>
        ) : (
          <LoadingPlaceholder text="Loading recording…" />
        )}
        {data.skippedEvents > 0 && (
          <div className={styles.note}>
            {data.skippedEvents} recording events could not be decoded and were skipped.
          </div>
        )}
        {data.unresolvedStylesheets > 0 && (
          <div className={styles.note}>
            {data.unresolvedStylesheets} stylesheets of this recording could not be restored
            {data.droppedStylesheets > 0 && ` (${data.droppedStylesheets} exceeded the viewer's memory limit)`}; parts
            of the page may look unstyled.
          </div>
        )}
      </div>
      <div className={styles.journey}>
        <UserJourney
          events={data.journey}
          recordingStartMs={recordingStartMs}
          clock={clock}
          isHighlighted={isHighlighted}
          loading={data.loadingJourney}
          tempoUid={tempoUid}
          onJump={onJump}
        />
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  layout: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)',
    gap: theme.spacing(2),
    minHeight: 520,
    [theme.breakpoints.down('lg')]: { gridTemplateColumns: '1fr', height: 'auto !important' },
  }),
  player: css({ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  journey: css({ minWidth: 0, minHeight: 0, [theme.breakpoints.down('lg')]: { height: 480 } }),
  note: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  tracks: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), flexWrap: 'wrap' }),
  liveBar: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
    color: theme.colors.text.secondary,
  }),
});
