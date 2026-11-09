import { CLOCK_SLACK_MS } from '../constants';
import { linkOffset } from './playerEvents';
import { loadRange, type SessionSummary } from './sessions';

const session = { sessionId: 's', startedMs: 1_000_000, lastStartedMs: 9_000_000 } as SessionSummary;

describe('loadRange', () => {
  it('starts loading at the session start when the link starts later', () => {
    expect(loadRange({ from: 5_000_000, to: 8_000_000 }, session)).toEqual({
      from: 1_000_000 - CLOCK_SLACK_MS,
      to: 8_000_000,
    });
  });

  it('keeps a link that already starts earlier', () => {
    expect(loadRange({ from: 0, to: 8_000_000 }, session)).toEqual({ from: 0, to: 8_000_000 });
  });

  it('keeps the link when the session start is unknown', () => {
    expect(loadRange({ from: 5_000_000, to: 8_000_000 })).toEqual({ from: 5_000_000, to: 8_000_000 });
  });
});

describe('linkOffset', () => {
  // Recording from 1000 with checkouts (Meta + full snapshot) at 301000 and 601000: all in the index.
  const track = { startMs: 1000, pages: [{ timestamp: 1000 }, { timestamp: 301000 }, { timestamp: 601000 }] };

  it('is t itself when the link range starts at or before the recording', () => {
    expect(linkOffset(track, undefined, 5000)).toBe(5000);
    expect(linkOffset(track, 500, 5000)).toBe(5000);
  });

  it('counts t from the first page load or checkout at or after the link start, before anything loaded', () => {
    // A link whose range started at 250000 played from the checkout at 301000.
    expect(linkOffset(track, 250_000, 5000)).toBe(301000 - 1000 + 5000);
    expect(linkOffset(track, 250_000)).toBe(300000);
  });

  it('is t when no checkout follows the link start', () => {
    expect(linkOffset(track, 700_000, 5000)).toBe(5000);
  });
});
