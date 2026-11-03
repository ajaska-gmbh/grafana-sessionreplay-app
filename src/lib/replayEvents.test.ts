import { decodeReplayLines, mergeReplayEvents, playableEvents, type DecodedReplayEvent } from './replayEvents';
import { replayLine, SESSION_ID } from './fixtures';

const meta = (timestamp: number, href = 'https://x/') => ({
  type: 4,
  timestamp,
  data: { href, width: 1280, height: 720 },
});
const snapshot = (timestamp: number) => ({
  type: 2,
  timestamp,
  data: { node: {}, initialOffset: { top: 0, left: 0 } },
});
const incremental = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, positions: [] } });

describe('decodeReplayLines', () => {
  it('decodes rrweb events of the session and ignores other sessions', () => {
    const lines = [
      { line: replayLine(meta(1000), { seq: 0 }) },
      { line: replayLine(snapshot(1001), { seq: 1 }) },
      { line: replayLine(incremental(1002), { seq: 2, sessionId: 'otherSessn' }) },
    ];

    const { decoded, skipped } = decodeReplayLines(lines, SESSION_ID);

    expect(decoded.map((entry) => entry.event.type)).toEqual([4, 2]);
    expect(skipped).toBe(0);
  });

  it('counts undecodable payloads instead of failing', () => {
    const broken = replayLine(meta(1000)).replace(
      /event_data_event="[^"]*(\\"[^"]*)*"/,
      'event_data_event="{not json"'
    );

    const { decoded, skipped } = decodeReplayLines([{ line: broken }], SESSION_ID);

    expect(decoded).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});

describe('mergeReplayEvents', () => {
  it('de-duplicates by recording, gen and seq and sorts by timestamp', () => {
    const known = new Map<string, DecodedReplayEvent>();
    const first = decodeReplayLines(
      [{ line: replayLine(snapshot(2000), { seq: 1 }) }, { line: replayLine(meta(1999), { seq: 0 }) }],
      SESSION_ID
    ).decoded;
    const second = decodeReplayLines(
      [{ line: replayLine(snapshot(2000), { seq: 1 }) }, { line: replayLine(incremental(2500), { seq: 2 }) }],
      SESSION_ID
    ).decoded;

    mergeReplayEvents(known, first);
    const merged = mergeReplayEvents(known, second);

    expect(merged.map((event) => [event.type, event.timestamp])).toEqual([
      [4, 1999],
      [2, 2000],
      [3, 2500],
    ]);
  });

  it('keeps events of a reload (new recording) after the earlier one', () => {
    const known = new Map<string, DecodedReplayEvent>();
    const decoded = decodeReplayLines(
      [
        { line: replayLine(meta(5000, 'https://x/b'), { recordingId: 'rec2', seq: 0 }) },
        { line: replayLine(meta(1000, 'https://x/a'), { recordingId: 'rec1', seq: 0 }) },
      ],
      SESSION_ID
    ).decoded;

    const merged = mergeReplayEvents(known, decoded);

    expect(merged.map((event) => (event.data as { href: string }).href)).toEqual(['https://x/a', 'https://x/b']);
  });
});

describe('playableEvents', () => {
  it('starts at the closest meta before the first full snapshot', () => {
    const events = [incremental(900), meta(1000), incremental(1001), snapshot(1002), incremental(1003)] as never[];

    expect(playableEvents(events).map((event: { timestamp: number }) => event.timestamp)).toEqual([1000, 1002, 1003]);
  });

  it('returns nothing without a full snapshot', () => {
    expect(playableEvents([meta(1), incremental(2)] as never[])).toEqual([]);
  });
});
