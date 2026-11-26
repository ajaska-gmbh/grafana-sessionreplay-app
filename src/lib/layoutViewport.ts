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
  /** A page opened zoomed out: its recorded (visible) width, its layout width, and layout px per visible px. */
  private zoomedOut?: { recordedWidth: number; layoutWidth: number; ratio: number };

  /** `touch` is asked only for a candidate pinch zoom (it may scan the events). */
  constructor(private readonly touch: () => boolean) {}

  next(recorded: Viewport): Viewport {
    const layout = this.layout;
    const zoomedOut = this.zoomedOut;
    if (zoomedOut && recorded.width === zoomedOut.recordedWidth) {
      // Zoomed out as at load (URL bar, keyboard, turned back): that layout, its height following.
      this.layout = { width: zoomedOut.layoutWidth, height: Math.round(recorded.height * zoomedOut.ratio) };
      return { ...this.layout };
    }
    if (layout && isPinchZoom(layout, recorded) && this.touch()) {
      // The layout's width; the height follows the visual viewport's (URL bar shown or hidden).
      return { width: layout.width, height: Math.round((recorded.height * layout.width) / recorded.width) };
    }
    // Kept while the page lasts: turned back, it is zoomed out again at the same width.
    this.layout = { width: recorded.width, height: recorded.height };
    return { ...this.layout };
  }

  /**
   * A page load (Meta): a new page, never a pinch zoom of the last one. A page
   * that opened zoomed out (wider than the screen; its layout viewport from
   * the page's zoom samples, see zoomedOutLayout) is laid out at its real size.
   */
  pageLoad(recorded: Viewport, zoomedOut?: Viewport): Viewport {
    const narrower =
      zoomedOut !== undefined && zoomedOut.width > 0 && zoomedOut.height > 0 && zoomedOut.width < recorded.width;
    this.layout = narrower
      ? { width: zoomedOut.width, height: zoomedOut.height }
      : { width: recorded.width, height: recorded.height };
    this.zoomedOut = narrower
      ? { recordedWidth: recorded.width, layoutWidth: zoomedOut.width, ratio: zoomedOut.width / recorded.width }
      : undefined;
    return { ...this.layout };
  }
}

/** rrweb's IncrementalSource.ViewportResize and EventType.Meta. */
const SOURCE_VIEWPORT_RESIZE = 4;
const RRWEB_META = 4;

const tallestOfEvents = new WeakMap<readonly eventWithTime[], Map<number, number>>();

/**
 * The tallest recorded viewport per width in the loaded chunks (Meta and
 * ViewportResize events), each events list scanned once: the stage frame of a
 * touch recording starts at it, so the page does not shrink the first time
 * the URL bar hides either.
 */
export function tallestHeights(chunks: ReadonlyArray<{ events: readonly eventWithTime[] }>): Map<number, number> {
  const tallest = new Map<number, number>();
  for (const { events } of chunks) {
    let heights = tallestOfEvents.get(events);
    if (!heights) {
      heights = new Map();
      for (const event of events) {
        const data = event.data as { source?: number; width?: number; height?: number };
        const sized =
          event.type === RRWEB_META ||
          (event.type === RRWEB_INCREMENTAL_SNAPSHOT && data.source === SOURCE_VIEWPORT_RESIZE);
        if (sized && typeof data.width === 'number' && typeof data.height === 'number') {
          heights.set(data.width, Math.max(heights.get(data.width) ?? 0, data.height));
        }
      }
      tallestOfEvents.set(events, heights);
    }
    heights.forEach((height, width) => tallest.set(width, Math.max(tallest.get(width) ?? 0, height)));
  }
  return tallest;
}

/**
 * The box the replayed page is fitted into on the stage. Phones change the
 * viewport's height whenever the URL bar or the keyboard shows or hides (iOS
 * Safari: on every scroll, e.g. 775 ↔ 815 px several times a second), and
 * rrweb records each as a resize. Fitting the page to every height scaled it
 * up and down and moved it on each scroll. In touch recordings the frame keeps
 * the tallest height recorded at the same width: the page keeps its scale and
 * position, only its bottom edge moves. A new width (orientation change, a new
 * page at another size) gets its own frame; desktop resizes are fitted as recorded.
 */
export class StageFrame {
  private frame?: Viewport;

  /**
   * `touch` tells whether the recording comes from a touch device; `tallest`
   * gives the tallest recorded height at a width (see tallestHeights).
   */
  constructor(
    private readonly touch: () => boolean,
    private readonly tallest: (width: number) => number | undefined = () => undefined
  ) {}

  /** `viewport` is what the replay shows, `recorded` the size rrweb recorded for it (they differ for zooms). */
  next(viewport: Viewport, recorded: Viewport = viewport): Viewport {
    const frame = this.frame;
    if (!this.touch()) {
      this.frame = { width: viewport.width, height: viewport.height };
      return { ...this.frame };
    }
    const kept = frame && frame.width === viewport.width ? frame.height : 0;
    const tallest = Math.round(((this.tallest(recorded.width) ?? 0) * viewport.width) / recorded.width);
    this.frame = { width: viewport.width, height: Math.max(viewport.height, kept, tallest) };
    return { ...this.frame };
  }
}
