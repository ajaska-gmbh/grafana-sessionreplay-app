import {
  chunksHaveTouchInput,
  hasTouchInput,
  isPinchZoom,
  LayoutViewport,
  PINCH_ASPECT_TOLERANCE,
} from './layoutViewport';

const incremental = (data: Record<string, unknown>) => ({ type: 3, timestamp: 1, data }) as never;
const touchMove = incremental({ source: 6, positions: [] });
const mouseMove = incremental({ source: 1, positions: [] });

const size = (width: number, height: number) => ({ width, height });

/**
 * Recorded sizes of session MQy7ByD4t6 (lp-shop-storefront, Android phone,
 * 2026-11-20): the checkout's Meta, the URL bar hiding, then pinch zooms. The
 * page never left its 320 px layout.
 */
const PHONE = [
  size(320, 582),
  size(320, 611),
  size(144, 266),
  size(317, 578),
  size(274, 506),
  size(274, 524),
  size(45, 86),
];

describe('isPinchZoom', () => {
  it('is a narrower viewport of the same aspect ratio', () => {
    expect(isPinchZoom(size(320, 582), size(274, 506))).toBe(true);
    expect(isPinchZoom(size(320, 582), size(45, 86))).toBe(true);
    // The URL bar hid while zoomed: the height grew a little.
    expect(isPinchZoom(size(320, 582), size(274, 524))).toBe(true);
  });

  it('is not a width that stays or grows, an orientation change or a height-only change', () => {
    expect(isPinchZoom(size(320, 582), size(320, 611))).toBe(false);
    expect(isPinchZoom(size(320, 582), size(640, 300))).toBe(false);
    expect(isPinchZoom(size(640, 300), size(320, 582))).toBe(false);
    expect(isPinchZoom(size(1440, 900), size(1200, 900))).toBe(false);
  });

  it('stops at the aspect tolerance and ignores empty sizes', () => {
    const height = 582 * (1 + PINCH_ASPECT_TOLERANCE * 1.5);
    expect(isPinchZoom(size(320, 582), size(160, height / 2))).toBe(false);
    expect(isPinchZoom(size(320, 582), size(0, 0))).toBe(false);
    expect(isPinchZoom(size(320, 0), size(100, 100))).toBe(false);
  });
});

describe('hasTouchInput', () => {
  it('finds touch moves and touch interactions, not mouse input', () => {
    expect(hasTouchInput([mouseMove, touchMove])).toBe(true);
    expect(hasTouchInput([incremental({ source: 2, type: 7, id: 1, x: 1, y: 1 })])).toBe(true);
    expect(hasTouchInput([incremental({ source: 2, type: 2, id: 1, x: 1, y: 1 })])).toBe(false);
    expect(hasTouchInput([incremental({ source: 2 })])).toBe(false);
    expect(
      hasTouchInput([mouseMove, { type: 4, timestamp: 1, data: { width: 1, height: 1, href: '' } } as never])
    ).toBe(false);
  });

  it('over chunks: any of them, each events list scanned once', () => {
    const events = [mouseMove];
    expect(chunksHaveTouchInput([{ events }, { events: [] }])).toBe(false);
    // A cached answer for the same list.
    events.push(touchMove);
    expect(chunksHaveTouchInput([{ events }])).toBe(false);
    expect(chunksHaveTouchInput([{ events }, { events: [touchMove] }])).toBe(true);
  });
});

describe('LayoutViewport', () => {
  it('replays a touch recording at its layout width, whatever the pinch zoom', () => {
    const viewport = new LayoutViewport(() => true);

    expect(PHONE.map((recorded) => viewport.next(recorded))).toEqual([
      size(320, 582),
      size(320, 611),
      // Zoomed: 320 px wide, the height the visual viewport's at that width.
      size(320, 591),
      size(320, 583),
      size(320, 591),
      size(320, 612),
      size(320, 612),
    ]);
  });

  it('takes an orientation change as real, and zooms after it against the new layout', () => {
    const viewport = new LayoutViewport(() => true);
    viewport.next(size(320, 582));

    expect(viewport.next(size(640, 300))).toEqual(size(640, 300));
    expect(viewport.next(size(320, 150))).toEqual(size(640, 300));
    expect(viewport.next(size(320, 582))).toEqual(size(320, 582));
  });

  it('leaves recordings without touch input as recorded (desktop browser zoom reflows the page)', () => {
    const touch = jest.fn(() => false);
    const viewport = new LayoutViewport(touch);

    expect(viewport.next(size(1440, 900))).toEqual(size(1440, 900));
    expect(viewport.next(size(1152, 720))).toEqual(size(1152, 720));
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('takes the first size as the layout without asking for touch input', () => {
    const touch = jest.fn(() => true);

    expect(new LayoutViewport(touch).next(size(274, 506))).toEqual(size(274, 506));
    expect(touch).not.toHaveBeenCalled();
  });
});
