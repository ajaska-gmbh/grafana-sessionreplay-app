jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));
// The real parser, counted: the store must not parse a line twice.
jest.mock('./audioLevels', () => {
  const actual = jest.requireActual('./audioLevels');
  return { ...actual, parseAudioLevelLine: jest.fn(actual.parseAudioLevelLine) };
});

import { parseAudioLevelLine } from './audioLevels';
import { LIVE_WINDOW_MS, SessionStore } from './sessionStore';
import { chunksOf, fetchLine, indexFromLines, logLine, replayLine, SESSION_ID, trackEvents } from './fixtures';

const meta = (timestamp: number) => ({ type: 4, timestamp, data: { href: 'https://x/', width: 1, height: 1 } });
const snapshot = (timestamp: number) => ({
  type: 2,
  timestamp,
  data: { node: {}, initialOffset: { top: 0, left: 0 } },
});
const incremental = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, positions: [] } });

describe('SessionStore', () => {
  it('continues live where the index ended, free of duplicates where polls overlap', () => {
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

    store.setIndex(indexFromLines(first));
    expect(store.replayCursorMs(0)).toBe(1000000);
    expect(store.lastReplayMs).toBe(1000000);
    store.replay.addChunk('rec1:0', chunksOf(first).get('rec1:0')!);
    store.addReplayLines(second);

    expect(store.tracks).toHaveLength(1);
    expect(trackEvents(store.tracks[0]).map((event) => event.timestamp)).toEqual([1000, 1001, 1500]);
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

  it('keeps the audio levels of overlapping polls once, sorted, and moves their cursor', () => {
    const level = (time: string, avg: number) =>
      `timestamp="2026-11-04 12:33:${time} +0000 UTC" kind=measurement type=twilio_audio_level value_agent_mic_avg=${avg} value_samples=20 value_window_ms=1000 session_id=${SESSION_ID}`;
    const store = new SessionStore(SESSION_ID);
    const first = { tsNs: '1793795622000000000', line: level('42.000', 0.1) };
    const second = { tsNs: '1793795623000000000', line: level('43.000', 0.2) };

    store.addAudioLevelLines([second, first]);
    store.addAudioLevelLines([second]);

    expect(store.audioLevels.map((window) => window.agentAvg)).toEqual([0.1, 0.2]);
    expect(store.audioLevelCursorMs(0)).toBe(1793795623000);
    expect(new SessionStore(SESSION_ID).audioLevelCursorMs(42)).toBe(42);
  });

  it('parses each level line once, however often polls repeat it', () => {
    const spy = jest.mocked(parseAudioLevelLine);
    spy.mockClear();
    const line = (second: number) => ({
      tsNs: `17937956${20 + second}000000000`,
      line: `timestamp="2026-11-04 12:33:${String(second).padStart(2, '0')}.000 +0000 UTC" kind=measurement type=twilio_audio_level value_samples=20 value_window_ms=1000 session_id=${SESSION_ID}`,
    });
    const store = new SessionStore(SESSION_ID);

    store.addAudioLevelLines([line(1), line(2)]);
    const first = store.audioLevels;
    store.addAudioLevelLines([line(2), line(3)]);
    store.addAudioLevelLines([line(3)]);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(store.audioLevels).toHaveLength(3);
    expect(store.audioLevels).not.toBe(first);
  });

  it('uses the fallback cursor before anything was loaded', () => {
    const store = new SessionStore(SESSION_ID);

    expect(store.replayCursorMs(42)).toBe(42);
    expect(store.journeyCursorMs(43)).toBe(43);
    expect(store.isActive(Date.now())).toBe(false);
  });

  it('is active while replay data arrived within the live window', () => {
    const store = new SessionStore(SESSION_ID);
    store.setIndex(indexFromLines([{ tsNs: '1000000000000000', line: replayLine(meta(1)) }]));

    expect(store.isActive(1_000_000_000 + LIVE_WINDOW_MS - 1)).toBe(true);
    expect(store.isActive(1_000_000_000 + LIVE_WINDOW_MS + 1)).toBe(false);
  });
});
