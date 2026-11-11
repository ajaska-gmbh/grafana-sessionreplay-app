import React, { useMemo, useRef } from 'react';
import { css } from '@emotion/css';
import { dateTimeFormat, GrafanaTheme2 } from '@grafana/data';
import { Tooltip, useStyles2 } from '@grafana/ui';
import { dayGaps, type DayCall, type DaySpan } from '../../lib/agentDay';
import { type PlayerClock, useClockValue } from '../../lib/playerClock';
import { testIds } from '../testIds';

interface Props {
  spans: DaySpan[];
  calls: DayCall[];
  extent: { startMs: number; endMs: number };
  /** Server minus the agent's computer's clock: times of day are shown on the server's clock. */
  clockOffsetMs: number;
  /** The session playing now, highlighted. */
  currentSessionId?: string;
  /** Follows the session player (rrweb time = the agent's computer's clock). */
  clock: PlayerClock;
  /** A searched lead: its calls are marked. */
  highlight?: string;
  onSeek: (atMs: number) => void;
}

/** The agent's whole day on one axis; click anywhere to play from there. */
export function DayTimeline({
  spans,
  calls,
  extent,
  clockOffsetMs,
  currentSessionId,
  clock,
  highlight,
  onSeek,
}: Props) {
  const styles = useStyles2(getStyles);
  const axisRef = useRef<HTMLDivElement>(null);
  const length = Math.max(1, extent.endMs - extent.startMs);
  const pct = (ms: number) => `${(Math.min(Math.max(ms - extent.startMs, 0), length) / length) * 100}%`;
  const width = (from: number, to: number) =>
    `${(Math.max(0, Math.min(to, extent.endMs) - Math.max(from, extent.startMs)) / length) * 100}%`;
  const time = (ms: number) => dateTimeFormat(ms + clockOffsetMs, { format: 'HH:mm:ss' });

  // The playhead in whole seconds: the day axis is far too coarse for more.
  const wallSecond = useClockValue(clock, (state) =>
    state.startTimeMs === undefined ? undefined : Math.floor((state.startTimeMs + state.offsetMs) / 1000)
  );
  const playhead = wallSecond === undefined ? undefined : wallSecond * 1000;

  const gaps = useMemo(() => dayGaps(spans, extent), [spans, extent]);
  const hours = useMemo(() => {
    // Whole hours of local time (any zone offset, DST), on the server's clock.
    const ticks: number[] = [];
    const hour = new Date(extent.startMs + clockOffsetMs);
    hour.setMinutes(0, 0, 0);
    for (
      hour.setHours(hour.getHours() + 1);
      hour.getTime() - clockOffsetMs < extent.endMs;
      hour.setHours(hour.getHours() + 1)
    ) {
      ticks.push(hour.getTime() - clockOffsetMs);
    }
    return ticks;
  }, [extent, clockOffsetMs]);

  const seekAt = (clientX: number) => {
    const axis = axisRef.current;
    if (!axis) {
      return;
    }
    const box = axis.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
    onSeek(extent.startMs + ratio * length);
  };

  return (
    <div className={styles.container} data-testid={testIds.agentDay.timeline}>
      <div className={styles.labels}>
        <span>{time(extent.startMs)}</span>
        {playhead !== undefined && <span className={styles.now}>{time(playhead)}</span>}
        <span>{time(extent.endMs)}</span>
      </div>
      <div
        ref={axisRef}
        className={styles.axis}
        role="slider"
        aria-label="The agent's day"
        aria-valuemin={extent.startMs}
        aria-valuemax={extent.endMs}
        aria-valuenow={playhead ?? extent.startMs}
        aria-valuetext={playhead !== undefined ? time(playhead) : undefined}
        tabIndex={0}
        onClick={(event) => seekAt(event.clientX)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 * 60_000 : 60_000;
          if (playhead !== undefined && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
            event.preventDefault();
            onSeek(playhead + (event.key === 'ArrowRight' ? step : -step));
          }
        }}
      >
        {hours.map((at) => (
          <div key={at} className={styles.hour} style={{ left: pct(at) }}>
            <span>{dateTimeFormat(at + clockOffsetMs, { format: 'HH' })}</span>
          </div>
        ))}
        {gaps.map((gap) => (
          <Tooltip key={gap.fromMs} content={`Not in the app ${time(gap.fromMs)} – ${time(gap.toMs)}`}>
            <div className={styles.gap} style={{ left: pct(gap.fromMs), width: width(gap.fromMs, gap.toMs) }} />
          </Tooltip>
        ))}
        {spans.map((span) => (
          <div
            key={span.session.sessionId}
            data-testid={testIds.agentDay.span}
            className={span.session.sessionId === currentSessionId ? styles.spanCurrent : styles.span}
            style={{ left: pct(span.startMs), width: width(span.startMs, span.endMs) }}
            title={`Session ${span.session.sessionId}: ${time(span.startMs)} – ${time(span.endMs)}`}
          />
        ))}
        {calls.map((call) => {
          const matched = Boolean(highlight) && (call.leadId === highlight || call.crmLeadId === highlight);
          return (
            <Tooltip
              key={`${call.callSid ?? ''}${call.atMs}`}
              content={`Call ${time(call.atMs)}${call.endMs ? ` – ${time(call.endMs)}` : ''}${call.leadId ? ` · lead ${call.leadId}` : ''}`}
            >
              <button
                type="button"
                data-testid={testIds.agentDay.call}
                aria-label={`Call at ${time(call.atMs)}`}
                className={matched ? styles.callMatched : styles.call}
                style={{ left: pct(call.atMs), width: call.endMs ? width(call.atMs, call.endMs) : undefined }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSeek(call.atMs);
                }}
              />
            </Tooltip>
          );
        })}
        {playhead !== undefined && <div className={styles.playhead} style={{ left: pct(playhead) }} />}
      </div>
      <div className={styles.legend}>
        <span className={styles.legendSpan} /> recorded <span className={styles.legendGap} /> not in the app{' '}
        <span className={styles.legendCall} /> call
        {highlight && (
          <>
            {' '}
            <span className={styles.legendMatched} /> call with the searched lead
          </>
        )}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => {
  const bar = { position: 'absolute' as const, top: 18, height: 14, borderRadius: 2 };
  const callBar = {
    position: 'absolute' as const,
    top: 34,
    height: 8,
    minWidth: 3,
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    borderRadius: 1,
  };
  return {
    container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.5), minWidth: 0 }),
    labels: css({
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.text.secondary,
      fontVariantNumeric: 'tabular-nums',
    }),
    now: css({ color: theme.colors.text.primary, fontWeight: theme.typography.fontWeightMedium }),
    axis: css({
      position: 'relative',
      height: 46,
      background: theme.colors.background.secondary,
      borderRadius: theme.shape.radius.default,
      cursor: 'pointer',
      overflow: 'hidden',
      '&:focus-visible': { outline: `2px solid ${theme.colors.primary.main}` },
    }),
    hour: css({
      position: 'absolute',
      top: 0,
      bottom: 0,
      borderLeft: `1px solid ${theme.colors.border.weak}`,
      span: { fontSize: 10, color: theme.colors.text.secondary, paddingLeft: 2 },
    }),
    gap: css({
      ...bar,
      background: `repeating-linear-gradient(45deg, transparent 0 4px, ${theme.colors.border.medium} 4px 5px)`,
    }),
    span: css({
      ...bar,
      background: theme.colors.primary.transparent,
      border: `1px solid ${theme.colors.primary.border}`,
    }),
    spanCurrent: css({ ...bar, background: theme.colors.primary.main }),
    call: css({ ...callBar, background: theme.colors.warning.main }),
    callMatched: css({ ...callBar, background: theme.colors.success.main, top: 32, height: 12 }),
    playhead: css({
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: 2,
      marginLeft: -1,
      background: theme.colors.text.primary,
      pointerEvents: 'none',
    }),
    legend: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(0.5),
      flexWrap: 'wrap',
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.text.secondary,
    }),
    legendSpan: css({ display: 'inline-block', width: 12, height: 8, background: theme.colors.primary.main }),
    legendGap: css({
      display: 'inline-block',
      width: 12,
      height: 8,
      background: `repeating-linear-gradient(45deg, transparent 0 3px, ${theme.colors.border.medium} 3px 4px)`,
    }),
    legendCall: css({ display: 'inline-block', width: 12, height: 8, background: theme.colors.warning.main }),
    legendMatched: css({ display: 'inline-block', width: 12, height: 8, background: theme.colors.success.main }),
  };
};
