import {
  chunksHaveTouchInput,
  hasTouchInput,
  isPinchZoom,
  LayoutViewport,
  PINCH_ASPECT_TOLERANCE,
  StageFrame,
  tallestHeights,
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

/**
 * Recorded sizes of session hcXLzAtwTW (lp-shop-storefront, iPhone, iOS 18.7,
 * 2026-11-26): the URL bar showing and hiding while the buyer scrolled the checkout.
 */
const IPHONE_SCROLL = [775, 783, 805, 776, 810, 790, 773, 775, 786, 809, 775, 788, 815, 808].map((height) =>
  size(430, height)
);

describe('StageFrame', () => {
  it('keeps the tallest height of a touch recording while the width stays', () => {
    const frame = new StageFrame(() => true);
    const frames = IPHONE_SCROLL.map((recorded) => frame.next(recorded));

    expect(frames.slice(0, 3)).toEqual([size(430, 775), size(430, 783), size(430, 805)]);
    // The URL bar hid and showed again: the page stays where it is.
    expect(frames[3]).toEqual(size(430, 805));
    expect(frames.slice(4, 12)).toEqual(Array(8).fill(size(430, 810)));
    expect(frames.at(-1)).toEqual(size(430, 815));
  });

  it('starts at the tallest height recorded at the width, so the first URL bar change does not move the page', () => {
    const tallest = new Map([[430, 815]]);
    const frame = new StageFrame(
      () => true,
      (width) => tallest.get(width)
    );

    expect(IPHONE_SCROLL.map((recorded) => frame.next(recorded))).toEqual(
      Array(IPHONE_SCROLL.length).fill(size(430, 815))
    );
    // A zoomed viewport: the tallest recorded at its width, scaled to what is shown.
    tallest.set(576, 1229);
    expect(frame.next(size(412, 839), size(576, 1173))).toEqual(size(412, 879));
  });

  it('gives a new width its own frame (orientation change)', () => {
    const frame = new StageFrame(() => true);
    frame.next(size(430, 815));

    expect(frame.next(size(932, 390))).toEqual(size(932, 390));
    expect(frame.next(size(430, 775))).toEqual(size(430, 775));
  });

  it('fits desktop recordings to every recorded size', () => {
    const tallest = jest.fn(() => 2000);
    const frame = new StageFrame(() => false, tallest);

    expect(frame.next(size(1440, 900))).toEqual(size(1440, 900));
    expect(frame.next(size(1200, 900))).toEqual(size(1200, 900));
    expect(frame.next(size(1200, 700))).toEqual(size(1200, 700));
    expect(tallest).not.toHaveBeenCalled();
  });
});

describe('LayoutViewport, page loads', () => {
  it('takes a page load as a new page, never a pinch zoom of the last one', () => {
    const viewport = new LayoutViewport(() => true);
    viewport.pageLoad(size(610, 1119));

    expect(viewport.pageLoad(size(411, 754))).toEqual(size(411, 754));
    // A resize of the new page is measured against it.
    expect(viewport.next(size(206, 377))).toEqual(size(411, 752));
  });

  it('lays out a page that opened zoomed out at its layout, also after height changes and turning back', () => {
    const viewport = new LayoutViewport(() => true);

    expect(viewport.pageLoad(size(1060, 1259), size(800, 950))).toEqual(size(800, 950));
    expect(viewport.next(size(1060, 1300))).toEqual(size(800, 981));
    // Zoomed in to the layout width: the page as laid out.
    expect(viewport.next(size(800, 950))).toEqual(size(800, 950));
    // Turned to landscape, and back to the zoomed-out portrait.
    expect(viewport.next(size(1080, 790))).toEqual(size(1080, 790));
    expect(viewport.next(size(1060, 1259))).toEqual(size(800, 950));
    // The next page starts afresh.
    expect(viewport.pageLoad(size(1060, 1259))).toEqual(size(1060, 1259));
    expect(viewport.next(size(1060, 1300))).toEqual(size(1060, 1300));
  });

  it('ignores a layout that is not narrower than the recorded viewport', () => {
    const viewport = new LayoutViewport(() => true);
    expect(viewport.pageLoad(size(412, 839), size(412, 839))).toEqual(size(412, 839));
    expect(viewport.pageLoad(size(412, 839), size(0, 0))).toEqual(size(412, 839));
    expect(viewport.pageLoad(size(412, 839), size(600, 900))).toEqual(size(412, 839));
  });
});

describe('tallestHeights', () => {
  const meta = (width: number, height: number) =>
    ({ type: 4, timestamp: 1, data: { href: '', width, height } }) as never;
  const resize = (width: number, height: number) => incremental({ source: 4, width, height });

  it('finds the tallest Meta or ViewportResize height per width over the chunks', () => {
    const events = [meta(430, 775), resize(430, 815), resize(430, 733), resize(932, 390), mouseMove, touchMove];
    const tallest = tallestHeights([{ events }, { events: [resize(932, 402), incremental({ source: 4 })] }]);

    expect([...tallest.entries()]).toEqual([
      [430, 815],
      [932, 402],
    ]);
    // Each events list is scanned once.
    events.push(resize(430, 999));
    expect(tallestHeights([{ events }]).get(430)).toBe(815);
  });
});
