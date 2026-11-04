import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { AUDIO_SILENCE_THRESHOLD, readingAt, segmentAt, type AudioLevelSegment } from '../../lib/audioLevels';
import { formatClock, formatWallClock } from '../../lib/format';
import { testIds } from '../testIds';

export interface AudioLevelTimelineProps {
  /** Windows as timeline offsets (toTimelineSegments), sorted. */
  segments: AudioLevelSegment[];
  totalMs: number;
  offsetMs: number;
  /** Epoch ms of the recording's start, for the wall-clock time in the readout. */
  startTimeMs?: number;
  onSeek: (offsetMs: number) => void;
}

/** SVG user units across the timeline; the SVG stretches to the timeline's width. */
const WIDTH = 1000;
const ROW_HEIGHT = 28;
const STRIP_HEIGHT = 4;
/** Bars on top, the row's strips (silence, no data) at its bottom, inside the row's band. */
const BAND_HEIGHT = ROW_HEIGHT + 1 + STRIP_HEIGHT;

type Channel = 'agent' | 'customer';

interface Paths {
  avg: string;
  max: string;
  waitAvg: string;
  waitMax: string;
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
 * per phase: with a customer, waiting with the line open, and between calls
 * (idle). The customer row has only time with a customer. Strips below for
 * silence (a window below the dialer's threshold) and for windows without
 * level data, and a shade where the tab was in the background.
 *
 * Where a window carries its 50 ms readings, each reading is placed on its
 * own; otherwise the window's average and maximum cover the whole second.
 * Readings are pooled into COLUMNS columns, so a short session shows every
 * reading and a long one stays a bounded number of shapes.
 */
export function channelPaths(segments: AudioLevelSegment[], channel: Channel, totalMs: number): Paths {
  const paths: Paths = {
    avg: '',
    max: '',
    waitAvg: '',
    waitMax: '',
    idleAvg: '',
    idleMax: '',
    silent: '',
    noData: '',
    hidden: '',
  };
  const columns = { call: new Columns(), waiting: new Columns(), idle: new Columns() };
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
    const phaseColumns = columns[segment.phase];
    if (readings && readings.length > 0) {
      const step = (segment.rawEndOffsetMs - segment.rawStartOffsetMs) / readings.length;
      readings.forEach((reading, index) => {
        const from = segment.rawStartOffsetMs + index * step;
        // Readings outside the recording (a clipped window) are left out.
        if (from + step > 0 && from < totalMs) {
          phaseColumns.add(Math.max(0, from), Math.min(totalMs, from + step), totalMs, reading, reading);
        }
      });
    } else if (avg !== undefined) {
      phaseColumns.add(segment.startOffsetMs, segment.endOffsetMs, totalMs, avg, max ?? avg);
    }
    if (avg !== undefined && avg < AUDIO_SILENCE_THRESHOLD) {
      paths.silent += strip(x1, x2, stripY);
    }
  }
  ({ avg: paths.avg, max: paths.max } = columns.call.paths());
  ({ avg: paths.waitAvg, max: paths.waitMax } = columns.waiting.paths());
  ({ avg: paths.idleAvg, max: paths.idleMax } = columns.idle.paths());
  return paths;
}

const PHASE_NAMES: Record<AudioLevelSegment['phase'], string> = {
  call: 'customer on the line',
  waiting: 'waiting for a call (line open, no customer)',
  idle: 'between calls',
};

function level(value: number | undefined): string {
  return value === undefined ? '–' : value.toFixed(3);
}

/**
 * What the hover readout says about one window: its average and maximum, and
 * where the window carries its readings, the reading under the pointer.
 */
export function describeSegment(segment: AudioLevelSegment, offsetMs?: number): string {
  const parts = [PHASE_NAMES[segment.phase]];
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

interface RowProps {
  label: string;
  /** What the row measures, next to its name. */
  hint: string;
  paths: Paths;
  color: string;
  colors: Colors;
  testId: string;
  totalMs: number;
  onHover: (offsetMs: number | undefined) => void;
  onSeek: (offsetMs: number) => void;
}

interface Colors {
  idle: string;
  silent: string;
  noData: string;
  hidden: string;
}

/**
 * One channel: a header with its colour and name, then its own band with the
 * bars on top and its silence / no-data strips at the bottom, so nothing of
 * one row can be read as belonging to the other. Memoised: it only changes
 * with new levels, never with the playhead.
 */
const Row = React.memo(function Row({ label, hint, paths, color, colors, testId, totalMs, onHover, onSeek }: RowProps) {
  const styles = useStyles2(getStyles);
  const offsetAt = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? ((event.clientX - box.left) / box.width) * totalMs : 0;
  };
  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <span className={styles.swatch} style={{ background: color }} />
        <span className={styles.name}>{label}</span>
        <span className={styles.hint}>{hint}</span>
      </div>
      <svg
        className={styles.band}
        viewBox={`0 0 ${WIDTH} ${BAND_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} level over time`}
        data-testid={testId}
        onMouseMove={(event) => onHover(offsetAt(event))}
        onMouseLeave={() => onHover(undefined)}
        onClick={(event) => onSeek(offsetAt(event))}
      >
        <path d={paths.hidden} fill={colors.hidden} fillOpacity={0.2} />
        <path d={paths.max} fill={color} fillOpacity={0.35} />
        <path d={paths.avg} fill={color} />
        <path d={paths.waitMax} fill={color} fillOpacity={0.12} />
        <path d={paths.waitAvg} fill={color} fillOpacity={0.4} />
        <path d={paths.idleMax} fill={colors.idle} fillOpacity={0.2} />
        <path d={paths.idleAvg} fill={colors.idle} fillOpacity={0.6} />
        <path d={paths.silent} fill={colors.silent} data-testid={`${testId}-silent`} />
        <path d={paths.noData} fill={colors.noData} data-testid={`${testId}-nodata`} />
      </svg>
    </div>
  );
});

/**
 * The dialer's audio levels under the replay timeline: the agent's microphone
 * and, while a customer is on the line, the customer's audio as the agent
 * hears it, each in its own band on the timeline's time axis. Click to jump.
 */
export function AudioLevelTimeline({ segments, totalMs, offsetMs, startTimeMs, onSeek }: AudioLevelTimelineProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [hoverMs, setHoverMs] = useState<number>();
  const agent = useMemo(() => channelPaths(segments, 'agent', totalMs), [segments, totalMs]);
  const customer = useMemo(() => channelPaths(segments, 'customer', totalMs), [segments, totalMs]);
  const hasCustomer = useMemo(() => segments.some((segment) => segment.phase === 'call'), [segments]);
  const colors = useMemo<Colors & { agent: string; customer: string }>(
    () => ({
      agent: theme.visualization.getColorByName('blue'),
      customer: theme.visualization.getColorByName('orange'),
      idle: theme.colors.text.secondary,
      silent: theme.colors.error.main,
      noData: theme.colors.warning.main,
      hidden: theme.colors.text.disabled,
    }),
    [theme]
  );

  if (totalMs <= 0 || segments.length === 0) {
    return null;
  }

  const hovered = hoverMs === undefined ? undefined : segmentAt(segments, hoverMs);
  const playheadPercent = (Math.min(totalMs, Math.max(0, offsetMs)) / totalMs) * 100;
  const hoverTime = (ms: number) =>
    startTimeMs === undefined ? formatClock(ms) : `${formatWallClock(startTimeMs + ms)} (${formatClock(ms)})`;
  const swatch = (color: string, opacity = 1) => (
    <span className={styles.legendSwatch} style={{ background: color, opacity }} />
  );

  return (
    <div className={styles.container} data-testid={testIds.player.audioLevels}>
      <div className={styles.rows}>
        <Row
          label="Agent mic"
          hint="what the agent says"
          paths={agent}
          color={colors.agent}
          colors={colors}
          testId={testIds.player.audioAgent}
          totalMs={totalMs}
          onHover={setHoverMs}
          onSeek={onSeek}
        />
        {hasCustomer && (
          <Row
            label="Customer"
            hint="what the agent hears, while a customer is on the line"
            paths={customer}
            color={colors.customer}
            colors={colors}
            testId={testIds.player.audioCustomer}
            totalMs={totalMs}
            onHover={setHoverMs}
            onSeek={onSeek}
          />
        )}
        {/* An HTML overlay, so moving it repaints a line, not the graph. */}
        <div
          className={styles.playhead}
          style={{ left: `${playheadPercent}%` }}
          data-testid={testIds.player.audioPlayhead}
        />
      </div>
      <div className={styles.readout} aria-live="polite">
        {hovered && hoverMs !== undefined ? (
          <>
            {hoverTime(hoverMs)} · {describeSegment(hovered, hoverMs)}
          </>
        ) : (
          <span className={styles.legend}>
            {swatch(colors.agent)} with customer {swatch(colors.agent, 0.4)} waiting, line open{' '}
            {swatch(colors.idle, 0.6)} between calls {swatch(colors.silent)} silent {swatch(colors.noData)} no level
            data {swatch(colors.hidden, 0.4)} tab in background
            {!hasCustomer && <> · no customer on the line in this recording</>}
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
    gap: theme.spacing(0.5),
    paddingTop: theme.spacing(1),
  }),
  rows: css({ position: 'relative', display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  row: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.25) }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 1.2,
  }),
  swatch: css({ width: 10, height: 10, borderRadius: 2, flexShrink: 0 }),
  name: css({ fontWeight: theme.typography.fontWeightMedium, color: theme.colors.text.primary }),
  hint: css({ color: theme.colors.text.secondary }),
  band: css({
    display: 'block',
    width: '100%',
    height: BAND_HEIGHT,
    cursor: 'pointer',
    background: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
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
  readout: css({
    minHeight: theme.typography.bodySmall.lineHeight,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    fontVariantNumeric: 'tabular-nums',
  }),
  legend: css({ color: theme.colors.text.secondary }),
  legendSwatch: css({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: 2,
    margin: theme.spacing(0, 0.5, 0, 1),
    verticalAlign: 'baseline',
  }),
});
