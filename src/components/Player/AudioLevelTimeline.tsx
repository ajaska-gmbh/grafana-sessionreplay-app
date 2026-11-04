import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { AUDIO_SILENCE_THRESHOLD, readingAt, segmentAt, type AudioLevelSegment } from '../../lib/audioLevels';
import { formatClock } from '../../lib/format';
import { testIds } from '../testIds';

export interface AudioLevelTimelineProps {
  /** Windows as timeline offsets (toTimelineSegments), sorted. */
  segments: AudioLevelSegment[];
  totalMs: number;
  offsetMs: number;
  onSeek: (offsetMs: number) => void;
}

/** SVG user units across the timeline; the SVG stretches to the timeline's width. */
const WIDTH = 1000;
const ROW_HEIGHT = 28;
const STRIP_HEIGHT = 3;

type Channel = 'agent' | 'customer';

interface Paths {
  avg: string;
  max: string;
  idleAvg: string;
  idleMax: string;
  silent: string;
  noData: string;
  hidden: string;
}

function x(offsetMs: number, totalMs: number): number {
  return (Math.min(totalMs, Math.max(0, offsetMs)) / totalMs) * WIDTH;
}

function bar(x1: number, x2: number, level: number | undefined): string {
  if (level === undefined || x2 <= x1) {
    return '';
  }
  const height = Math.min(1, Math.max(0, level)) * ROW_HEIGHT;
  if (height <= 0) {
    return '';
  }
  return `M${x1.toFixed(2)},${ROW_HEIGHT}V${(ROW_HEIGHT - height).toFixed(2)}H${x2.toFixed(2)}V${ROW_HEIGHT}Z`;
}

function strip(x1: number, x2: number, y: number): string {
  return x2 > x1 ? `M${x1.toFixed(2)},${y}H${x2.toFixed(2)}v${STRIP_HEIGHT}H${x1.toFixed(2)}Z` : '';
}

/** Columns per row: finer than any timeline is wide, coarse enough for hours of 50 ms readings. */
export const COLUMNS = 2000;

/** Per column: the average and the peak of the readings that fall into it. */
class Columns {
  readonly sum = new Float64Array(COLUMNS);
  readonly count = new Uint32Array(COLUMNS);
  readonly max = new Float64Array(COLUMNS);

  /** A level that lasted from `fromMs` to `toMs` on the timeline. */
  add(fromMs: number, toMs: number, totalMs: number, avg: number, max: number) {
    const first = Math.max(0, Math.floor((fromMs / totalMs) * COLUMNS));
    const last = Math.min(COLUMNS - 1, Math.ceil((toMs / totalMs) * COLUMNS) - 1);
    for (let column = first; column <= last; column++) {
      this.sum[column] += avg;
      this.count[column]++;
      if (max > this.max[column]) {
        this.max[column] = max;
      }
    }
  }

  paths(): { avg: string; max: string } {
    let avg = '';
    let max = '';
    const width = WIDTH / COLUMNS;
    for (let column = 0; column < COLUMNS; column++) {
      if (this.count[column] === 0) {
        continue;
      }
      const x1 = column * width;
      avg += bar(x1, x1 + width, this.sum[column] / this.count[column]);
      max += bar(x1, x1 + width, this.max[column]);
    }
    return { avg, max };
  }
}

/**
 * One row's shapes, each as a single path: average (solid) over peak (faint),
 * in a call and between calls (idle, agent only), plus strips below for
 * silence (a window below the dialer's threshold) and for windows without
 * level data, and a shade where the tab was in the background.
 *
 * Where a window carries its 50 ms readings, each reading is placed on its
 * own; otherwise the window's average and maximum cover the whole second.
 * Readings are pooled into COLUMNS columns, so a short session shows every
 * reading and a long one stays a bounded number of shapes.
 */
export function channelPaths(segments: AudioLevelSegment[], channel: Channel, totalMs: number): Paths {
  const paths: Paths = { avg: '', max: '', idleAvg: '', idleMax: '', silent: '', noData: '', hidden: '' };
  const call = new Columns();
  const idle = new Columns();
  const stripY = ROW_HEIGHT + 1;
  for (const segment of segments) {
    if (channel === 'customer' && segment.phase !== 'call') {
      continue;
    }
    const x1 = x(segment.startOffsetMs, totalMs);
    const x2 = x(segment.endOffsetMs, totalMs);
    if ((segment.hiddenRatio ?? 0) > 0) {
      paths.hidden += `M${x1.toFixed(2)},0H${x2.toFixed(2)}V${ROW_HEIGHT}H${x1.toFixed(2)}Z`;
    }
    if (segment.samples === 0) {
      paths.noData += strip(x1, x2, stripY);
      continue;
    }
    const avg = channel === 'agent' ? segment.agentAvg : segment.customerAvg;
    const max = channel === 'agent' ? segment.agentMax : segment.customerMax;
    const readings = channel === 'agent' ? segment.agentLevels : segment.customerLevels;
    const columns = segment.phase === 'idle' ? idle : call;
    if (readings && readings.length > 0) {
      const step = (segment.rawEndOffsetMs - segment.rawStartOffsetMs) / readings.length;
      readings.forEach((reading, index) => {
        const from = segment.rawStartOffsetMs + index * step;
        // Readings outside the recording (a clipped window) are left out.
        if (from + step > 0 && from < totalMs) {
          columns.add(Math.max(0, from), Math.min(totalMs, from + step), totalMs, reading, reading);
        }
      });
    } else if (avg !== undefined) {
      columns.add(segment.startOffsetMs, segment.endOffsetMs, totalMs, avg, max ?? avg);
    }
    if (avg !== undefined && avg < AUDIO_SILENCE_THRESHOLD) {
      paths.silent += strip(x1, x2, stripY);
    }
  }
  ({ avg: paths.avg, max: paths.max } = call.paths());
  ({ avg: paths.idleAvg, max: paths.idleMax } = idle.paths());
  return paths;
}

function level(value: number | undefined): string {
  return value === undefined ? '–' : value.toFixed(3);
}

/**
 * What the hover readout says about one window: its average and maximum, and
 * where the window carries its readings, the reading under the pointer.
 */
export function describeSegment(segment: AudioLevelSegment, offsetMs?: number): string {
  const parts = [segment.phase === 'idle' ? 'between calls' : 'in call'];
  const here = (levels: number[] | undefined) => {
    const reading = offsetMs === undefined ? undefined : readingAt(levels, segment, offsetMs);
    return reading === undefined ? '' : `, here ${level(reading)}`;
  };
  if (segment.samples === 0) {
    parts.push('no level data');
  } else {
    parts.push(`agent mic ${level(segment.agentAvg)} (max ${level(segment.agentMax)}${here(segment.agentLevels)})`);
    if (segment.phase === 'call') {
      parts.push(
        `customer audio ${level(segment.customerAvg)} (max ${level(segment.customerMax)}${here(segment.customerLevels)})`
      );
    }
  }
  if ((segment.hiddenRatio ?? 0) > 0) {
    parts.push(`tab hidden ${Math.round((segment.hiddenRatio ?? 0) * 100)}%`);
  }
  return parts.join(' · ');
}

/**
 * The dialer's audio levels under the replay timeline: the agent's microphone
 * and the call audio the agent hears, each on its own row, on the same time
 * axis as the timeline above. Click to jump there.
 */
export function AudioLevelTimeline({ segments, totalMs, offsetMs, onSeek }: AudioLevelTimelineProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [hoverMs, setHoverMs] = useState<number>();
  const agent = useMemo(() => channelPaths(segments, 'agent', totalMs), [segments, totalMs]);
  const customer = useMemo(() => channelPaths(segments, 'customer', totalMs), [segments, totalMs]);
  const hasCall = useMemo(() => segments.some((segment) => segment.phase === 'call'), [segments]);

  if (totalMs <= 0 || segments.length === 0) {
    return null;
  }

  const hovered = hoverMs === undefined ? undefined : segmentAt(segments, hoverMs);
  const offsetAt = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? ((event.clientX - box.left) / box.width) * totalMs : 0;
  };
  const playhead = x(offsetMs, totalMs);
  const colors = {
    agent: theme.visualization.getColorByName('blue'),
    customer: theme.visualization.getColorByName('green'),
    idle: theme.colors.text.secondary,
    silent: theme.colors.error.main,
    noData: theme.colors.warning.main,
    hidden: theme.colors.text.disabled,
  };

  const row = (label: string, paths: Paths, color: string, testId: string) => (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${WIDTH} ${ROW_HEIGHT + 1 + STRIP_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} level over time`}
        data-testid={testId}
        onMouseMove={(event) => setHoverMs(offsetAt(event))}
        onMouseLeave={() => setHoverMs(undefined)}
        onClick={(event) => onSeek(offsetAt(event))}
      >
        <path d={paths.hidden} fill={colors.hidden} fillOpacity={0.15} />
        <path d={paths.max} fill={color} fillOpacity={0.3} />
        <path d={paths.avg} fill={color} />
        <path d={paths.idleMax} fill={colors.idle} fillOpacity={0.2} />
        <path d={paths.idleAvg} fill={colors.idle} fillOpacity={0.6} />
        <path d={paths.silent} fill={colors.silent} data-testid={`${testId}-silent`} />
        <path d={paths.noData} fill={colors.noData} data-testid={`${testId}-nodata`} />
        <line
          x1={playhead}
          x2={playhead}
          y1={0}
          y2={ROW_HEIGHT + 1 + STRIP_HEIGHT}
          stroke={theme.colors.text.primary}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );

  return (
    <div className={styles.container} data-testid={testIds.player.audioLevels}>
      {row('Agent mic', agent, colors.agent, testIds.player.audioAgent)}
      {hasCall && row('Customer audio', customer, colors.customer, testIds.player.audioCustomer)}
      <div className={styles.readout} aria-live="polite">
        {hovered ? (
          <>
            {formatClock(hoverMs ?? hovered.startOffsetMs)} · {describeSegment(hovered, hoverMs)}
          </>
        ) : (
          <span className={styles.legend}>
            <span style={{ color: colors.silent }}>■</span> silent · <span style={{ color: colors.noData }}>■</span> no
            level data · <span style={{ color: colors.idle }}>■</span> between calls · shaded: tab in background
          </span>
        )}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.25),
    paddingTop: theme.spacing(0.5),
  }),
  row: css({ position: 'relative' }),
  label: css({
    position: 'absolute',
    top: 0,
    left: theme.spacing(0.5),
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    pointerEvents: 'none',
  }),
  svg: css({ display: 'block', width: '100%', height: ROW_HEIGHT + 1 + STRIP_HEIGHT, cursor: 'pointer' }),
  readout: css({
    minHeight: theme.typography.bodySmall.lineHeight,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    fontVariantNumeric: 'tabular-nums',
  }),
  legend: css({ color: theme.colors.text.secondary }),
});
