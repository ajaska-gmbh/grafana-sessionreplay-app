jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { LIVE_WINDOW_MS, SessionStore } from './sessionStore';
import { fetchLine, logLine, replayLine, SESSION_ID } from './fixtures';

const meta = (timestamp: number) => ({ type: 4, timestamp, data: { href: 'https://x/', width: 1, height: 1 } });
const snapshot = (timestamp: number) => ({
  type: 2,
  timestamp,
  data: { node: {}, initialOffset: { top: 0, left: 0 } },
});
const incremental = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, positions: [] } });

describe('SessionStore', () => {
  it('keeps polls that overlap the previous page free of duplicates', () => {
    const store = new SessionStore(SESSION_ID);
    const first = [
      { tsNs: '1000000000001', line: replayLine(meta(1000), { seq: 0 }) },
      { tsNs: '1000000000002', line: replayLine(snapshot(1001), { seq: 1 }) },
    ];
    // The next poll restarts in the same millisecond, so it sees line 2 again.
    const second = [
      { tsNs: '1000000000002', line: replayLine(snapshot(1001), { seq: 1 }) },
      { tsNs: '1003000000000', line: replayLine(incremental(1500), { seq: 2 }) },
    ];

    store.addReplayLines(first);
    expect(store.replayCursorMs(0)).toBe(1000000);
    store.addReplayLines(second);

    expect(store.tracks).toHaveLength(1);
    expect(store.tracks[0].map((event) => event.timestamp)).toEqual([1000, 1001, 1500]);
    expect(store.replayCursorMs(0)).toBe(1003000);
    expect(store.lastReplayMs).toBe(1003000);
  });

  it('builds the journey once per distinct line', () => {
    const store = new SessionStore(SESSION_ID);

    store.addJourneyLines([{ tsNs: '5000000000', line: fetchLine }]);
    store.addJourneyLines([
      { tsNs: '5000000000', line: fetchLine },
      { tsNs: '6000000000', line: logLine },
    ]);

    expect(store.journey).toHaveLength(2);
    expect(store.journeyCursorMs(0)).toBe(6000);
  });

  it('uses the fallback cursor before anything was loaded', () => {
    const store = new SessionStore(SESSION_ID);

    expect(store.replayCursorMs(42)).toBe(42);
    expect(store.journeyCursorMs(43)).toBe(43);
    expect(store.isActive(Date.now())).toBe(false);
  });

  it('is active while replay data arrived within the live window', () => {
    const store = new SessionStore(SESSION_ID);
    store.addReplayLines([{ tsNs: '1000000000000000', line: replayLine(meta(1)) }]);

    expect(store.isActive(1_000_000_000 + LIVE_WINDOW_MS - 1)).toBe(true);
    expect(store.isActive(1_000_000_000 + LIVE_WINDOW_MS + 1)).toBe(false);
  });
});
