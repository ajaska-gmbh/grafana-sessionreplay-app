import React, { useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { IconButton, Tooltip, useStyles2 } from '@grafana/ui';
import { formatOffset } from '../../lib/format';
import type { JourneyEvent } from '../../lib/journey';
import {
  FUNNEL_STEPS,
  KIND_LABELS,
  STEP_LABELS,
  type Insight,
  type InsightKind,
  type SessionInsights,
  type Severity,
} from '../../lib/insights';
import { testIds } from '../testIds';

/** A jump lands this much before the moment, so the lead-up is seen. */
export const LEAD_MS = 1500;

export interface InsightsPanelProps {
  summary: SessionInsights;
  recordingStartMs?: number;
  /** Index of the insight at the playhead, -1 before the first. */
  current: number;
  onJump: (event: JourneyEvent) => void;
}

/**
 * The session's problems, in time order: what to watch first. The funnel
 * shows how far the visitor got; the kind chips count and filter.
 */
export function InsightsPanel({ summary, recordingStartMs, current, onJump }: InsightsPanelProps) {
  const styles = useStyles2(getStyles);
  const [kind, setKind] = useState<InsightKind>();
  const shown = useMemo(
    () => (kind ? summary.insights.filter((found) => found.kind === kind) : summary.insights),
    [summary.insights, kind]
  );
  const kinds = Object.entries(summary.counts) as Array<[InsightKind, number]>;
  const tap = summary.touch ? 'Phone or tablet' : 'Desktop';
  const jump = (found: Insight) => onJump({ ...found.event, timeMs: found.timeMs - LEAD_MS });

  return (
    <div className={styles.container} data-testid={testIds.insights.container}>
      {summary.steps.length > 0 && (
        <div className={styles.funnel} aria-label="Funnel">
          {FUNNEL_STEPS.filter((step) => step !== 'checkout_blocked' || summary.steps.includes(step)).map((step) => {
            const reached = summary.steps.includes(step);
            return (
              <span
                key={step}
                className={cx(
                  styles.step,
                  reached && styles.reached,
                  step === summary.outcome && styles.outcome,
                  step === 'checkout_blocked' && styles.blocked,
                  step === 'purchase' && reached && styles.bought
                )}
                data-testid={testIds.insights.step}
              >
                {STEP_LABELS[step]}
              </span>
            );
          })}
        </div>
      )}
      <div className={styles.meta}>
        <span>{tap}</span>
        {!summary.detector && summary.insights.some((found) => found.event.attributes.source === 'recording') && (
          <Tooltip content="This recording was made without the shop's tap detector: dead and rage taps were found in the recording itself (only in the parts loaded so far).">
            <span className={styles.hint}>taps from the recording</span>
          </Tooltip>
        )}
      </div>
      {kinds.length > 0 && (
        <div className={styles.chips} role="group" aria-label="Filter insights">
          {kinds.map(([name, count]) => (
            <button
              key={name}
              type="button"
              aria-pressed={kind === name}
              className={cx(styles.chip, kind === name && styles.chipActive)}
              onClick={() => setKind(kind === name ? undefined : name)}
              data-testid={testIds.insights.chip}
            >
              <span className={cx(styles.dot, styles[worst(summary.insights, name)])} />
              {KIND_LABELS[name]}
              <span className={styles.count}>{count}</span>
            </button>
          ))}
        </div>
      )}
      <div className={styles.list}>
        {shown.length === 0 && (
          <div className={styles.empty}>
            No problems found: no dead or rage taps, form errors, JS errors, failed requests or slow pages
            {summary.detector ? '' : ' in what is loaded so far'}.
          </div>
        )}
        {shown.map((found) => {
          const index = summary.insights.indexOf(found);
          return (
            <div
              key={found.id}
              className={cx(
                styles.row,
                index === current && styles.current,
                index > current && current >= 0 && styles.future
              )}
              data-testid={testIds.insights.row}
            >
              <span className={cx(styles.dot, styles[found.severity])} aria-label={`${found.severity} severity`} />
              <span className={styles.offset}>
                {recordingStartMs !== undefined ? formatOffset(found.timeMs - recordingStartMs) : ''}
              </span>
              <button type="button" className={styles.text} onClick={() => jump(found)}>
                <span className={styles.title} title={found.title}>
                  {found.title}
                </span>
                {found.detail && (
                  <span className={styles.detail} title={found.detail}>
                    {found.detail}
                  </span>
                )}
              </button>
              <IconButton name="play" tooltip="Watch this moment" onClick={() => jump(found)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function worst(insights: readonly Insight[], kind: InsightKind): Severity {
  const order: Severity[] = ['high', 'medium', 'low', 'info'];
  return insights
    .filter((found) => found.kind === kind)
    .reduce<Severity>(
      (best, found) => (order.indexOf(found.severity) < order.indexOf(best) ? found.severity : best),
      'info'
    );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1), minHeight: 0, flex: 1 }),
  funnel: css({ display: 'flex', flexWrap: 'wrap', gap: 2, padding: theme.spacing(1, 2, 0) }),
  step: css({
    fontSize: theme.typography.bodySmall.fontSize,
    padding: theme.spacing(0.25, 1),
    color: theme.colors.text.disabled,
    background: theme.colors.background.secondary,
    '&:first-child': { borderRadius: `${theme.shape.radius.default} 0 0 ${theme.shape.radius.default}` },
    '&:last-child': { borderRadius: `0 ${theme.shape.radius.default} ${theme.shape.radius.default} 0` },
  }),
  reached: css({ color: theme.colors.text.primary, background: theme.colors.action.selected }),
  outcome: css({
    fontWeight: theme.typography.fontWeightMedium,
    boxShadow: `inset 0 -2px 0 ${theme.colors.primary.main}`,
  }),
  blocked: css({ boxShadow: `inset 0 -2px 0 ${theme.colors.error.main}` }),
  bought: css({ boxShadow: `inset 0 -2px 0 ${theme.colors.success.main}` }),
  meta: css({
    display: 'flex',
    gap: theme.spacing(1),
    padding: theme.spacing(0, 2),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  hint: css({ textDecoration: 'underline dotted', cursor: 'help' }),
  chips: css({ display: 'flex', flexWrap: 'wrap', gap: theme.spacing(0.5), padding: theme.spacing(0, 2) }),
  chip: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    padding: theme.spacing(0.25, 1),
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.primary,
    background: 'transparent',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.pill,
    cursor: 'pointer',
    '&:hover': { background: theme.colors.action.hover },
  }),
  chipActive: css({ background: theme.colors.action.selected, borderColor: theme.colors.border.strong }),
  count: css({ fontVariantNumeric: 'tabular-nums', color: theme.colors.text.secondary }),
  list: css({ flex: 1, overflowY: 'auto', minHeight: 0, paddingBottom: theme.spacing(1) }),
  empty: css({ padding: theme.spacing(1, 2), color: theme.colors.text.secondary }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minHeight: 40,
    padding: theme.spacing(0.25, 2),
    borderLeft: '3px solid transparent',
    '&:hover': { background: theme.colors.action.hover },
  }),
  current: css({ borderLeftColor: theme.colors.primary.main, background: theme.colors.action.selected }),
  future: css({ opacity: 0.7 }),
  dot: css({ width: 8, height: 8, borderRadius: '50%', flex: 'none' }),
  high: css({ background: theme.colors.error.main }),
  medium: css({ background: theme.colors.warning.main }),
  low: css({ background: theme.colors.info.main }),
  info: css({ background: theme.colors.text.disabled }),
  offset: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    minWidth: 56,
  }),
  text: css({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  }),
  title: css({ maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
  detail: css({
    maxWidth: '100%',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
