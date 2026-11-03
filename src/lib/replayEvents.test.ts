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

/** Lines of one recording: meta, full snapshot, then incremental events. */
function recording(recordingId: string, start: number, increments: number[], sessionId = SESSION_ID) {
  return [
    replayLine(meta(start, `https://x/${recordingId}`), { recordingId, seq: 0, sessionId }),
    replayLine(snapshot(start + 1), { recordingId, seq: 1, sessionId }),
    ...increments.map((ts, i) => replayLine(incremental(ts), { recordingId, seq: i + 2, sessionId })),
  ].map((line) => ({ line }));
}

const stamps = (track: Array<{ type: number; timestamp: number }>) =>
  track.map((event) => [event.type, event.timestamp]);

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
    const tracks = mergeReplayEvents(known, second);

    expect(tracks).toHaveLength(1);
    expect(stamps(tracks[0])).toEqual([
      [4, 1999],
      [2, 2000],
      [3, 2500],
    ]);
  });

  it('plays a reload (next recording) after the earlier one on the same track', () => {
    const known = new Map<string, DecodedReplayEvent>();
    const { decoded } = decodeReplayLines(
      [...recording('rec2', 5000, [5100]), ...recording('rec1', 1000, [1100])],
      SESSION_ID
    );

    const tracks = mergeReplayEvents(known, decoded);

    expect(tracks).toHaveLength(1);
    expect(stamps(tracks[0]).map(([, ts]) => ts)).toEqual([1000, 1001, 1100, 5000, 5001, 5100]);
  });

  it('puts recordings that overlap in time (two tabs) on separate tracks', () => {
    const known = new Map<string, DecodedReplayEvent>();
    const { decoded } = decodeReplayLines(
      [
        ...recording('tabA', 1000, [1500, 3000]),
        ...recording('tabB', 2000, [2500]),
        ...recording('tabA2', 4000, [4100]),
      ],
      SESSION_ID
    );

    const tracks = mergeReplayEvents(known, decoded);

    expect(tracks.map((track) => track.map((event) => event.timestamp))).toEqual([
      [1000, 1001, 1500, 3000, 4000, 4001, 4100],
      [2000, 2001, 2500],
    ]);
  });

  it('keeps distinct events without recording id that share timestamp and type (replay < 2.13)', () => {
    const legacy = (payload: Record<string, unknown>) =>
      replayLine(payload)
        .replace(/ event_data_recording_id=\S+/, '')
        .replace(/ event_data_gen=\S+/, '')
        .replace(/ event_data_seq=\S+/, '');
    const known = new Map<string, DecodedReplayEvent>();
    const lines = [
      legacy(meta(1000)),
      legacy(snapshot(1001)),
      legacy({ type: 3, timestamp: 1002, data: { source: 2, id: 1 } }),
      legacy({ type: 3, timestamp: 1002, data: { source: 2, id: 2 } }),
      legacy({ type: 3, timestamp: 1002, data: { source: 2, id: 2 } }),
    ].map((line) => ({ line }));

    const [track] = mergeReplayEvents(known, decodeReplayLines(lines, SESSION_ID).decoded);

    expect(track).toHaveLength(4);
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
