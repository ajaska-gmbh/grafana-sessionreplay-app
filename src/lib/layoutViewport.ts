import type { eventWithTime } from '@grafana/rrweb-types';

/**
 * rrweb records the viewport as `window.innerWidth/innerHeight`. Mobile
 * browsers report the visual viewport there: a pinch zoom to 1.17x on a
 * 320 px phone records a "resize" to 274 px, at 4x one to 80 px, although the
 * page's layout stays 320 px wide. rrweb's Replayer sizes its iframe to every
 * recorded viewport, so the replayed page is laid out at 274 or 80 px and
 * overflows (cut-off cards, missing buttons) where the user saw it fit.
 *
 * LayoutViewport tells pinch zooms from real resizes and keeps the layout
 * viewport for the former: the replay then shows the page as laid out, not
 * zoomed. A pinch zoom shrinks the width below the layout's and keeps the
 * aspect ratio (within PINCH_ASPECT_TOLERANCE: the URL bar showing or hiding
 * changes the height a little); it only happens on touch devices. Desktop
 * browser zoom (Ctrl +) also shrinks both sides alike but does reflow the page,
 * so it stays a real resize: recordings without touch input are left as they
 * are. Orientation changes change the aspect ratio, URL bar and keyboard only
 * the height: real resizes as well.
 */
export const PINCH_ASPECT_TOLERANCE = 0.1;

export interface Viewport {
  width: number;
  height: number;
}

/** rrweb's IncrementalSource.MouseInteraction / TouchMove and the touch MouseInteractions (TouchStart … TouchEnd). */
const SOURCE_MOUSE_INTERACTION = 2;
const SOURCE_TOUCH_MOVE = 6;
const TOUCH_INTERACTIONS = new Set([7, 8, 9]);
const RRWEB_INCREMENTAL_SNAPSHOT = 3;

/** Whether the events contain touch input: the recording comes from a touch device. */
export function hasTouchInput(events: readonly eventWithTime[]): boolean {
  return events.some((event) => {
    if (event.type !== RRWEB_INCREMENTAL_SNAPSHOT) {
      return false;
    }
    const data = event.data as { source?: number; type?: number };
    return (
      data.source === SOURCE_TOUCH_MOVE ||
      (data.source === SOURCE_MOUSE_INTERACTION && data.type !== undefined && TOUCH_INTERACTIONS.has(data.type))
    );
  });
}

const touchOfEvents = new WeakMap<readonly eventWithTime[], boolean>();

/**
 * Whether any loaded chunk contains touch input. Chunks are replaced, never
 * changed, so each events list is scanned once.
 */
export function chunksHaveTouchInput(chunks: ReadonlyArray<{ events: readonly eventWithTime[] }>): boolean {
  return chunks.some(({ events }) => {
    let touch = touchOfEvents.get(events);
    if (touch === undefined) {
      touch = hasTouchInput(events);
      touchOfEvents.set(events, touch);
    }
    return touch;
  });
}

/** Whether `recorded` is `layout` pinch-zoomed: narrower, same aspect ratio. */
export function isPinchZoom(layout: Viewport, recorded: Viewport): boolean {
  if (recorded.width <= 0 || recorded.height <= 0 || layout.height <= 0 || recorded.width >= layout.width) {
    return false;
  }
  const aspect = recorded.width / recorded.height / (layout.width / layout.height);
  return Math.abs(aspect - 1) <= PINCH_ASPECT_TOLERANCE;
}

/**
 * The viewport to replay, fed every recorded size (Meta and ViewportResize, in
 * playback order). Keeps the last real one as the layout across seeks: rrweb
 * replays from the Meta before the target, so the order holds.
 */
export class LayoutViewport {
  private layout?: Viewport;

  /** `touch` is asked only for a candidate pinch zoom (it may scan the events). */
  constructor(private readonly touch: () => boolean) {}

  next(recorded: Viewport): Viewport {
    const layout = this.layout;
    if (layout && isPinchZoom(layout, recorded) && this.touch()) {
      // The layout's width; the height follows the visual viewport's (URL bar shown or hidden).
      return { width: layout.width, height: Math.round((recorded.height * layout.width) / recorded.width) };
    }
    this.layout = { width: recorded.width, height: recorded.height };
    return { ...this.layout };
  }
}
