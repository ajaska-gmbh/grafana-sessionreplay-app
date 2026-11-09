import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { Replayer } from '@grafana/rrweb';
import './rrweb.css';
import type { eventWithTime } from '@grafana/rrweb-types';
import { GrafanaTheme2 } from '@grafana/data';
import {
  Badge,
  Dropdown,
  Icon,
  IconButton,
  Input,
  Menu,
  ToolbarButton,
  Tooltip,
  useStyles2,
  useTheme2,
} from '@grafana/ui';
import { toTimelineSegments, type AudioLevelWindow } from '../../lib/audioLevels';
import { formatClock, formatWallClock, wallClockOffset } from '../../lib/format';
import { liveStartIndex, pageAt } from '../../lib/playerEvents';
import type { ReplayTrack } from '../../lib/replayEvents';
import {
  afterRun,
  chunkIndexAt,
  isReady,
  readyAt,
  withDependencies,
  trackLength,
  TrackFeed,
  unloadedSpans,
} from '../../lib/replayFeed';
import { PlayerClock, useClockEffect, useClockValue } from '../../lib/playerClock';
import { testIds } from '../testIds';
import { AudioLevelTimeline } from './AudioLevelTimeline';

export const SPEEDS = [0.5, 1, 2, 4, 8];
const SKIP_MS = 10_000;
/** Live playback trails the newest event by this much, so late batches still play in order. */
export const LIVE_BUFFER_MS = 3000;

/** Half the width of the range input's thumb (16 px in Chromium and Firefox). */
const THUMB_INSET_PX = 8;

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
  /** The tab to play: its full length is known, its chunks fill in as they load. */
  track: ReplayTrack;
  /** Start position in ms from the recording start (the `t` URL parameter). */
  initialOffsetMs?: number;
  seekRequest?: SeekRequest;
  markers?: TimelineMarker[];
  /** The dialer's per-second audio levels, drawn under the timeline (epoch ms). */
  audioLevels?: AudioLevelWindow[];
  /** Where the player writes its time; others (journey, call audio) follow it. One of its own when not given. */
  clock?: PlayerClock;
  /** More rows on the timeline's axis, under the level graph (the call audio); they follow `clock`. */
  belowTimeline?: React.ReactNode;
  onShare?: (offsetMs: number) => Promise<void> | void;
  /** Where playback is or is going (seeks, the playhead entering another chunk): load there first. */
  onTarget?: (offsetMs: number) => void;
  autoPlay?: boolean;
  /**
   * Follow the session as it is recorded: starts at the last full snapshot and
   * plays every appended event LIVE_BUFFER_MS behind the newest one.
   */
  live?: boolean;
  /** Live: Loki receive time (epoch ms) of the newest event, to estimate the real lag. */
  liveReceivedAtMs?: number;
  onExitLive?: () => void;
}

interface PageInfo {
  title?: string;
  url?: string;
}

/** Why the stage shows no playback right now. */
type Waiting = 'loading' | 'failed' | 'empty' | undefined;

/** Finishing this close to the end is the end; earlier, the next chunk is still loading. */
const END_TOLERANCE_MS = 1000;
const WAITING_TEXT = {
  loading: 'Loading…',
  failed: 'This part of the recording could not be loaded. Seek here again to retry.',
  empty: 'Nothing was recorded here.',
};
const LIVE_WAITING_TEXT = {
  ...WAITING_TEXT,
  failed: 'The newest part of the recording could not be loaded yet; retrying…',
};

/** A timeline drag asks the loader for its target once the thumb rested this long. */
export const FOCUS_DEBOUNCE_MS = 250;

/**
 * rrweb replayer with Grafana-style controls: elapsed/total time, play/pause,
 * skip ±10s, timeline, speed, skip inactivity, share link and fullscreen.
 * The page title and URL at the current position are shown above the player.
 *
 * The track loads progressively: length, seek range and markers come from its
 * index at once; the replayer starts once the chunk at the start position is
 * loaded, chunks join it as they arrive (see TrackFeed), and playback pauses
 * with "Loading…" where it reaches a part not loaded yet, resuming when it is.
 */
export function ReplayPlayer({
  track,
  initialOffsetMs = 0,
  seekRequest,
  markers = [],
  audioLevels = [],
  clock: givenClock,
  belowTimeline,
  onShare,
  onTarget,
  autoPlay = false,
  live = false,
  liveReceivedAtMs,
  onExitLive,
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
  const rangeRef = useRef<HTMLInputElement>(null);
  const [ownClock] = useState(() => new PlayerClock());
  const clock = givenClock ?? ownClock;

  // The latest track for callbacks registered once (replayer events, the ticker).
  const trackRef = useRef(track);
  const [feed] = useState(() => new TrackFeed(track));
  /** Where to start once the replayer can be created (seeks before that move it). */
  const pendingOffsetRef = useRef(Math.max(0, initialOffsetMs));
  /** Playback paused at a part still loading: where, and from where on it must be loaded to go on. */
  const waitRef = useRef<{ offsetMs: number; untilMs: number } | null>(null);
  const [waiting, setWaiting] = useState<Waiting>(undefined);
  const onTargetRef = useRef(onTarget);
  const focusedChunkRef = useRef(-1);
  useEffect(() => {
    onTargetRef.current = onTarget;
  }, [onTarget]);

  const [playing, setPlaying] = useState(false);
  /** The user wants playback (also while it waits for a chunk). */
  const [wantPlay, setWantPlay] = useState(autoPlay);
  const wantPlayRef = useRef(autoPlay);
  const setWant = useCallback((value: boolean) => {
    wantPlayRef.current = value;
    setWantPlay(value);
  }, []);
  useEffect(() => {
    clock.update({ playing });
  }, [playing, clock]);
  // Only what is shown re-renders: the whole second, the length, the start. The
  // range input follows every frame through its ref (see the clock effect below).
  const second = useClockValue(clock, (state) => Math.floor(state.offsetMs / 1000));
  const startTime = useClockValue(clock, (state) => state.startTimeMs);
  const liveTotal = useClockValue(clock, (state) => state.totalMs);
  const clockOffset = useClockValue(clock, (state) => state.clockOffsetMs);
  /** The track's length from its index (live: what the replayer has). */
  const total = live ? liveTotal : trackLength(track);
  /** The recording start on the server's clock: every time of day shown or typed counts from it. */
  const startTimeOfDay = startTime === undefined ? undefined : startTime + clockOffset;
  const offset = second * 1000;
  /** The "go to" field: what is typed, and whether the last attempt failed. */
  const [goTo, setGoTo] = useState('');
  const [goToInvalid, setGoToInvalid] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skipInactive, setSkipInactive] = useState(true);
  // Read when the replayer is created, which happens outside render.
  const speedRef = useRef(1);
  const skipInactiveRef = useRef(true);
  const [skipping, setSkipping] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [page, setPage] = useState<PageInfo>({});
  /** Live: how far playback trails the newest received event (ms). */
  const [liveLagMs, setLiveLagMs] = useState(0);
  const newestEventRef = useRef(0);
  /** Live: rrweb time of the snapshot live playback started from. */
  const liveBaselineRef = useRef(Infinity);
  const receivedAtRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    receivedAtRef.current = liveReceivedAtMs;
  }, [liveReceivedAtMs]);

  /** Live plays one flat list, from the newest snapshot on. */
  const liveEvents = useMemo(() => (live ? track.chunks.flatMap((chunk) => chunk.events) : []), [live, track]);
  /** Live waits for the newest chunk (and what it depends on); live polling retries it. */
  const liveWaiting = useMemo((): Waiting => {
    if (!live || track.chunks.length === 0) {
      return undefined;
    }
    const newest = withDependencies(track, track.chunks.length - 1);
    if (newest.every((chunk) => chunk.loaded)) {
      return undefined;
    }
    return newest.some((chunk) => chunk.failed) ? 'failed' : 'loading';
  }, [live, track]);
  const shownWaiting = live ? liveWaiting : waiting;
  const unloaded = useMemo(() => (live ? [] : unloadedSpans(track)), [live, track]);
  const audioSegments = useMemo(
    () => (startTime === undefined || total <= 0 ? [] : toTimelineSegments(audioLevels, startTime, total)),
    [audioLevels, startTime, total]
  );

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
    if (live) {
      // In live mode rrweb adds events asynchronously; its metadata needs at least one.
      if (!replayer || replayer.service.state.context.events.length === 0) {
        return;
      }
      const meta = replayer.getMetaData();
      const current = Math.min(replayer.getCurrentTime(), meta.totalTime);
      clock.update({ offsetMs: current, totalMs: meta.totalTime, startTimeMs: meta.startTime });
      // Playback trails the newest event (buffer), which itself arrived some time ago.
      const behindNewest = Math.max(0, newestEventRef.current - (meta.startTime + replayer.getCurrentTime()));
      const sinceReceived = receivedAtRef.current !== undefined ? Math.max(0, Date.now() - receivedAtRef.current) : 0;
      const lag = behindNewest + sinceReceived;
      setLiveLagMs((previous) => (Math.round(previous / 1000) === Math.round(lag / 1000) ? previous : lag));
      const url = pageAt(trackRef.current.pages, meta.startTime + current);
      const title = replayer.iframe.contentDocument?.title || undefined;
      setPage((previous) => (previous.url === url && previous.title === title ? previous : { url, title }));
      return;
    }
    const current = trackRef.current;
    const length = trackLength(current);
    const offsetMs = Math.min(replayer ? replayer.getCurrentTime() : pendingOffsetRef.current, length);
    clock.update({ offsetMs, totalMs: length, startTimeMs: current.startMs });
    const url = pageAt(current.pages, current.startMs + offsetMs);
    const title = replayer?.iframe.contentDocument?.title || undefined;
    setPage((previous) => (previous.url === url && previous.title === title ? previous : { url, title }));
  }, [live, clock]);

  // The timeline's thumb follows every frame without re-rendering the player.
  useClockEffect(clock, (state) => {
    if (rangeRef.current) {
      rangeRef.current.value = String(Math.min(state.offsetMs, state.totalMs));
    }
  });

  // Replayer callbacks are registered once; they read the latest sync via this ref.
  const syncRef = useRef(syncTime);
  useEffect(() => {
    syncRef.current = syncTime;
  }, [syncTime]);

  /** Sync React state with the replayer on the next frame (after it applied a change). */
  const scheduleSync = useCallback(() => {
    requestAnimationFrame(() => syncRef.current());
  }, []);

  /** Dragging the timeline: tell the loader once the thumb rests, not at every step. */
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(focusTimerRef.current), []);

  /** Tells the loader where playback is, once per chunk entered. */
  const focusAt = useCallback((offsetMs: number, force = false) => {
    const index = chunkIndexAt(trackRef.current, offsetMs);
    if (force || index !== focusedChunkRef.current) {
      focusedChunkRef.current = index;
      onTargetRef.current?.(offsetMs);
    }
  }, []);

  /** Shows why nothing plays at `offsetMs`: still loading, or given up after retries. */
  const showWaiting = useCallback((offsetMs: number, untilMs: number) => {
    waitRef.current = { offsetMs, untilMs };
    const chunk = trackRef.current.chunks[chunkIndexAt(trackRef.current, untilMs)];
    setWaiting(chunk?.failed ? 'failed' : 'loading');
  }, []);

  const stopWaiting = useCallback(() => {
    waitRef.current = null;
    setWaiting(undefined);
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
      const replayer = replayerRef.current;
      if (!live && replayer) {
        const offsetMs = replayer.getCurrentTime();
        // While a drag is about to name a target, playing on must not re-target the loader.
        if (focusTimerRef.current === undefined) {
          focusAt(offsetMs);
        }
        // A part not loaded yet (reached by playing, or raced to by skip
        // inactivity): wait there instead of playing an incomplete page.
        if (!readyAt(trackRef.current, offsetMs)) {
          // Stops the ticker too; the chunk's arrival resumes playback (and it).
          feed.pauseForGap(replayer);
          showWaiting(offsetMs, offsetMs);
          stopTicker();
          syncRef.current();
          return;
        }
      }
      syncRef.current();
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [stopTicker, live, focusAt, showWaiting, feed]);

  /** Wires a new replayer's events to the controls. */
  const attach = useCallback(
    (replayer: Replayer) => {
      replayerRef.current = replayer;
      replayer.on('resize', (dimension) => {
        viewportRef.current = dimension as { width: number; height: number };
        rescale();
      });
      if (live) {
        return;
      }
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
      replayer.on('finish', () => {
        onStop();
        // rrweb ran out of loaded events: the end, or the next chunk is still loading.
        const current = trackRef.current;
        const offsetMs = replayer.getCurrentTime();
        const next = afterRun(current, offsetMs);
        if (offsetMs >= trackLength(current) - END_TOLERANCE_MS || next.kind === 'end') {
          setWant(false);
          return;
        }
        if (next.kind === 'play') {
          feed.seek(replayer, offsetMs, wantPlayRef.current);
        } else {
          feed.stopSkipping(replayer);
          showWaiting(offsetMs, next.waitFor);
        }
      });
      replayer.on('skip-start', () => {
        setSkipping(true);
        clock.update({ skipping: true });
      });
      replayer.on('skip-end', () => {
        setSkipping(false);
        clock.update({ skipping: false });
      });
    },
    [live, rescale, startTicker, stopTicker, setWant, feed, showWaiting, clock]
  );

  // Live: create the replayer once the newest chunk is loaded; afterwards
  // append what live polling brings in.
  useEffect(() => {
    if (!live || liveEvents.length === 0 || !mountRef.current || !isReady(track, track.chunks.length - 1)) {
      return;
    }
    let replayer = replayerRef.current;
    newestEventRef.current = Math.max(newestEventRef.current, liveEvents[liveEvents.length - 1].timestamp);
    if (!replayer) {
      // rrweb live mode: events before the baseline are applied at once, later
      // ones are scheduled relative to it as they are added.
      replayer = new Replayer([], {
        root: mountRef.current,
        liveMode: true,
        // rrweb applies catch-up events to a virtual DOM and writes it to the page
        // only on the Flush of normal playback, which never comes in live mode:
        // the page would freeze at the snapshot. Apply them to the page directly.
        useVirtualDom: false,
        mouseTail: { strokeStyle: theme.colors.primary.main },
        showWarning: false,
        UNSAFE_replayCanvas: false,
      });
      attach(replayer);
      replayer.startLive(liveEvents[liveEvents.length - 1].timestamp - LIVE_BUFFER_MS);
      const from = liveStartIndex(liveEvents);
      liveBaselineRef.current = liveEvents[from].timestamp;
      liveEvents.forEach((event, index) => {
        if (index >= from) {
          replayer!.addEvent(event);
        }
        addedRef.current.add(event);
      });
      setPlaying(true);
      startTicker();
      return;
    }
    for (const event of liveEvents) {
      if (!addedRef.current.has(event)) {
        // Never what precedes the live start (e.g. an older chunk that loaded
        // late): rrweb would apply it at once, on top of the live page.
        if (event.timestamp >= liveBaselineRef.current) {
          replayer.addEvent(event);
        }
        addedRef.current.add(event);
      }
    }
    // Creation depends only on the first events; later renders append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEvents]);

  /**
   * Replay: create the replayer once the start position is loaded (it needs
   * two events and the snapshot there). False while it cannot be yet.
   */
  const create = useCallback((): boolean => {
    if (live || replayerRef.current || !mountRef.current) {
      return Boolean(replayerRef.current);
    }
    const start = pendingOffsetRef.current;
    const initial = feed.initialEvents(start);
    if (!initial) {
      const current = trackRef.current;
      if (readyAt(current, start) && afterRun(current, start).kind === 'end') {
        // Loaded, and nothing to play from here on.
        waitRef.current = { offsetMs: start, untilMs: start };
        setWaiting('empty');
      } else {
        showWaiting(start, start);
      }
      syncRef.current();
      return false;
    }
    stopWaiting();
    feed.setSkipInactive(skipInactiveRef.current);
    const replayer = new Replayer(initial, {
      root: mountRef.current,
      skipInactive: skipInactiveRef.current,
      speed: speedRef.current,
      mouseTail: { strokeStyle: theme.colors.primary.main },
      showWarning: false,
      UNSAFE_replayCanvas: false,
    });
    attach(replayer);
    if (wantPlayRef.current) {
      replayer.play(start);
    } else {
      replayer.pause(start);
    }
    scheduleSync();
    return true;
  }, [live, feed, showWaiting, stopWaiting, theme, attach, scheduleSync]);

  // Hand the replayer the chunks that arrive, and go on where playback waits for one.
  useEffect(() => {
    trackRef.current = track;
    feed.setTrack(track);
    const replayer = replayerRef.current;
    if (live) {
      return;
    }
    if (!replayer) {
      create();
      return;
    }
    const wait = waitRef.current;
    if (wait) {
      if (readyAt(track, wait.untilMs)) {
        stopWaiting();
        feed.seek(replayer, wait.offsetMs, wantPlayRef.current);
        scheduleSync();
      } else {
        showWaiting(wait.offsetMs, wait.untilMs);
      }
      return;
    }
    feed.append(replayer);
    // Only new chunks matter here, not the callbacks' identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track]);

  useEffect(() => {
    // The loader starts where this player starts.
    focusAt(pendingOffsetRef.current, true);
  }, [focusAt]);

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

  /** Go to `offsetMs` (clamped to the track), playing if playback is wanted; waits there while it loads. */
  const goToOffset = useCallback(
    (target: number, play: boolean, dragging = false) => {
      const clamped = Math.max(0, Math.min(target, trackLength(trackRef.current)));
      clearTimeout(focusTimerRef.current);
      focusTimerRef.current = undefined;
      if (dragging) {
        focusTimerRef.current = setTimeout(() => {
          focusTimerRef.current = undefined;
          focusAt(clamped, true);
        }, FOCUS_DEBOUNCE_MS);
      } else {
        focusAt(clamped, true);
      }
      const replayer = replayerRef.current;
      if (!replayer) {
        pendingOffsetRef.current = clamped;
        create();
        syncRef.current();
        return;
      }
      if (feed.seek(replayer, clamped, play)) {
        stopWaiting();
      } else {
        showWaiting(clamped, clamped);
      }
      scheduleSync();
    },
    [feed, focusAt, scheduleSync, showWaiting, stopWaiting, create]
  );

  const seek = useCallback(
    (target: number, dragging = false) => goToOffset(target, wantPlayRef.current, dragging),
    [goToOffset]
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
    if (wantPlayRef.current) {
      setWant(false);
      if (replayer && playing) {
        const current = replayer.getCurrentTime();
        // Pausing merges chunks held behind the playhead (see TrackFeed).
        if (feed.hasHeld(current)) {
          feed.seek(replayer, current, false);
        } else {
          replayer.pause();
        }
      }
      return;
    }
    setWant(true);
    if (!replayer) {
      create();
      return;
    }
    const current = replayer.getCurrentTime();
    goToOffset(current >= trackLength(trackRef.current) - END_TOLERANCE_MS ? 0 : current, true);
  };

  const changeSpeed = (value: number) => {
    setSpeed(value);
    speedRef.current = value;
    clock.update({ speed: value });
    replayerRef.current?.setConfig({ speed: value });
  };

  const toggleSkipInactive = () => {
    const next = !skipInactive;
    setSkipInactive(next);
    skipInactiveRef.current = next;
    feed.setSkipInactive(next);
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
        {shownWaiting && (
          <div className={styles.waiting} data-testid={testIds.player.waiting}>
            {(live ? LIVE_WAITING_TEXT : WAITING_TEXT)[shownWaiting]}
          </div>
        )}
      </div>

      {live ? (
        <div className={styles.controls}>
          <Badge text="LIVE" color="red" icon="circle-mono" />
          {startTime !== undefined && (
            <span className={styles.wallClock} data-testid={testIds.player.wallClock}>
              {formatWallClock(startTime + clockOffset + offset)}
            </span>
          )}
          <span className={styles.clock} data-testid={testIds.player.clock}>
            {liveLagMs < 60_000 ? `~${Math.round(liveLagMs / 1000)} s behind` : `~${formatClock(liveLagMs)} behind`}
          </span>
          <div className={styles.spacer} />
          {onExitLive && (
            <ToolbarButton
              icon="history-alt"
              variant="canvas"
              tooltip="Back to the full recording"
              onClick={onExitLive}
            >
              Exit live
            </ToolbarButton>
          )}
          <IconButton
            name={fullscreen ? 'compress-arrows' : 'expand-arrows'}
            tooltip="Toggle fullscreen"
            onClick={toggleFullscreen}
          />
        </div>
      ) : (
        <>
          <div className={styles.timeline}>
            <input
              ref={rangeRef}
              type="range"
              aria-label="Timeline"
              className={styles.range}
              min={0}
              max={Math.max(total, 1)}
              step={100}
              defaultValue={0}
              onChange={(event) => seek(Number(event.currentTarget.value), true)}
              data-testid={testIds.player.timeline}
            />
            {total > 0 && unloaded.length > 0 && (
              <div className={styles.loadTrack} aria-hidden data-testid={testIds.player.unloaded}>
                {unloaded.map((span) => (
                  <div
                    key={span.fromMs}
                    className={styles.unloaded}
                    style={{
                      left: `${(span.fromMs / total) * 100}%`,
                      width: `${((Math.min(total, span.toMs) - span.fromMs) / total) * 100}%`,
                    }}
                    title="Not loaded yet"
                  />
                ))}
              </div>
            )}
            <div className={styles.markerTrack}>
              {total > 0 &&
                markers.map((marker, index) => (
                  <Tooltip key={`${marker.offsetMs}-${index}`} content={marker.title}>
                    <button
                      type="button"
                      aria-label={marker.title}
                      className={cx(
                        styles.marker,
                        marker.kind === 'error' ? styles.markerError : styles.markerNavigation
                      )}
                      style={{ left: `${Math.min(100, Math.max(0, (marker.offsetMs / total) * 100))}%` }}
                      onClick={() => seek(marker.offsetMs)}
                    />
                  </Tooltip>
                ))}
            </div>
            {audioSegments.length > 0 && (
              <div className={styles.graphTrack}>
                <AudioLevelTimeline
                  segments={audioSegments}
                  totalMs={total}
                  clock={clock}
                  startTimeMs={startTimeOfDay}
                  onSeek={seek}
                />
              </div>
            )}
            {belowTimeline && total > 0 && <div className={styles.graphTrack}>{belowTimeline}</div>}
          </div>

          <div className={styles.controls}>
            <span className={styles.clock} data-testid={testIds.player.clock}>
              {formatClock(offset)} / {formatClock(total)}
            </span>
            {startTime !== undefined && (
              <Tooltip content="Time of day at the playhead (your time zone)">
                <span className={styles.wallClock} data-testid={testIds.player.wallClock}>
                  {formatWallClock(startTime + clockOffset + offset)}
                </span>
              </Tooltip>
            )}
            <IconButton
              name="backward"
              tooltip="Skip backward 10 seconds"
              onClick={() => seek(clock.get().offsetMs - SKIP_MS)}
            />
            <IconButton
              name={playing || wantPlay ? 'pause' : 'play'}
              size="xl"
              tooltip={playing || wantPlay ? 'Pause' : 'Play'}
              onClick={togglePlay}
              data-testid={testIds.player.play}
            />
            <IconButton
              name="forward"
              tooltip="Skip forward 10 seconds"
              onClick={() => seek(clock.get().offsetMs + SKIP_MS)}
            />
            {startTime !== undefined && (
              <Tooltip
                content={
                  goToInvalid
                    ? `Not a time in this recording (${formatWallClock(startTime + clockOffset)}–${formatWallClock(startTime + clockOffset + total)})`
                    : 'Jump to a time of day: hh:mm or hh:mm:ss, then Enter'
                }
              >
                <div className={styles.goTo}>
                  <Input
                    aria-label="Go to time"
                    placeholder="Go to hh:mm:ss"
                    value={goTo}
                    invalid={goToInvalid}
                    width={18}
                    prefix={<Icon name="clock-nine" />}
                    onChange={(event) => {
                      setGoTo(event.currentTarget.value);
                      setGoToInvalid(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') {
                        return;
                      }
                      const target = wallClockOffset(goTo, startTime + clockOffset, total);
                      if (target === undefined) {
                        setGoToInvalid(true);
                        return;
                      }
                      seek(target);
                    }}
                    data-testid={testIds.player.goTo}
                  />
                </div>
              </Tooltip>
            )}
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
                onClick={() => onShare(clock.get().offsetMs)}
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
        </>
      )}
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
  waiting: css({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing(2),
    textAlign: 'center',
    background: theme.colors.background.canvas,
    opacity: 0.92,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.h5.fontSize,
  }),
  timeline: css({ position: 'relative', padding: theme.spacing(1, 2, 0) }),
  // Parts not loaded yet, hatched under the range input on its axis.
  loadTrack: css({ position: 'relative', height: 4, margin: `0 ${THUMB_INSET_PX}px` }),
  unloaded: css({
    position: 'absolute',
    top: 0,
    bottom: 0,
    background: `repeating-linear-gradient(135deg, ${theme.colors.text.disabled} 0 2px, transparent 2px 5px)`,
    opacity: 0.6,
  }),
  // The range thumb's centre runs from half a thumb in to half a thumb short
  // of the input's ends; markers and the level graph follow the same axis.
  markerTrack: css({
    position: 'absolute',
    top: 0,
    left: `calc(${theme.spacing(2)} + ${THUMB_INSET_PX}px)`,
    right: `calc(${theme.spacing(2)} + ${THUMB_INSET_PX}px)`,
  }),
  graphTrack: css({ margin: `0 ${THUMB_INSET_PX}px` }),
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
  wallClock: css({
    fontVariantNumeric: 'tabular-nums',
    color: theme.colors.text.secondary,
    padding: theme.spacing(0.25, 0.75),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  goTo: css({ marginLeft: theme.spacing(1) }),
  spacer: css({ flex: 1 }),
});
