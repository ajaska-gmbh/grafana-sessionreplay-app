import type { JourneyEvent } from './journey';
import type { Viewport } from './layoutViewport';

/**
 * The Faro event a page sends when the visitor pinch-zooms (LP Shop's
 * storefront: resources/js/telemetry/faro.ts): the visual viewport's scale,
 * offset and size within the layout viewport, and the layout viewport's size,
 * all in CSS pixels of the page.
 */
export const ZOOM_EVENT = 'viewport_zoom';

/** Samples further apart than this are not blended: the zoom held until the later one. */
export const ZOOM_BLEND_MAX_MS = 1500;
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
