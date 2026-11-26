import type { eventWithTime } from '@grafana/rrweb-types';
import { recordedFrustration } from './recordedFrustration';

const el = (id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: unknown[] = []) => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes,
});
const text = (id: number, textContent: string) => ({ type: 3, id, textContent });

const snapshot = (timestamp: number) =>
  ({
    type: 2,
    timestamp,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          el(2, 'BODY', {}, [
            el(3, 'button', {}, [el(4, 'span', {}, [text(5, '  Buy\n now ')])]),
            el(6, 'img', { alt: 'Serum bottle' }),
            el(7, 'input', { type: 'email' }),
            el(8, 'div', { role: 'button', 'aria-label': 'Open size guide' }),
            el(9, 'p', {}, [text(10, 'x'.repeat(80))]),
            el(11, 'script', {}, [text(12, 'ignored')]),
          ]),
        ],
      },
      initialOffset: { top: 0, left: 0 },
    },
  }) as unknown as eventWithTime;

const click = (timestamp: number, id: number, x = 100, y = 200) =>
  ({ type: 3, timestamp, data: { source: 2, type: 2, id, x, y } }) as unknown as eventWithTime;
const mutation = (timestamp: number, adds: unknown[] = []) =>
  ({
    type: 3,
    timestamp,
    data: { source: 0, adds, removes: [], texts: [], attributes: [] },
  }) as unknown as eventWithTime;
const focus = (timestamp: number, id: number) =>
  ({ type: 3, timestamp, data: { source: 2, type: 5, id } }) as unknown as eventWithTime;
const mouseMove = (timestamp: number) =>
  ({ type: 3, timestamp, data: { source: 1, positions: [] } }) as unknown as eventWithTime;
const custom = (timestamp: number) => ({ type: 5, timestamp, data: {} }) as unknown as eventWithTime;

describe('recordedFrustration', () => {
  it('finds a dead tap on a button, named by its text', () => {
    const [dead] = recordedFrustration([snapshot(0), click(1000, 4), mouseMove(1500), mouseMove(3000)], true);
    expect(dead).toMatchObject({
      category: 'frustration',
      timeMs: 1000,
      title: 'Dead tap on “Buy now” (button)',
      detail: 'Looks clickable, nothing happened within 1 s (found in the recording)',
      attributes: {
        event_name: 'dead_click',
        event_data_x: '100',
        event_data_interactive: '1',
        browser_mobile: 'true',
      },
    });
  });

  it('names elements that are not clickable by alt text, and says so', () => {
    const [dead] = recordedFrustration([snapshot(0), click(1000, 6), custom(3000)], false);
    expect(dead.title).toBe('Dead click on “Serum bottle” (img)');
    expect(dead.detail).toBe('Not clickable: the visitor expected it to be (found in the recording)');
    expect(dead.attributes.browser_mobile).toBeUndefined();
  });

  it('uses aria labels, shortens long texts and names unknown nodes by nothing', () => {
    const found = recordedFrustration(
      [snapshot(0), click(1000, 8), click(5000, 10), click(9000, 99), custom(20_000)],
      false
    );
    expect(found.map((entry) => entry.title)).toEqual([
      'Dead click on “Open size guide” (div)',
      `Dead click on “${'x'.repeat(59)}…” (p)`,
      'Dead click on the page',
    ]);
  });

  it('is not dead when the page answers: a DOM change, scroll, focus elsewhere, a page load', () => {
    const answered = [
      [mutation(1200)],
      [{ type: 3, timestamp: 1200, data: { source: 3, id: 1, x: 0, y: 10 } }],
      [{ type: 3, timestamp: 1200, data: { source: 5, id: 7, text: 'a' } }],
      [focus(1200, 7)],
      [{ type: 4, timestamp: 1200, data: { href: 'https://x/2', width: 1, height: 1 } }],
    ] as unknown as eventWithTime[][];
    for (const answer of answered) {
      expect(recordedFrustration([snapshot(0), click(1000, 3), ...answer, custom(5000)], false)).toEqual([]);
    }
    // A focus on the clicked element itself is no answer.
    expect(recordedFrustration([snapshot(0), click(1000, 3), focus(1100, 3), custom(5000)], false)).toHaveLength(1);
  });

  it('never judges taps on fields, nor taps too close to the end of what is loaded', () => {
    expect(recordedFrustration([snapshot(0), click(1000, 7), custom(5000)], true)).toEqual([]);
    expect(recordedFrustration([snapshot(0), click(1000, 3), custom(1500)], true)).toEqual([]);
  });

  it('finds rage taps (3+ within 1 s, close together) instead of dead ones', () => {
    const found = recordedFrustration(
      [
        snapshot(0),
        click(1000, 3, 100, 100),
        click(1300, 3, 110, 105),
        click(1600, 4, 120, 90),
        click(1900, 3, 105, 100),
        // Far away: not part of the burst.
        click(1950, 6, 400, 400),
        custom(10_000),
      ],
      true
    );
    expect(found.map((entry) => entry.title)).toEqual([
      'Rage tap: 4× on “Buy now” (button)',
      'Dead tap on “Serum bottle” (img)',
    ]);
    expect(found[0].attributes.event_data_count).toBe('4');
    expect(found[0].detail).toBe('Found in the recording');
  });

  it('names nodes added after the snapshot', () => {
    const [dead] = recordedFrustration(
      [
        snapshot(0),
        mutation(500, [{ parentId: 2, node: el(20, 'A', { href: '/x' }, [text(21, 'Reviews')]) }]),
        click(1000, 21),
        custom(5000),
      ],
      false
    );
    expect(dead.title).toBe('Dead click on “Reviews” (a)');
  });

  it('finds nothing without clicks', () => {
    expect(recordedFrustration([], false)).toEqual([]);
    expect(recordedFrustration([snapshot(0), mouseMove(10)], false)).toEqual([]);
  });
});
