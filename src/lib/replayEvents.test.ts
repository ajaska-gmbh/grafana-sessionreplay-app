import { chunkKey, decodeReplayLines, ReplayTimeline } from './replayEvents';
import { chunksOf, indexFromLines, linesOf, loadedTimeline, replayLine, SESSION_ID, trackEvents } from './fixtures';

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

type Event = Record<string, unknown> & { timestamp: number };

/** One recording: per gen a Meta + full snapshot, then incremental events. */
function recording(recordingId: string, gens: Array<{ start: number; increments: number[] }>) {
  return gens.flatMap(({ start, increments }, gen) => [
    { event: meta(start, `https://x/${recordingId}`) as Event, recordingId, gen },
    { event: snapshot(start + 1) as Event, recordingId, gen },
    ...increments.map((ts) => ({ event: incremental(ts) as Event, recordingId, gen })),
  ]);
}

const times = (events: ReadonlyArray<{ timestamp: number }>) => events.map((event) => event.timestamp);

describe('ReplayTimeline', () => {
  it('knows tracks, lengths and chunks from the index before anything is loaded', () => {
    const lines = linesOf(
      recording('rec1', [
        { start: 1000, increments: [1500] },
        { start: 301000, increments: [400000] },
      ])
    );
    const timeline = new ReplayTimeline(indexFromLines(lines));

    const [track] = timeline.tracks;
    expect(track).toMatchObject({ key: 'rec1', startMs: 1000, endMs: 400000 });
    expect(track.anchor).toMatchObject({ type: 4, timestamp: 1000 });
    expect(track.chunks.map((chunk) => [chunk.key, chunk.startMs, chunk.endMs, chunk.loaded])).toEqual([
      ['rec1:0', 1000, 301000, false],
      ['rec1:1', 301000, 400000, false],
    ]);
    expect(track.pages.map((page) => page.timestamp)).toEqual([1000, 301000]);
  });

  it('fills chunks in any order; each sorted, de-duplicated, the index Meta object kept', () => {
    const lines = linesOf(
      recording('rec1', [
        { start: 1000, increments: [1500, 1200] },
        { start: 301000, increments: [] },
      ])
    );
    const chunks = chunksOf(lines);
    const timeline = new ReplayTimeline(indexFromLines(lines));
    const anchor = timeline.tracks[0].anchor;

    timeline.addChunk('rec1:1', chunks.get('rec1:1')!);
    const afterFirst = timeline.tracks[0];
    timeline.addChunk('rec1:0', [...chunks.get('rec1:0')!, ...chunks.get('rec1:0')!]);

    const [track] = timeline.tracks;
    expect(times(track.chunks[0].events)).toEqual([1000, 1001, 1200, 1500]);
    expect(track.chunks[0].events[0]).toBe(anchor);
    // The chunk loaded before is the same object: the player sees what changed.
    expect(track.chunks[1]).toBe(afterFirst.chunks[1]);
    expect(track.chunks.every((chunk) => chunk.loaded)).toBe(true);
  });

  it('plays a reload (next recording) after the earlier one on the same track', () => {
    const lines = linesOf([
      ...recording('rec2', [{ start: 5000, increments: [5100] }]),
      ...recording('rec1', [{ start: 1000, increments: [1100] }]),
    ]);

    const tracks = loadedTimeline(lines).tracks;

    expect(tracks).toHaveLength(1);
    expect(times(trackEvents(tracks[0]))).toEqual([1000, 1001, 1100, 5000, 5001, 5100]);
  });

  it('puts recordings that overlap in time (two tabs) on separate tracks', () => {
    const lines = linesOf([
      ...recording('tabA', [{ start: 1000, increments: [1500, 3000] }]),
      ...recording('tabB', [{ start: 2000, increments: [2500] }]),
      ...recording('tabA2', [{ start: 4000, increments: [4100] }]),
    ]);

    const tracks = loadedTimeline(lines).tracks;

    expect(tracks.map((track) => times(trackEvents(track)))).toEqual([
      [1000, 1001, 1500, 3000, 4000, 4001, 4100],
      [2000, 2001, 2500],
    ]);
    expect(tracks.map((track) => track.key)).toEqual(['tabA', 'tabB']);
  });

  it("drops what comes before a recording's first Meta (it would move the track start)", () => {
    const lines = linesOf([
      { event: incremental(900) as Event },
      ...recording('rec1', [{ start: 1000, increments: [1100] }]),
    ]);

    const [track] = loadedTimeline(lines).tracks;

    expect(times(trackEvents(track))).toEqual([1000, 1001, 1100]);
  });

  it('ignores lines without recording id (replay < 2.13): they cannot be indexed', () => {
    const legacy = replayLine(meta(1000)).replace(
      / event_data_gen=\S+ event_data_recording_id=\S+ event_data_seq=\S+/,
      ''
    );

    expect(new ReplayTimeline(indexFromLines([{ tsNs: '1000000000', line: legacy }])).tracks).toEqual([]);
  });

  describe('a gen whose Meta never arrived', () => {
    const lines = linesOf([
      ...recording('rec1', [{ start: 1000, increments: [2000] }]),
      { event: incremental(310000) as Event, gen: 1 },
      { event: incremental(320000) as Event, gen: 1 },
      ...recording('rec1', [{ start: 601000, increments: [] }]).map((entry) => ({ ...entry, gen: 2 })),
    ]);

    it('depends on the gen before it, starts at an estimate, then at its first event', () => {
      const timeline = new ReplayTimeline(indexFromLines(lines));
      const estimated = timeline.tracks[0].chunks[1];
      expect(estimated).toMatchObject({ key: 'rec1:1', dependsOn: 'rec1:0', startMs: 301000 });

      timeline.addChunk('rec1:1', chunksOf(lines).get('rec1:1')!);

      const [first, gen1] = timeline.tracks[0].chunks;
      expect(gen1.startMs).toBe(310000);
      expect(first.endMs).toBe(310000);
    });
  });

  describe('live', () => {
    const initial = linesOf(recording('rec1', [{ start: 1000, increments: [1500] }]));

    it('appends to a loaded chunk, and starts new gens and tabs whole', () => {
      const timeline = loadedTimeline(initial);
      const more = linesOf([
        { event: incremental(1600) as Event },
        ...recording('rec1', [{ start: 301000, increments: [302000] }]).map((entry) => ({ ...entry, gen: 1 })),
        ...recording('tab2', [{ start: 1700, increments: [1800] }]),
      ]).map((entry, index) => ({
        ...entry,
        line: entry.line.replace(/event_data_seq=\d+/, `event_data_seq=${100 + index}`),
      }));

      timeline.addLive(decodeReplayLines(more, SESSION_ID).decoded);

      const [first, second] = timeline.tracks;
      expect(times(trackEvents(first))).toEqual([1000, 1001, 1500, 1600, 301000, 301001, 302000]);
      expect(first.chunks.map((chunk) => [chunk.key, chunk.loaded])).toEqual([
        ['rec1:0', true],
        ['rec1:1', true],
      ]);
      expect(first.endMs).toBe(302000);
      expect(second.key).toBe('tab2');
      expect(times(trackEvents(second))).toEqual([1700, 1701, 1800]);
    });

    it('keeps lines of a chunk not loaded yet until it is, then merges them', () => {
      const timeline = new ReplayTimeline(indexFromLines(initial));
      const late = linesOf([{ event: incremental(1600) as Event }]).map((entry) => ({
        ...entry,
        line: entry.line.replace('event_data_seq=0', 'event_data_seq=99'),
      }));

      timeline.addLive(decodeReplayLines(late, SESSION_ID).decoded);
      expect(timeline.tracks[0].chunks[0]).toMatchObject({ loaded: false, events: [] });
      timeline.addChunk(chunkKey('rec1', 0), chunksOf(initial).get('rec1:0')!);

      expect(times(trackEvents(timeline.tracks[0]))).toEqual([1000, 1001, 1500, 1600]);
    });

    it("gives a new gen its Meta when that arrives after the gen's first mutations", () => {
      const timeline = loadedTimeline(initial);
      const gen1 = linesOf(
        recording('rec1', [{ start: 301000, increments: [301500] }]).map((entry) => ({ ...entry, gen: 1 }))
      );
      const decoded = decodeReplayLines(gen1, SESSION_ID).decoded.map((entry) => ({
        ...entry,
        key: `${entry.key}x`,
      }));

      // The mutation first: the gen starts without Meta, depending on gen 0.
      timeline.addLive(decoded.slice(2));
      expect(timeline.tracks[0].chunks[1]).toMatchObject({ dependsOn: 'rec1:0', startMs: 301500 });
      timeline.addLive(decoded.slice(0, 2));

      const [, chunk] = timeline.tracks[0].chunks;
      expect(chunk).toMatchObject({ startMs: 301000, dependsOn: undefined, loaded: true });
      expect(times(chunk.events)).toEqual([301000, 301001, 301500]);
      expect(timeline.tracks[0].pages.map((page) => page.href)).toEqual(['https://x/rec1', 'https://x/rec1']);
      expect(timeline.tracks[0].chunks[0].endMs).toBe(301000);
    });

    it('waits for the first Meta of a new tab before it plays', () => {
      const timeline = loadedTimeline(initial);
      // Opened while the first tab still records: a second track.
      const tab = linesOf(recording('tab2', [{ start: 1200, increments: [1300] }]));
      const decoded = decodeReplayLines(tab, SESSION_ID).decoded;

      timeline.addLive(decoded.slice(2));
      expect(timeline.tracks).toHaveLength(1);
      timeline.addLive(decoded.slice(0, 2));

      expect(times(trackEvents(timeline.tracks[1]))).toEqual([1200, 1201, 1300]);
    });
  });
});
