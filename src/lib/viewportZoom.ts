import type { JourneyEvent } from './journey';
import type { Viewport } from './layoutViewport';

/**
 * The Faro event a page sends when the visitor pinch-zooms (LP Shop's
 * storefront: resources/js/telemetry/faro.ts): the visual viewport's scale,
 * offset and size within the layout viewport, and the layout viewport's size,
 * all in CSS pixels of the page.
 */
export const ZOOM_EVENT = 'viewport_zoom';

/**
 * Samples further apart than this are not blended: the zoom held until the
 * later one. The page sends a sample at most every 250 ms while the visitor
 * pinches or pans and none while the zoom holds, so only samples this close
 * belong to one movement; blending across a hold made a zoom kept for half a
 * second fade out over that half second, as if never held.
 */
export const ZOOM_BLEND_MAX_MS = 350;
/** Closer to 1 than this is no zoom. */
const UNZOOMED = 0.01;

export interface ZoomSample {
  /** Epoch ms on the recording browser's clock, like rrweb's timestamps. */
  timeMs: number;
  scale: number;
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  layoutWidth: number;
  layoutHeight: number;
}

export type Zoom = Omit<ZoomSample, 'timeMs'>;

const FIELDS: Array<[keyof Zoom, string]> = [
  ['scale', 'scale'],
  ['offsetLeft', 'offset_left'],
  ['offsetTop', 'offset_top'],
  ['width', 'width'],
  ['height', 'height'],
  ['layoutWidth', 'layout_width'],
  ['layoutHeight', 'layout_height'],
];

/** The session's zoom samples, sorted by time; malformed ones are left out. */
export function zoomSamples(journey: readonly JourneyEvent[]): ZoomSample[] {
  const samples: ZoomSample[] = [];
  for (const event of journey) {
    if (event.attributes.kind !== 'event' || event.attributes.event_name !== ZOOM_EVENT) {
      continue;
    }
    const sample = { timeMs: event.timeMs } as ZoomSample;
    const valid = FIELDS.every(([key, field]) => {
      const raw = event.attributes[`event_data_${field}`];
      const value = raw === undefined || raw === '' ? NaN : Number(raw);
      sample[key] = value;
      return Number.isFinite(value);
    });
    if (valid && sample.scale > 0 && sample.width > 0 && sample.height > 0) {
      samples.push(sample);
    }
  }
  return samples.sort((a, b) => a.timeMs - b.timeMs);
}

/** Whether `zoom` is a zoom at all (not the visitor back at scale 1). */
export function isZoomed(zoom: Zoom | undefined): zoom is Zoom {
  return zoom !== undefined && zoom.scale > 1 + UNZOOMED;
}

/**
 * The zoom at `timeMs`: the last sample's, blended towards the next one while
 * they are close (the page sends a few samples per second while the visitor
 * pinches or pans), so the replay zooms and pans smoothly. Undefined before
 * the first sample and while unzoomed.
 */
export function zoomAt(samples: readonly ZoomSample[], timeMs: number): Zoom | undefined {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (samples[middle].timeMs <= timeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low === 0) {
    return undefined;
  }
  const before = samples[low - 1];
  const after = samples[low];
  const blend = after && after.timeMs - before.timeMs <= ZOOM_BLEND_MAX_MS;
  const share = blend ? (timeMs - before.timeMs) / (after.timeMs - before.timeMs) : 0;
  const zoom = Object.fromEntries(
    FIELDS.map(([key]) => [key, blend ? before[key] + (after[key] - before[key]) * share : before[key]])
  ) as unknown as Zoom;
  return isZoomed(zoom) ? zoom : undefined;
}

export interface WrapperStyle {
  transform: string;
  clipPath: string;
}

/**
 * Styles for rrweb's wrapper (iframe, cursor and mouse tail, `viewport` big,
 * the layout viewport): scaled by `fit` to the stage, and with a zoom the
 * visible area enlarged to the same box (scale times the zoom, shifted by its
 * offset) and everything outside it clipped. The cursor and tail live in the
 * wrapper, so they stay on the page.
 */
export function wrapperStyle(fit: number, viewport: Viewport, zoom?: Zoom): WrapperStyle {
  if (!isZoomed(zoom)) {
    return { transform: `scale(${fit})`, clipPath: '' };
  }
  const width = Math.min(zoom.width, viewport.width);
  const height = Math.min(zoom.height, viewport.height);
  // The visible area always lies inside the layout viewport (rounding, URL bar).
  const left = Math.min(Math.max(0, zoom.offsetLeft), viewport.width - width);
  const top = Math.min(Math.max(0, zoom.offsetTop), viewport.height - height);
  const px = (value: number) => `${Math.round(value * 100) / 100}px`;
  return {
    transform: `scale(${fit * zoom.scale}) translate(${px(-left)}, ${px(-top)})`,
    clipPath: `inset(${px(top)} ${px(viewport.width - left - width)} ${px(viewport.height - top - height)} ${px(left)})`,
  };
}

/** A page's first zoom sample comes after it loaded (Faro starts after the load event)… */
const PAGE_LOAD_SAMPLE_MS = 15_000;
/** …or just before rrweb's first snapshot, when the recorder starts later than the page's own script. */
const PAGE_LOAD_SAMPLE_BEFORE_MS = 2000;

/**
 * The layout viewport of a page that opened zoomed out: content wider than
 * the screen makes mobile browsers show the page shrunk to fit, and rrweb
 * records the visible area (e.g. 1060 px wide on an 810 px iPad) although the
 * page is laid out at the screen's size (`layoutWidth` × `layoutHeight`;
 * Chromium reports scale 1 there, so the page sends a sample at load whenever
 * its layout is narrower than the visible area). Read from the first zoom
 * sample around the page load at `timeMs`, after `sinceMs` (the page load
 * before) and before `untilMs` (the next one); the caller uses it only when
 * narrower than the recorded viewport.
 */
export function zoomedOutLayout(
  samples: readonly ZoomSample[],
  timeMs: number,
  untilMs = Infinity,
  sinceMs = -Infinity
): Viewport | undefined {
  // The sample may come just before rrweb's snapshot, never before the last page load (`sinceMs`).
  const from = Math.max(timeMs - PAGE_LOAD_SAMPLE_BEFORE_MS, sinceMs + 1);
  const sample = samples.find((candidate) => candidate.timeMs >= from);
  // A pinch zoom's sample (scale above 1) has the layout wider than the visible area.
  if (
    !sample ||
    sample.timeMs >= untilMs ||
    sample.timeMs > timeMs + PAGE_LOAD_SAMPLE_MS ||
    sample.scale > 1 + UNZOOMED
  ) {
    return undefined;
  }
  return { width: sample.layoutWidth, height: sample.layoutHeight };
}
