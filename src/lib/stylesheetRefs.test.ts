jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import type { eventWithTime } from '@grafana/rrweb-types';
import { replayLine, SESSION_ID } from './fixtures';
import { SessionStore } from './sessionStore';
import { liveStartIndex } from './playerEvents';
import {
  cyrb53,
  isStylesheetRef,
  STYLESHEET_REF_MIN_LENGTH,
  StylesheetResolver,
  stylesheetRef,
} from './stylesheetRefs';

// The same vectors are pinned in predictive-power-dialer
// (tests/frontend/replayStylesheets.test.ts): both sides must hash identically.
describe('cyrb53 / stylesheetRef', () => {
  it.each([
    ['', 3338908027751811, 'ajaska-css/v1:bdcb81aee8d83:0'],
    ['a', 7929297801672961, 'ajaska-css/v1:1c2ba782c97901:1'],
    ['hello world', 3259054761512980, 'ajaska-css/v1:b9417d15d1014:11'],
    ['Grüße ✓ 🙂', 5722226852245159, 'ajaska-css/v1:145455c2da2ea7:10'],
    ['x'.repeat(3000), 5281414893841557, 'ajaska-css/v1:12c36b3aa8ac95:3000'],
    ['.a{color:red}'.repeat(200), 1416537081470386, 'ajaska-css/v1:508553d8d5db2:2600'],
  ])('hashes %j', (text, hash, ref) => {
    expect(cyrb53(text)).toBe(hash);
    expect(stylesheetRef(text)).toBe(ref);
  });

  it('recognises references of any version, and nothing else', () => {
    expect(isStylesheetRef('ajaska-css/v1:508553d8d5db2:2600')).toBe(true);
    expect(isStylesheetRef('ajaska-css/v2:508553d8d5db2:2600')).toBe(true);
    expect(isStylesheetRef('.a{color:red}')).toBe(false);
    expect(isStylesheetRef('ajaska-css/v1:xyz:1')).toBe(false);
  });
});

const CSS = `.a{color:red}${' '.repeat(STYLESHEET_REF_MIN_LENGTH)}`;
const OTHER_CSS = `.b{color:blue}${' '.repeat(STYLESHEET_REF_MIN_LENGTH)}`;

type Event = eventWithTime & { data: any };

const meta = (timestamp: number): Event =>
  ({ type: 4, timestamp, data: { href: 'https://ppd/', width: 1, height: 1 } }) as Event;
const snapshot = (timestamp: number, css: string): Event =>
  ({
    type: 2,
    timestamp,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [{ type: 2, id: 2, tagName: 'link', attributes: { _cssText: css }, childNodes: [] }],
      },
      initialOffset: { top: 0, left: 0 },
    },
  }) as Event;
/** The CRM frame as the dialer records it: an attach mutation with a <style> text node. */
const frame = (timestamp: number, css: string): Event =>
  ({
    type: 3,
    timestamp,
    data: {
      source: 0,
      adds: [
        {
          parentId: 9,
          nextId: null,
          node: { type: 2, id: 10, tagName: 'style', attributes: { _cssText: css }, childNodes: [] },
        },
      ],
      removes: [],
      texts: [],
      attributes: [],
      isAttachIframe: true,
    },
  }) as Event;
const frameCss = (event: Event) => event.data.adds[0].node.attributes._cssText;
const pageCss = (event: Event) => event.data.node.childNodes[0].attributes._cssText;

describe('StylesheetResolver', () => {
  it('leaves recordings without references untouched', () => {
    const resolver = new StylesheetResolver();
    const events = [snapshot(1, CSS), frame(2, CSS), frame(3, OTHER_CSS)];
    const before = JSON.stringify(events);

    resolver.addEvents(events);

    expect(JSON.stringify(events)).toBe(before);
    expect(resolver.unresolved).toBe(0);
  });

  it('resolves a reference in the CRM frame to the CSS the parent page sent', () => {
    const resolver = new StylesheetResolver();
    const parent = snapshot(1, CSS);
    const child = frame(2, stylesheetRef(CSS));

    resolver.addEvents([parent, child]);

    expect(frameCss(child)).toBe(CSS);
    expect(resolver.unresolved).toBe(0);
  });

  it('resolves references across loading batches (pages, live polls)', () => {
    const resolver = new StylesheetResolver();
    resolver.addEvents([snapshot(1, CSS)]);
    const later = frame(5, stylesheetRef(CSS));

    resolver.addEvents([later]);

    expect(frameCss(later)).toBe(CSS);
  });

  it('keeps CSS that changed between snapshots apart', () => {
    const resolver = new StylesheetResolver();
    const events = [
      frame(1, CSS),
      frame(2, OTHER_CSS),
      frame(3, stylesheetRef(OTHER_CSS)),
      frame(4, stylesheetRef(CSS)),
    ];

    resolver.addEvents(events);

    expect(events.map(frameCss)).toEqual([CSS, OTHER_CSS, OTHER_CSS, CSS]);
  });

  it('renders an unresolvable reference as an empty stylesheet and counts it once', () => {
    const resolver = new StylesheetResolver();
    const first = frame(1, stylesheetRef(CSS));
    const second = frame(2, stylesheetRef(CSS));

    resolver.addEvents([first, second]);

    expect(frameCss(first)).toBe('');
    expect(frameCss(second)).toBe('');
    expect(resolver.unresolved).toBe(1);
  });

  it('treats references of an unknown format version as unresolvable', () => {
    const resolver = new StylesheetResolver();
    const future = frame(2, stylesheetRef(CSS).replace('/v1:', '/v2:'));

    resolver.addEvents([snapshot(1, CSS), future]);

    expect(frameCss(future)).toBe('');
    expect(resolver.unresolved).toBe(1);
  });

  it('remembers a bounded number of texts', () => {
    const resolver = new StylesheetResolver(1);
    const events = [
      frame(1, CSS),
      frame(2, OTHER_CSS),
      frame(3, stylesheetRef(CSS)),
      frame(4, stylesheetRef(OTHER_CSS)),
    ];

    resolver.addEvents(events);

    expect(frameCss(events[2])).toBe(CSS);
    expect(frameCss(events[3])).toBe('');
    expect(resolver.unresolved).toBe(1);
  });

  it('only covers stylesheet text, not other strings that look like references', () => {
    const resolver = new StylesheetResolver();
    const text = {
      type: 3,
      timestamp: 1,
      data: { source: 0, texts: [{ id: 1, value: stylesheetRef(CSS) }], adds: [], removes: [], attributes: [] },
    } as Event;

    resolver.addEvents([text]);

    expect(text.data.texts[0].value).toBe(stylesheetRef(CSS));
    expect(resolver.unresolved).toBe(0);
  });
});

describe('SessionStore with stylesheet references', () => {
  const lines = (events: Event[], from: number, recordingId = 'rec1') =>
    events.map((event, index) => ({
      tsNs: `${event.timestamp}000000`,
      line: replayLine(event, { seq: from + index, recordingId }),
    }));

  it('hands the player resolved events, and counts what stays unresolved', () => {
    const store = new SessionStore(SESSION_ID);

    store.addReplayLines(
      lines(
        [meta(1000), snapshot(1001, CSS), frame(1002, stylesheetRef(CSS)), frame(1003, stylesheetRef(OTHER_CSS))],
        0
      )
    );

    const [track] = store.tracks as Event[][];
    expect(frameCss(track[2])).toBe(CSS);
    expect(frameCss(track[3])).toBe('');
    expect(store.unresolvedStylesheets).toBe(1);
  });

  it('resolves for live playback that starts at a later snapshot', () => {
    const store = new SessionStore(SESSION_ID);
    // Initial load: the recording start, where the CSS was sent in full.
    store.addReplayLines(lines([meta(1000), snapshot(1001, CSS), frame(1002, CSS)], 0));
    // Live poll: a checkout five minutes later, the page and frame by reference only.
    store.addReplayLines(
      lines([meta(301000), snapshot(301001, stylesheetRef(CSS)), frame(301002, stylesheetRef(CSS))], 3)
    );

    const track = store.tracks[0] as Event[];
    const live = track.slice(liveStartIndex(track));
    expect(live.map((event) => event.timestamp)).toEqual([301000, 301001, 301002]);
    expect(pageCss(live[1])).toBe(CSS);
    expect(frameCss(live[2])).toBe(CSS);
    expect(store.unresolvedStylesheets).toBe(0);
  });

  it('keeps the event objects stable when overlapping pages repeat lines', () => {
    const store = new SessionStore(SESSION_ID);
    const first = lines([meta(1000), snapshot(1001, CSS), frame(1002, stylesheetRef(CSS))], 0);

    store.addReplayLines(first);
    const before = store.tracks[0];
    store.addReplayLines(first.slice(1));

    expect(store.tracks[0]).toEqual(before);
    store.tracks[0].forEach((event, index) => expect(event).toBe(before[index]));
    expect(store.unresolvedStylesheets).toBe(0);
  });

  it('starts over with a new recording that sends the CSS in full again', () => {
    const store = new SessionStore(SESSION_ID);
    store.addReplayLines(lines([meta(1000), snapshot(1001, CSS)], 0, 'rec1'));
    store.addReplayLines(
      lines([meta(5000), snapshot(5001, OTHER_CSS), frame(5002, stylesheetRef(OTHER_CSS))], 0, 'rec2')
    );

    const track = store.tracks[0] as Event[];
    expect(frameCss(track[track.length - 1])).toBe(OTHER_CSS);
    expect(store.unresolvedStylesheets).toBe(0);
  });
});
