import React, { useCallback, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AppEvents, GrafanaTheme2 } from '@grafana/data';
import { config, getAppEvents } from '@grafana/runtime';
import { Alert, LoadingPlaceholder, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { useSessionData } from '../../hooks/useSessionData';
import { replayUrl } from '../../lib/format';
import type { JourneyEvent } from '../../lib/journey';
import { UserJourney } from '../Journey/UserJourney';
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
  lokiUid: string;
  tempoUid: string;
  /** Height of the player + journey area; the full-screen page fills the view. */
  height?: number | string;
}

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
  return `${window.location.origin}${config.appSubUrl ?? ''}${path}`;
}

export function SessionReplay(props: SessionReplayProps) {
  const { appName, sessionId, from, to, t, lokiUid, tempoUid, height = '100%' } = props;
  const styles = useStyles2(getStyles);
  const data = useSessionData({ lokiUid, sessionId, from, to });
  const [seekRequest, setSeekRequest] = useState<SeekRequest>();
  const [playheadMs, setPlayheadMs] = useState<number>();
  const [selectedTrack, setSelectedTrack] = useState(props.track ?? 0);

  const track = Math.min(selectedTrack, Math.max(0, data.tracks.length - 1));
  const events = useMemo(() => data.tracks[track] ?? [], [data.tracks, track]);
  const recordingStartMs = events[0]?.timestamp;

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

  const onJump = useCallback(
    (event: JourneyEvent) => {
      if (recordingStartMs !== undefined) {
        setSeekRequest({ offsetMs: event.timeMs - recordingStartMs, nonce: Date.now() });
      }
    },
    [recordingStartMs]
  );

  const onTimeChange = useCallback((offsetMs: number, startTimeMs: number) => {
    setPlayheadMs(startTimeMs + offsetMs);
  }, []);

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
                setPlayheadMs(undefined);
              }}
            />
          </div>
        )}
        {events.length > 0 ? (
          <ReplayPlayer
            key={track}
            events={events}
            initialOffsetMs={track === (props.track ?? 0) ? t : 0}
            seekRequest={seekRequest}
            markers={markers}
            onTimeChange={onTimeChange}
            onShare={onShare}
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
      </div>
      <div className={styles.journey}>
        <UserJourney
          events={data.journey}
          recordingStartMs={recordingStartMs}
          playheadMs={playheadMs}
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
});
