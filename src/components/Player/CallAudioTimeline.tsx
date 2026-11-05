import React, { useMemo, useRef } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Checkbox, useStyles2, useTheme2 } from '@grafana/ui';
import type { CallAudio } from '../../hooks/useCallAudio';
import { MAX_AUDIBLE_SPEED } from '../../lib/audioEngine';
import { coverage, type CallAudioTrack, type Interval } from '../../lib/callAudio';
import { formatWallClock } from '../../lib/format';
import { type PlayerClock, useClockEffect, useClockValue } from '../../lib/playerClock';
import { testIds } from '../testIds';

export interface CallAudioTimelineProps {
  audio: CallAudio;
  /** The player's time: the rows' axis is the recording's length from its start. */
  clock: PlayerClock;
  onSeek: (offsetMs: number) => void;
}

interface RowSpec {
  track: CallAudioTrack;
  label: string;
  hint: string;
  /** The losses this row marks. */
  lost?: 'uplink' | 'downlink';
}

const ROWS: RowSpec[] = [
  { track: 'mic', label: 'Agent mic', hint: "the agent's microphone, recorded on their computer (also between calls)" },
  { track: 'customer', label: 'Customer', hint: 'what the carrier sent the agent' },
  {
    track: 'agent',
    label: 'Agent at carrier',
    hint: "the agent as the carrier received them; red where their words did not arrive (the agent's uplink)",
    lost: 'uplink',
  },
  {
    track: 'heard',
    label: 'Heard by agent',
    hint: "what the agent's computer played; red where the customer did not reach it (the agent's downlink)",
    lost: 'downlink',
  },
];

/**
 * The call audio under the replay's timeline, on its axis: what each track
 * has, where the carrier sent nothing, and where audio was lost on the way
 * between the agent's computer and the carrier. Click to jump, the speaker to
 * listen to a track or not.
 */
export function CallAudioTimeline({ audio, clock, onSeek }: CallAudioTimelineProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const playheadRef = useRef<HTMLDivElement>(null);
  const speed = useClockValue(clock, (state) => state.speed);
  const totalMs = useClockValue(clock, (state) => state.totalMs);
  const startTimeMs = useClockValue(clock, (state) => state.startTimeMs);
  useClockEffect(clock, (state) => {
    if (playheadRef.current && totalMs > 0) {
      playheadRef.current.style.left = `${(Math.min(totalMs, Math.max(0, state.offsetMs)) / totalMs) * 100}%`;
    }
  });

  const covered = useMemo(
    () =>
      Object.fromEntries(ROWS.map((row) => [row.track, coverage(audio.segments[row.track])])) as Record<
        CallAudioTrack,
        Interval[]
      >,
    [audio.segments]
  );
  const gaps = useMemo(
    () =>
      Object.fromEntries(ROWS.map((row) => [row.track, audio.segments[row.track].flatMap((s) => s.gaps)])) as Record<
        CallAudioTrack,
        Interval[]
      >,
    [audio.segments]
  );

  if (startTimeMs === undefined || totalMs <= 0) {
    return null;
  }

  const place = (interval: Interval) => {
    const left = Math.max(0, (interval.startMs - startTimeMs) / totalMs);
    const right = Math.min(1, (interval.endMs - startTimeMs) / totalMs);
    return right > left ? { left: `${left * 100}%`, width: `${(right - left) * 100}%` } : undefined;
  };
  const bars = (
    intervals: Interval[],
    className: string,
    options: { title?: (i: Interval) => string; style?: React.CSSProperties } = {}
  ) =>
    intervals.map((interval) => {
      const position = place(interval);
      return position ? (
        <div
          key={`${interval.startMs}-${interval.endMs}`}
          className={className}
          style={{ ...options.style, ...position }}
          title={options.title?.(interval)}
        />
      ) : null;
    });
  const span = (i: Interval) => `${formatWallClock(i.startMs)}–${formatWallClock(i.endMs)}`;
  const seekAt = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(((event.clientX - box.left) / box.width) * totalMs);
  };
  const color: Record<CallAudioTrack, string> = {
    mic: theme.visualization.getColorByName('blue'),
    agent: theme.visualization.getColorByName('blue'),
    customer: theme.visualization.getColorByName('orange'),
    heard: theme.visualization.getColorByName('orange'),
  };
  const tooFast = speed > MAX_AUDIBLE_SPEED;

  return (
    <div className={styles.container} data-testid={testIds.player.callAudio}>
      <div className={styles.rows}>
        {ROWS.filter((row) => audio.segments[row.track].length > 0).map((row) => {
          const on = audio.audible.has(row.track);
          return (
            <div key={row.track} className={styles.row} data-testid={testIds.player.callAudioRow(row.track)}>
              <div className={styles.header}>
                <Checkbox
                  value={on}
                  aria-label={on ? `Mute ${row.label}` : `Listen to ${row.label}`}
                  title={on ? 'Heard: click to mute' : 'Muted: click to listen'}
                  onChange={() => audio.toggle(row.track)}
                />
                <span className={cx(styles.name, !on && styles.muted)}>{row.label}</span>
                <span className={styles.hint}>{row.hint}</span>
              </div>
              <div className={styles.strip} onClick={seekAt}>
                {bars(covered[row.track], styles.bar, {
                  style: { background: color[row.track], opacity: on ? 0.8 : 0.35 },
                })}
                {bars(gaps[row.track], cx(styles.bar, styles.gap), {
                  title: (i) => `The carrier sent nothing ${span(i)}`,
                })}
                {row.lost &&
                  bars(audio.losses[row.lost], cx(styles.bar, styles.lost), {
                    title: (i) =>
                      `${row.lost === 'uplink' ? "The agent's words did not reach the carrier" : "The customer did not reach the agent's computer"} ${span(i)}`,
                  })}
                {bars(audio.connectionLost, cx(styles.bar, styles.offline), {
                  title: (i) => `The agent's browser had no network ${span(i)}`,
                })}
              </div>
            </div>
          );
        })}
        <div ref={playheadRef} className={styles.playhead} />
      </div>
      <div className={styles.footer}>
        <span className={styles.legend}>
          <span className={styles.swatch} style={{ background: theme.colors.error.main }} /> lost on the way{' '}
          <span className={cx(styles.swatch, styles.offlineSwatch)} /> no network in the browser{' '}
          <span className={cx(styles.swatch, styles.gapSwatch)} /> carrier sent nothing
          {tooFast && <> · muted above {MAX_AUDIBLE_SPEED}x</>}
          {audio.error && <> · {audio.error}</>}
        </span>
        <label className={styles.control}>
          Volume
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={audio.volume}
            onChange={(event) => audio.setVolume(Number(event.currentTarget.value))}
            aria-label="Call audio volume"
          />
        </label>
        <label className={styles.control}>
          <input
            type="checkbox"
            checked={audio.stereo}
            onChange={(event) => audio.setStereo(event.currentTarget.checked)}
          />
          Agent left, customer right
        </label>
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.5), paddingTop: theme.spacing(1) }),
  rows: css({ position: 'relative', display: 'flex', flexDirection: 'column', gap: theme.spacing(0.75) }),
  row: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.25) }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 1.2,
  }),
  name: css({ fontWeight: theme.typography.fontWeightMedium, color: theme.colors.text.primary, whiteSpace: 'nowrap' }),
  muted: css({ color: theme.colors.text.disabled }),
  hint: css({ color: theme.colors.text.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
  strip: css({
    position: 'relative',
    height: 10,
    background: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
    cursor: 'pointer',
    overflow: 'hidden',
  }),
  bar: css({ position: 'absolute', top: 0, bottom: 0 }),
  gap: css({ background: theme.colors.text.disabled }),
  lost: css({ background: theme.colors.error.main }),
  offline: css({
    background: `repeating-linear-gradient(45deg, ${theme.colors.error.transparent}, ${theme.colors.error.transparent} 3px, transparent 3px, transparent 6px)`,
  }),
  playhead: css({
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    background: theme.colors.text.primary,
    pointerEvents: 'none',
  }),
  footer: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    flexWrap: 'wrap',
  }),
  legend: css({ flex: 1 }),
  swatch: css({ display: 'inline-block', width: 10, height: 8, borderRadius: 2, verticalAlign: 'middle' }),
  offlineSwatch: css({
    background: `repeating-linear-gradient(45deg, ${theme.colors.error.main}, ${theme.colors.error.main} 2px, transparent 2px, transparent 4px)`,
  }),
  gapSwatch: css({ background: theme.colors.text.disabled }),
  control: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(0.5) }),
});
