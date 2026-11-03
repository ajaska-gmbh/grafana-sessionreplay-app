import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { Replayer } from '@grafana/rrweb';
import './rrweb.css';
import type { eventWithTime } from '@grafana/rrweb-types';
import { GrafanaTheme2 } from '@grafana/data';
import { Dropdown, IconButton, Menu, ToolbarButton, Tooltip, useStyles2, useTheme2 } from '@grafana/ui';
import { formatClock } from '../../lib/format';
import { RRWEB_META } from '../../lib/replayEvents';
import { testIds } from '../testIds';

export const SPEEDS = [0.5, 1, 2, 4, 8];
const SKIP_MS = 10_000;

export interface TimelineMarker {
  offsetMs: number;
  kind: 'error' | 'navigation';
  title: string;
}

export interface SeekRequest {
  offsetMs: number;
  /** Changes on every request so the same offset can be requested twice. */
  nonce: number;
}

export interface ReplayPlayerProps {
  events: eventWithTime[];
  /** Start position in ms from the recording start (the `t` URL parameter). */
  initialOffsetMs?: number;
  seekRequest?: SeekRequest;
  markers?: TimelineMarker[];
  onTimeChange?: (offsetMs: number, startTimeMs: number) => void;
  onShare?: (offsetMs: number) => Promise<void> | void;
  autoPlay?: boolean;
}

interface PageInfo {
  title?: string;
  url?: string;
}

export interface PageChange {
  timestamp: number;
  href?: string;
}

/** Page loads in the recording: every Meta event carries the page URL. */
export function pageChanges(events: eventWithTime[]): PageChange[] {
  return events
    .filter((event) => event.type === RRWEB_META)
    .map((event) => ({ timestamp: event.timestamp, href: (event.data as { href?: string }).href }));
}

/** URL of the page the user was on at `timestamp` (changes sorted by time). */
export function pageAt(changes: PageChange[], timestamp: number): string | undefined {
  let href: string | undefined;
  for (const change of changes) {
    if (change.timestamp > timestamp) {
      break;
    }
    href = change.href;
  }
  return href;
}

/**
 * rrweb replayer with Grafana-style controls: elapsed/total time, play/pause,
 * skip ±10s, timeline, speed, skip inactivity, share link and fullscreen.
 * The page title and URL at the current position are shown above the player.
 */
export function ReplayPlayer({
  events,
  initialOffsetMs = 0,
  seekRequest,
  markers = [],
  onTimeChange,
  onShare,
  autoPlay = false,
}: ReplayPlayerProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const addedRef = useRef<WeakSet<eventWithTime>>(new WeakSet());
  const viewportRef = useRef<{ width: number; height: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  // Read by the effect that appends events, which must not re-run on play/pause.
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [skipInactive, setSkipInactive] = useState(true);
  const [skipping, setSkipping] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [page, setPage] = useState<PageInfo>({});

  const pages = useMemo(() => pageChanges(events), [events]);

  const rescale = useCallback(() => {
    const replayer = replayerRef.current;
    const stage = stageRef.current;
    const viewport = viewportRef.current;
    if (!replayer || !stage || !viewport) {
      return;
    }
    const scale = Math.min(stage.clientWidth / viewport.width, stage.clientHeight / viewport.height, 1);
    replayer.wrapper.style.transform = `scale(${scale})`;
    replayer.wrapper.style.transformOrigin = 'top left';
    replayer.wrapper.style.position = 'absolute';
    replayer.wrapper.style.left = `${Math.max(0, (stage.clientWidth - viewport.width * scale) / 2)}px`;
    replayer.wrapper.style.top = `${Math.max(0, (stage.clientHeight - viewport.height * scale) / 2)}px`;
  }, []);

  const syncTime = useCallback(() => {
    const replayer = replayerRef.current;
    if (!replayer) {
      return;
    }
    const meta = replayer.getMetaData();
    const current = Math.min(replayer.getCurrentTime(), meta.totalTime);
    setOffset(current);
    setTotal(meta.totalTime);
    onTimeChange?.(current, meta.startTime);
    setPage({
      url: pageAt(pages, meta.startTime + current),
      title: replayer.iframe.contentDocument?.title || undefined,
    });
  }, [pages, onTimeChange]);

  // Replayer callbacks are registered once; they read the latest sync via this ref.
  const syncRef = useRef(syncTime);
  useEffect(() => {
    syncRef.current = syncTime;
  }, [syncTime]);

  /** Sync React state with the replayer on the next frame (after it applied a change). */
  const scheduleSync = useCallback(() => {
    requestAnimationFrame(() => syncRef.current());
  }, []);

  const stopTicker = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const startTicker = useCallback(() => {
    stopTicker();
    const tick = () => {
      syncRef.current();
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [stopTicker]);

  // Create the replayer once the first playable events are there; afterwards
  // only append what later Loki pages bring in. Playing state follows the
  // replayer's own start/pause/finish events.
  useEffect(() => {
    if (events.length === 0 || !mountRef.current) {
      return;
    }

    let replayer = replayerRef.current;
    if (!replayer) {
      replayer = new Replayer(events, {
        root: mountRef.current,
        skipInactive,
        speed,
        mouseTail: { strokeStyle: theme.colors.primary.main },
        showWarning: false,
        UNSAFE_replayCanvas: false,
      });
      replayerRef.current = replayer;
      events.forEach((event) => addedRef.current.add(event));

      const onPlay = () => {
        setPlaying(true);
        startTicker();
      };
      const onStop = () => {
        setPlaying(false);
        stopTicker();
        syncRef.current();
      };
      replayer.on('start', onPlay);
      replayer.on('resume', onPlay);
      replayer.on('pause', onStop);
      replayer.on('finish', onStop);
      replayer.on('resize', (dimension) => {
        viewportRef.current = dimension as { width: number; height: number };
        rescale();
      });
      replayer.on('skip-start', () => setSkipping(true));
      replayer.on('skip-end', () => setSkipping(false));

      const start = Math.max(0, initialOffsetMs);
      if (autoPlay) {
        replayer.play(start);
      } else {
        replayer.pause(start);
      }
      scheduleSync();
      return;
    }

    let earliestAdded = Infinity;
    for (const event of events) {
      if (!addedRef.current.has(event)) {
        replayer.addEvent(event);
        addedRef.current.add(event);
        earliestAdded = Math.min(earliestAdded, event.timestamp);
      }
    }
    // rrweb applies an event older than the playhead immediately, out of
    // order (a retried batch can land in a later Loki page). Re-seeking to
    // the current position rebuilds the DOM from the last snapshot instead.
    const meta = replayer.getMetaData();
    const current = replayer.getCurrentTime();
    if (earliestAdded < meta.startTime + current) {
      if (playingRef.current) {
        replayer.play(current);
      } else {
        replayer.pause(current);
      }
    }
    scheduleSync();
    // Creation depends only on the first events; later renders append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  useEffect(
    () => () => {
      stopTicker();
      replayerRef.current?.destroy();
      replayerRef.current = null;
    },
    [stopTicker]
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const observer = new ResizeObserver(() => rescale());
    observer.observe(stage);
    return () => observer.disconnect();
  }, [rescale]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const seek = useCallback(
    (target: number) => {
      const replayer = replayerRef.current;
      if (!replayer) {
        return;
      }
      const clamped = Math.max(0, Math.min(target, replayer.getMetaData().totalTime));
      if (playing) {
        replayer.play(clamped);
      } else {
        replayer.pause(clamped);
      }
      scheduleSync();
    },
    [playing, scheduleSync]
  );

  useEffect(() => {
    if (seekRequest) {
      seek(seekRequest.offsetMs);
    }
    // Only react to new requests, not to seek's identity changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest?.nonce]);

  const togglePlay = () => {
    const replayer = replayerRef.current;
    if (!replayer) {
      return;
    }
    if (playing) {
      replayer.pause();
      return;
    }
    const meta = replayer.getMetaData();
    const current = replayer.getCurrentTime();
    replayer.play(current >= meta.totalTime ? 0 : current);
  };

  const changeSpeed = (value: number) => {
    setSpeed(value);
    replayerRef.current?.setConfig({ speed: value });
  };

  const toggleSkipInactive = () => {
    const next = !skipInactive;
    setSkipInactive(next);
    replayerRef.current?.setConfig({ skipInactive: next });
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current?.requestFullscreen();
    }
  };

  const speedMenu = (
    <Menu>
      {SPEEDS.map((value) => (
        <Menu.Item key={value} label={`${value}x`} active={value === speed} onClick={() => changeSpeed(value)} />
      ))}
    </Menu>
  );

  return (
    <div
      ref={containerRef}
      className={cx(styles.container, fullscreen && styles.fullscreen)}
      data-testid={testIds.player.container}
    >
      <div className={styles.header}>
        <div className={styles.pageTitle}>{page.title ?? 'Untitled page'}</div>
        <div className={styles.pageUrl} title={page.url}>
          {page.url ?? ''}
        </div>
      </div>

      <div ref={stageRef} className={styles.stage}>
        <div ref={mountRef} />
        {skipping && <div className={styles.skipping}>Skipping inactivity…</div>}
      </div>

      <div className={styles.timeline}>
        <input
          type="range"
          aria-label="Timeline"
          className={styles.range}
          min={0}
          max={Math.max(total, 1)}
          step={100}
          value={Math.min(offset, total)}
          onChange={(event) => seek(Number(event.currentTarget.value))}
          data-testid={testIds.player.timeline}
        />
        {total > 0 &&
          markers.map((marker, index) => (
            <Tooltip key={`${marker.offsetMs}-${index}`} content={marker.title}>
              <button
                type="button"
                aria-label={marker.title}
                className={cx(styles.marker, marker.kind === 'error' ? styles.markerError : styles.markerNavigation)}
                style={{ left: `${Math.min(100, Math.max(0, (marker.offsetMs / total) * 100))}%` }}
                onClick={() => seek(marker.offsetMs)}
              />
            </Tooltip>
          ))}
      </div>

      <div className={styles.controls}>
        <span className={styles.clock} data-testid={testIds.player.clock}>
          {formatClock(offset)} / {formatClock(total)}
        </span>
        <IconButton name="backward" tooltip="Skip backward 10 seconds" onClick={() => seek(offset - SKIP_MS)} />
        <IconButton
          name={playing ? 'pause' : 'play'}
          size="xl"
          tooltip={playing ? 'Pause' : 'Play'}
          onClick={togglePlay}
          data-testid={testIds.player.play}
        />
        <IconButton name="forward" tooltip="Skip forward 10 seconds" onClick={() => seek(offset + SKIP_MS)} />
        <div className={styles.spacer} />
        <Dropdown overlay={speedMenu} placement="top">
          <ToolbarButton variant="canvas" tooltip="Playback speed">
            {speed}x
          </ToolbarButton>
        </Dropdown>
        <ToolbarButton
          icon="angle-double-right"
          variant={skipInactive ? 'active' : 'canvas'}
          tooltip="Skip inactivity"
          onClick={toggleSkipInactive}
        >
          Skip inactivity
        </ToolbarButton>
        {onShare && (
          <ToolbarButton
            icon="share-alt"
            variant="canvas"
            tooltip="Copy a link to this moment"
            onClick={() => onShare(offset)}
          >
            Share
          </ToolbarButton>
        )}
        <IconButton
          name={fullscreen ? 'compress-arrows' : 'expand-arrows'}
          tooltip="Toggle fullscreen"
          onClick={toggleFullscreen}
        />
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 420,
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
  }),
  fullscreen: css({ borderRadius: 0, border: 'none' }),
  header: css({
    padding: theme.spacing(1, 2),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    minWidth: 0,
  }),
  pageTitle: css({
    fontWeight: theme.typography.fontWeightMedium,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }),
  pageUrl: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }),
  stage: css({
    position: 'relative',
    flex: 1,
    minHeight: 300,
    overflow: 'hidden',
    background: theme.colors.background.canvas,
    '.replayer-wrapper': { background: '#fff' },
    iframe: { border: 'none', pointerEvents: 'none' },
  }),
  skipping: css({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.35)',
    color: '#fff',
    fontSize: theme.typography.h4.fontSize,
  }),
  timeline: css({ position: 'relative', padding: theme.spacing(1, 2, 0) }),
  range: css({ width: '100%', accentColor: theme.colors.primary.main, cursor: 'pointer' }),
  marker: css({
    position: 'absolute',
    top: theme.spacing(0.25),
    width: 6,
    height: 6,
    marginLeft: -3,
    padding: 0,
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer',
  }),
  markerError: css({ background: theme.colors.error.main }),
  markerNavigation: css({ background: theme.colors.info.main }),
  controls: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 2, 1),
  }),
  clock: css({ fontVariantNumeric: 'tabular-nums', minWidth: 96 }),
  spacer: css({ flex: 1 }),
});
