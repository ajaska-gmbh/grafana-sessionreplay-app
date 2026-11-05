import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

/** Where the player is: updated on every animation frame while playing. */
export interface ClockState {
  /** Playhead, ms from the recording start. */
  offsetMs: number;
  /** Length of the recording so far, ms. */
  totalMs: number;
  /** Epoch ms of the recording start, once known. */
  startTimeMs?: number;
  playing: boolean;
  speed: number;
  /** rrweb is fast-forwarding through inactivity ("Skip inactivity"): the playhead jumps. */
  skipping: boolean;
}

const INITIAL: ClockState = { offsetMs: 0, totalMs: 0, playing: false, speed: 1, skipping: false };

/**
 * The player's time, outside React. The player writes it every frame; React
 * components read only what they need of it (useClockValue), so a frame
 * re-renders only those whose value actually changed, and anything that must
 * follow the playhead smoothly does so through clock.subscribe() and the DOM.
 */
export class PlayerClock {
  private state: ClockState = INITIAL;
  private readonly listeners = new Set<() => void>();

  get = (): ClockState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  update(next: Partial<ClockState>): void {
    let changed = false;
    for (const key of Object.keys(next) as Array<keyof ClockState>) {
      if (next[key] !== this.state[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** Epoch ms at the playhead, once the recording start is known. */
  wallMs(): number | undefined {
    const { startTimeMs, offsetMs } = this.state;
    return startTimeMs === undefined ? undefined : startTimeMs + offsetMs;
  }
}

/**
 * Re-renders only when `select(state)` changes (by Object.is): select what the
 * component shows, e.g. the whole second or the index of the current event.
 */
export function useClockValue<T>(clock: PlayerClock, select: (state: ClockState) => T): T {
  const getSnapshot = () => select(clock.get());
  return useSyncExternalStore(clock.subscribe, getSnapshot, getSnapshot);
}

/** Calls `onChange` with the state on every change, without rendering: for DOM that follows the playhead. */
export function useClockEffect(clock: PlayerClock, onChange: (state: ClockState) => void): void {
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    onChangeRef.current(clock.get());
    return clock.subscribe(() => onChangeRef.current(clock.get()));
  }, [clock]);
}
