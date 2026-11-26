import type { JourneyEvent } from './journey';
import {
  isZoomed,
  wrapperStyle,
  ZOOM_BLEND_MAX_MS,
  zoomAt,
  zoomedOutLayout,
  zoomSamples,
  type ZoomSample,
} from './viewportZoom';

const zoomEvent = (timeMs: number, data: Record<string, string>, name = 'viewport_zoom'): JourneyEvent => ({
  id: `${timeMs}`,
  timeMs,
  category: 'custom',
  title: name,
  attributes: {
    kind: 'event',
    event_name: name,
    ...Object.fromEntries(Object.entries(data).map(([key, value]) => [`event_data_${key}`, value])),
  },
});

const data = (scale: number, offsetLeft = 0, offsetTop = 0) => ({
  scale: String(scale),
  offset_left: String(offsetLeft),
  offset_top: String(offsetTop),
  width: String(Math.round(320 / scale)),
  height: String(Math.round(582 / scale)),
  layout_width: '320',
  layout_height: '582',
});

const sample = (timeMs: number, scale: number, offsetLeft = 0, offsetTop = 0): ZoomSample => ({
  timeMs,
  scale,
  offsetLeft,
  offsetTop,
  width: Math.round(320 / scale),
  height: Math.round(582 / scale),
  layoutWidth: 320,
  layoutHeight: 582,
});

describe('zoomSamples', () => {
  it("reads the page's viewport_zoom events, sorted by time", () => {
    const journey = [
      zoomEvent(2000, data(1)),
      zoomEvent(1000, data(2, 40, 100)),
      zoomEvent(1500, data(1), 'add_to_cart'),
      { ...zoomEvent(1700, data(1)), attributes: { kind: 'log', event_name: 'viewport_zoom' } },
    ];
    expect(zoomSamples(journey)).toEqual([sample(1000, 2, 40, 100), sample(2000, 1)]);
  });

  it('leaves out malformed samples', () => {
    expect(
      zoomSamples([
        zoomEvent(1, { ...data(2), scale: 'x' }),
        zoomEvent(2, { ...data(2), offset_top: '' }),
        zoomEvent(3, { ...data(2), layout_width: undefined as unknown as string }),
        zoomEvent(4, { ...data(2), scale: '0' }),
        zoomEvent(5, { ...data(2), width: '0' }),
        zoomEvent(6, { ...data(2), height: '-1' }),
      ])
    ).toEqual([]);
  });
});

describe('zoomAt', () => {
  const samples = [sample(1000, 2, 0, 0), sample(1250, 3, 100, 200), sample(5000, 2.5, 10, 20), sample(5300, 1)];

  it('is no zoom before the first sample and without samples', () => {
    expect(zoomAt([], 1000)).toBeUndefined();
    expect(zoomAt(samples, 999)).toBeUndefined();
  });

  it('blends close samples so pinches and pans play smoothly', () => {
    expect(zoomAt(samples, 1000)).toMatchObject({ scale: 2, offsetLeft: 0, offsetTop: 0 });
    expect(zoomAt(samples, 1125)).toMatchObject({ scale: 2.5, offsetLeft: 50, offsetTop: 100, layoutWidth: 320 });
    expect(zoomAt(samples, 1250)).toMatchObject({ scale: 3, offsetLeft: 100, offsetTop: 200 });
  });

  it('holds a sample until a distant next one', () => {
    expect(5000 - 1250).toBeGreaterThan(ZOOM_BLEND_MAX_MS);
    expect(zoomAt(samples, 4999)).toMatchObject({ scale: 3, offsetLeft: 100, offsetTop: 200 });
    expect(zoomAt(samples, 5000)).toMatchObject({ scale: 2.5 });
  });

  it('holds a zoom kept for less than a second until the visitor lets go', () => {
    // Pinched to 2x, held 0.4 s, back to 1x: the replay shows 2x all along, not a fade.
    const held = [sample(1000, 2), sample(1400, 1)];
    expect(zoomAt(held, 1399)).toMatchObject({ scale: 2 });
    expect(zoomAt(held, 1400)).toBeUndefined();
  });

  it('is no zoom once the visitor is back at scale 1', () => {
    expect(zoomAt(samples, 5290)).toMatchObject({ scale: expect.closeTo(1.05, 5) });
    expect(zoomAt(samples, 5299)).toBeUndefined();
    expect(zoomAt(samples, 5300)).toBeUndefined();
    expect(zoomAt(samples, 60_000)).toBeUndefined();
  });

  it('finds the sample in long sessions', () => {
    const many = Array.from({ length: 1000 }, (_, index) => sample(index * 2000, 2 + (index % 4)));
    expect(zoomAt(many, 1_000_001)).toMatchObject({ scale: 2 + (500 % 4) });
    expect(zoomAt(many, 1_002_001)).toMatchObject({ scale: 2 + (501 % 4) });
  });
});

describe('isZoomed', () => {
  it('is a scale above 1', () => {
    expect(isZoomed(undefined)).toBe(false);
    expect(isZoomed(sample(0, 1))).toBe(false);
    expect(isZoomed(sample(0, 1.005))).toBe(false);
    expect(isZoomed(sample(0, 1.2))).toBe(true);
  });
});

describe('wrapperStyle', () => {
  const layout = { width: 320, height: 582 };

  it('only fits the page to the stage without a zoom', () => {
    expect(wrapperStyle(0.5, layout)).toEqual({ transform: 'scale(0.5)', clipPath: '' });
    expect(wrapperStyle(0.5, layout, sample(0, 1))).toEqual({ transform: 'scale(0.5)', clipPath: '' });
  });

  it('enlarges the visible area to the same box and clips the rest', () => {
    // At 2x the visitor saw 160 x 291 px from (100, 200) of the 320 x 582 layout.
    expect(wrapperStyle(0.5, layout, sample(0, 2, 100, 200))).toEqual({
      transform: 'scale(1) translate(-100px, -200px)',
      clipPath: 'inset(200px 60px 91px 100px)',
    });
    expect(wrapperStyle(1, layout, sample(0, 3, 10.123, 20))).toEqual({
      transform: 'scale(3) translate(-10.12px, -20px)',
      clipPath: 'inset(20px 202.88px 368px 10.12px)',
    });
  });

  it('keeps the visible area inside the layout viewport', () => {
    expect(wrapperStyle(1, layout, sample(0, 2, -5, 400))).toEqual({
      transform: 'scale(2) translate(0px, -291px)',
      clipPath: 'inset(291px 160px 0px 0px)',
    });
    // Wider than the replayed page (its size came from an older Meta).
    expect(wrapperStyle(1, { width: 100, height: 200 }, sample(0, 2, 50, 50))).toEqual({
      transform: 'scale(2) translate(0px, 0px)',
      clipPath: 'inset(0px 0px 0px 0px)',
    });
  });
});

describe('zoomedOutLayout', () => {
  const at = (timeMs: number, scale: number, layoutWidth: number, layoutHeight = 839): ZoomSample => ({
    timeMs,
    scale,
    offsetLeft: 0,
    offsetTop: 0,
    width: 576,
    height: 1173,
    layoutWidth,
    layoutHeight,
  });

  it("is the layout of the page load's first sample", () => {
    expect(zoomedOutLayout([at(1200, 1, 412)], 1000)).toEqual({ width: 412, height: 839 });
    // iOS reports the zoom-out as a scale below 1.
    expect(zoomedOutLayout([at(1200, 0.76, 800, 950)], 1000)).toEqual({ width: 800, height: 950 });
    // Just before rrweb's snapshot, but not from the page before.
    expect(zoomedOutLayout([at(900, 1, 412)], 1000)).toEqual({ width: 412, height: 839 });
    expect(zoomedOutLayout([at(900, 1, 412)], 1000, Infinity, 950)).toBeUndefined();
  });

  it('is nothing for a pinch zoom, a later page, or a sample long after the load', () => {
    expect(zoomedOutLayout([at(1200, 2, 412)], 1000)).toBeUndefined();
    expect(zoomedOutLayout([at(5000, 1, 412)], 1000, 4000)).toBeUndefined();
    expect(zoomedOutLayout([at(60_000, 1, 412)], 1000)).toBeUndefined();
    expect(zoomedOutLayout([], 1000)).toBeUndefined();
  });
});
