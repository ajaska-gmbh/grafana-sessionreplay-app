import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import {
  Badge,
  IconButton,
  LinkButton,
  LoadingPlaceholder,
  Tab,
  TabsBar,
  ToolbarButton,
  useStyles2,
} from '@grafana/ui';
import { formatOffset, traceExploreUrl } from '../../lib/format';
import type { JourneyCategory, JourneyEvent } from '../../lib/journey';
import { PlayerClock, useClockValue } from '../../lib/playerClock';

/** Stands in when the journey is shown without a player. */
const STATIC_CLOCK = new PlayerClock();
import { testIds } from '../testIds';

type JourneyTab = 'journey' | 'network';
type JourneyFilter = Exclude<JourneyCategory, 'network'>;

const FILTERS: Array<{ value: JourneyFilter; label: string }> = [
  { value: 'navigation', label: 'Navigation' },
  { value: 'custom', label: 'Custom' },
  { value: 'error', label: 'Errors' },
];

export interface UserJourneyProps {
  events: JourneyEvent[];
  /** Epoch ms of the recording start; offsets are relative to it. */
  recordingStartMs?: number;
  /** The player's time, for "Follow playback"; the list re-renders only when the current event changes. */
  clock?: PlayerClock;
  loading?: boolean;
  tempoUid: string;
  onJump: (event: JourneyEvent) => void;
}

/**
 * Every row is this tall (title and one detail line); only the row whose
 * details are open is measured. Measuring every row re-renders the list once
 * per row as it mounts, which on long lists exceeds React's update limit.
 */
const ROW_PX = 44;
/** Rows rendered beyond the visible ones, so scrolling shows no blank rows. */
const OVERSCAN = 12;
/** The list's size until the browser has measured it: its first paint shows rows. */
const INITIAL_LIST_RECT = { width: 400, height: 600 };

/** Index of the last event at or before the playhead (events sorted by time), by binary search. */
export function currentEventIndex(events: JourneyEvent[], playheadMs: number | undefined): number {
  if (playheadMs === undefined) {
    return -1;
  }
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].timeMs <= playheadMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

const NO_CLOCK_INDEX = () => -1;

/**
 * The session's events beside the player. Only the rows in view are rendered,
 * so a session of many thousand events scrolls and plays as smoothly as a short one.
 */
export const UserJourney = memo(function UserJourney({
  events,
  recordingStartMs,
  clock,
  loading,
  tempoUid,
  onJump,
}: UserJourneyProps) {
  const styles = useStyles2(getStyles);
  const [tab, setTab] = useState<JourneyTab>('journey');
  const [filters, setFilters] = useState<Set<JourneyFilter>>(new Set());
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const journeyEvents = useMemo(() => events.filter((event) => event.category !== 'network'), [events]);
  const networkEvents = useMemo(() => events.filter((event) => event.category === 'network'), [events]);

  const visible = useMemo(() => {
    if (tab === 'network') {
      return networkEvents;
    }
    return filters.size === 0
      ? journeyEvents
      : journeyEvents.filter((event) => filters.has(event.category as JourneyFilter));
  }, [tab, filters, journeyEvents, networkEvents]);

  const selectCurrent = useCallback(
    (state: { offsetMs: number; startTimeMs?: number }) =>
      currentEventIndex(visible, state.startTimeMs === undefined ? undefined : state.startTimeMs + state.offsetMs),
    [visible]
  );
  const current = useClockValueOrNot(clock, selectCurrent);

  const getScrollElement = useCallback(() => listRef.current, []);
  // The open row's height, measured whenever its content changes size.
  const [openHeight, setOpenHeight] = useState(ROW_PX);
  const openObserver = useRef<ResizeObserver | null>(null);
  const measureOpenRow = useCallback((node: HTMLDivElement | null) => {
    openObserver.current?.disconnect();
    openObserver.current = null;
    if (!node) {
      return;
    }
    const read = () => setOpenHeight(Math.max(ROW_PX, Math.ceil(node.getBoundingClientRect().height)));
    read();
    if (typeof ResizeObserver !== 'undefined') {
      openObserver.current = new ResizeObserver(read);
      openObserver.current.observe(node);
    }
  }, []);
  useEffect(() => () => openObserver.current?.disconnect(), []);
  const estimateSize = useCallback(
    (index: number) => (visible[index].id === expanded ? openHeight : ROW_PX),
    [visible, expanded, openHeight]
  );
  const getItemKey = useCallback((index: number) => visible[index].id, [visible]);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement,
    estimateSize,
    overscan: OVERSCAN,
    initialRect: INITIAL_LIST_RECT,
    getItemKey,
  });

  // Row heights changed (a row opened, closed or grew): lay the list out again.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, estimateSize]);

  useEffect(() => {
    if (follow && current >= 0) {
      virtualizer.scrollToIndex(current, { align: 'auto' });
    }
  }, [follow, current, virtualizer]);

  const toggleFilter = (value: JourneyFilter) => {
    setFilters((previous) => {
      const next = new Set(previous);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  return (
    <div className={styles.container} data-testid={testIds.journey.container}>
      <div className={styles.heading}>
        <h4 className={styles.title}>User Journey</h4>
        <ToolbarButton
          icon="history-alt"
          variant={follow ? 'active' : 'canvas'}
          tooltip="Keep the list in sync with the player"
          onClick={() => setFollow(!follow)}
        >
          Follow playback
        </ToolbarButton>
      </div>

      <TabsBar>
        <Tab
          label="Journey"
          counter={journeyEvents.length}
          active={tab === 'journey'}
          onChangeTab={() => setTab('journey')}
        />
        <Tab
          label="Network"
          counter={networkEvents.length}
          active={tab === 'network'}
          onChangeTab={() => setTab('network')}
        />
      </TabsBar>

      {tab === 'journey' && (
        <div className={styles.filters}>
          {FILTERS.map((filter) => (
            <ToolbarButton
              key={filter.value}
              variant={filters.has(filter.value) ? 'active' : 'canvas'}
              onClick={() => toggleFilter(filter.value)}
            >
              {filter.label}
            </ToolbarButton>
          ))}
        </div>
      )}

      <div ref={listRef} className={styles.list}>
        {loading && visible.length === 0 && <LoadingPlaceholder text="Loading events…" />}
        {!loading && visible.length === 0 && <div className={styles.empty}>No events.</div>}
        {visible.length > 0 && (
          <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const event = visible[item.index];
              const index = item.index;
              const offset = recordingStartMs !== undefined ? event.timeMs - recordingStartMs : undefined;
              const isOpen = expanded === event.id;
              return (
                <div
                  key={item.key}
                  ref={isOpen ? measureOpenRow : undefined}
                  data-index={index}
                  className={cx(
                    styles.row,
                    index === current && styles.current,
                    index > current && current >= 0 && styles.future
                  )}
                  style={{ transform: `translateY(${item.start}px)`, height: isOpen ? undefined : ROW_PX }}
                  data-testid={testIds.journey.row}
                >
                  <div className={styles.rowMain}>
                    <span className={styles.offset}>{offset !== undefined ? formatOffset(offset) : ''}</span>
                    <CategoryBadge category={event.category} />
                    <div className={styles.text}>
                      <div className={styles.eventTitle} title={event.title}>
                        {event.title}
                      </div>
                      {event.detail && (
                        <div className={styles.detail} title={event.detail}>
                          {event.detail}
                        </div>
                      )}
                    </div>
                    <IconButton name="play" tooltip="Jump to this event" onClick={() => onJump(event)} />
                    <IconButton
                      name={isOpen ? 'angle-up' : 'info-circle'}
                      tooltip="View event details"
                      onClick={() => setExpanded(isOpen ? null : event.id)}
                    />
                  </div>
                  {isOpen && (
                    <div className={styles.attributes}>
                      {event.traceId && (
                        <LinkButton
                          size="sm"
                          variant="secondary"
                          icon="external-link-alt"
                          href={traceExploreUrl(tempoUid, event.traceId, event.timeMs)}
                          target="_blank"
                        >
                          Open trace {event.traceId.slice(0, 8)}…
                        </LinkButton>
                      )}
                      <table>
                        <tbody>
                          {Object.entries(event.attributes)
                            .filter(([key]) => !key.startsWith('browser_userAgent'))
                            .map(([key, value]) => (
                              <tr key={key}>
                                <td className={styles.attrKey}>{key}</td>
                                <td className={styles.attrValue}>{value}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

/** The current event's index from the clock, or none without a clock. */
function useClockValueOrNot(
  clock: PlayerClock | undefined,
  select: (state: { offsetMs: number; startTimeMs?: number }) => number
) {
  return useClockValue(clock ?? STATIC_CLOCK, clock ? select : NO_CLOCK_INDEX);
}

function CategoryBadge({ category }: { category: JourneyCategory }) {
  switch (category) {
    case 'navigation':
      return <Badge text="Nav" color="blue" />;
    case 'network':
      return <Badge text="HTTP" color="purple" />;
    case 'error':
      return <Badge text="Error" color="red" icon="exclamation-triangle" />;
    default:
      return <Badge text="Event" color="green" />;
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  heading: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing(1, 1, 0, 2),
  }),
  title: css({ margin: 0 }),
  filters: css({ display: 'flex', gap: theme.spacing(0.5), padding: theme.spacing(1, 2, 0) }),
  list: css({ flex: 1, overflowY: 'auto', padding: theme.spacing(1, 0), minHeight: 0 }),
  empty: css({ padding: theme.spacing(2), color: theme.colors.text.secondary }),
  rows: css({ position: 'relative', width: '100%' }),
  row: css({
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    boxSizing: 'border-box',
    overflow: 'hidden',
    padding: theme.spacing(0.5, 2),
    borderLeft: `3px solid transparent`,
    '&:hover': { background: theme.colors.action.hover },
  }),
  current: css({ borderLeftColor: theme.colors.primary.main, background: theme.colors.action.selected }),
  future: css({ opacity: 0.6 }),
  rowMain: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), minWidth: 0 }),
  offset: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    minWidth: 72,
  }),
  text: css({ flex: 1, minWidth: 0 }),
  eventTitle: css({ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
  detail: css({
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  attributes: css({
    margin: theme.spacing(1, 0, 1, 10),
    fontSize: theme.typography.bodySmall.fontSize,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    alignItems: 'flex-start',
    table: { borderCollapse: 'collapse' },
  }),
  attrKey: css({
    color: theme.colors.text.secondary,
    paddingRight: theme.spacing(2),
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
  }),
  attrValue: css({ wordBreak: 'break-all', fontFamily: theme.typography.fontFamilyMonospace }),
});
