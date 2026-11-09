jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { LOKI_PAGE_SIZE, REPLAY_PAGE_SIZE } from '../constants';
import type { LokiLine } from '../types';
import { REAL_IFRAME_LINE_START, REAL_META_LINE, replayLine, SESSION_ID } from './fixtures';
import { STREAMS } from './logql';
import type { LokiFetcher } from './loki';
import {
  buildRecordings,
  CHUNK_AFTER_MS,
  CHUNK_BEFORE_MS,
  chunkQuery,
  fetchChunk,
  fetchReplayIndex,
  indexQuery,
  lastLineQuery,
  META_LINE_FILTER,
  parseLastLine,
  parseMetaLines,
  type LastLine,
  type MetaLine,
} from './replaySource';

/** What Loki's `|=` looks for: the string literal after the operator, unquoted. */
const lineFilterText = (filter: string) => JSON.parse(filter.replace(/^ \|= /, ''));
const meta = (timestamp: number) => ({ type: 4, timestamp, data: { href: 'https://x/', width: 1, height: 1 } });
const incremental = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, positions: [] } });
const BUCKETED = '{source="faro_replay", replay="payload", session_bucket="212"}';

describe('replay index queries', () => {
  it('finds Meta lines exactly as Faro writes them, and not the timestamp-first iframe events', () => {
    const text = lineFilterText(META_LINE_FILTER);

    expect(META_LINE_FILTER).toBe(' |= "event_data_event=\\"{\\\\\\"type\\\\\\":4,"');
    expect(text).toBe('event_data_event="{\\"type\\":4,');
    expect(REAL_META_LINE.includes(text)).toBe(true);
    expect(REAL_IFRAME_LINE_START.includes(text)).toBe(false);
    expect(replayLine(meta(1)).includes(text)).toBe(true);
    expect(replayLine(incremental(1)).includes(text)).toBe(false);
  });

  it('narrows to the session, then to Metas', () => {
    expect(indexQuery(BUCKETED, 'XNtXWqeUtk')).toBe(`${BUCKETED} |= "session_id=XNtXWqeUtk"${META_LINE_FILTER}`);
  });

  it('selects one chunk by gen and recording, exactly (gen 1 is not gen 10)', () => {
    const expr = chunkQuery(STREAMS.payloads, 'L9AwCzx15r', 0);
    const text = lineFilterText(expr.slice(STREAMS.payloads.length));

    expect(expr).toBe(`${STREAMS.payloads} |= " event_data_gen=0 event_data_recording_id=L9AwCzx15r "`);
    expect(REAL_META_LINE.includes(text)).toBe(true);
    expect(REAL_IFRAME_LINE_START.includes(text)).toBe(true);
    const gen1 = lineFilterText(chunkQuery(STREAMS.payloads, 'rec1', 1).slice(STREAMS.payloads.length));
    expect(replayLine(incremental(1), { gen: 1 }).includes(gen1)).toBe(true);
    expect(replayLine(incremental(1), { gen: 10 }).includes(gen1)).toBe(false);
    expect(replayLine(incremental(1), { gen: 1, recordingId: 'rec10' }).includes(gen1)).toBe(false);
  });

  it("asks for a recording's newest line by its exact id", () => {
    expect(lastLineQuery(STREAMS.payloads, 'abc', 'rec1')).toBe(
      `${STREAMS.payloads} |= "session_id=abc" |= " event_data_recording_id=rec1 "`
    );
    expect(lastLineQuery(STREAMS.payloads, 'abc')).toBe(`${STREAMS.payloads} |= "session_id=abc"`);
  });
});

describe('parseMetaLines', () => {
  it('reads the real line', () => {
    const [parsed] = parseMetaLines([{ tsNs: '1794212049344657671', line: REAL_META_LINE }], 'XNtXWqeUtk');

    expect(parsed).toMatchObject({
      key: 'L9AwCzx15r:0:0',
      recordingId: 'L9AwCzx15r',
      gen: 0,
      seq: 0,
      lokiNs: '1794212049344657671',
      event: { type: 4, timestamp: 1794212047357, data: { href: 'https://ppd.ajaska.de/', width: 2554 } },
    });
  });

  it('keeps only the session itself (the line filter also matches longer ids), Metas only, each once', () => {
    const lines: LokiLine[] = [
      { tsNs: '3000000', line: replayLine(meta(1000), { seq: 0 }) },
      // A retried batch: the same Meta arrives again later.
      { tsNs: '9000000', line: replayLine(meta(1000), { seq: 0 }) },
      { tsNs: '4000000', line: replayLine(meta(1000), { seq: 0, sessionId: `${SESSION_ID}x` }) },
      { tsNs: '5000000', line: replayLine(incremental(1001), { seq: 1 }) },
      {
        tsNs: '6000000',
        line: replayLine(meta(2000), { seq: 7, gen: 1 }).replace(
          /event_data_event="[^ ]*/,
          'event_data_event="{broken"'
        ),
      },
    ];

    const parsed = parseMetaLines(lines, SESSION_ID);

    expect(parsed.map((entry) => [entry.key, entry.lokiNs])).toEqual([['rec1:0:0', '3000000']]);
  });
});

describe('buildRecordings', () => {
  const metaLine = (recordingId: string, gen: number, timestamp: number, lokiMs: number, seq = gen * 10): MetaLine => ({
    key: `${recordingId}:${gen}:${seq}`,
    recordingId,
    gen,
    seq,
    event: meta(timestamp) as never,
    lokiNs: `${lokiMs}000000`,
  });
  const last = (recordingId: string, gen: number, timestamp: number, lokiMs: number): LastLine => ({
    recordingId,
    gen,
    timestamp,
    lokiNs: `${lokiMs}000000`,
  });
  const min = 60_000;

  it('windows every gen in Loki time from its Meta to the next one, with slack', () => {
    // Loki time lags the browser clock by 90 s here.
    const [recording] = buildRecordings(
      [metaLine('r', 0, 0, 90_000), metaLine('r', 1, 5 * min, 5 * min + 90_000)],
      [last('r', 1, 9 * min, 9 * min + 90_000)]
    );

    expect(recording).toMatchObject({ recordingId: 'r', startMs: 0, endMs: 9 * min, lastLokiMs: 9 * min + 90_000 });
    expect(recording.gens.map((gen) => [gen.gen, gen.startMs, gen.window])).toEqual([
      [0, 0, { fromMs: 90_000 - CHUNK_BEFORE_MS, toMs: 5 * min + 90_000 + CHUNK_AFTER_MS }],
      [1, 5 * min, { fromMs: 5 * min + 90_000 - CHUNK_BEFORE_MS, toMs: 9 * min + 90_000 + CHUNK_AFTER_MS }],
    ]);
  });

  it('lists gens without Meta (between and after), estimated and depending on the gen before', () => {
    const [recording] = buildRecordings(
      [metaLine('r', 0, 0, 1000), metaLine('r', 3, 15 * min, 15 * min + 1000)],
      [last('r', 5, 25 * min, 25 * min + 1000)]
    );

    expect(recording.gens.map((gen) => [gen.gen, gen.startMs, gen.dependsOn, gen.meta !== undefined])).toEqual([
      [0, 0, undefined, true],
      [1, 5 * min, 0, false],
      [2, 10 * min, 1, false],
      [3, 15 * min, undefined, true],
      // After the last Meta: shares of the time up to the recording's end (the last gen runs until then).
      [4, 15 * min + (10 * min) / 3, 3, false],
      [5, 15 * min + (20 * min) / 3, 4, false],
    ]);
    // Windowed by the Metas around them.
    expect(recording.gens[1].window).toEqual({
      fromMs: 1000 - CHUNK_BEFORE_MS,
      toMs: 15 * min + 1000 + CHUNK_AFTER_MS,
    });
    expect(recording.gens[5].window.toMs).toBe(25 * min + 1000 + CHUNK_AFTER_MS);
  });

  it('starts at the first Meta, keeps the first Meta of a gen, and sorts recordings by start', () => {
    const recordings = buildRecordings(
      [
        metaLine('late', 0, 50_000, 51_000),
        metaLine('early', 2, 10_000, 11_000, 30),
        metaLine('early', 2, 12_000, 12_000, 31),
      ],
      []
    );

    expect(recordings.map((recording) => [recording.recordingId, recording.startMs, recording.gens.length])).toEqual([
      ['early', 10_000, 1],
      ['late', 50_000, 1],
    ]);
    expect(recordings[0].gens[0].gen).toBe(2);
  });

  it('reads the newest line of a recording', () => {
    const entry = { tsNs: '1794212210595813415', line: `${REAL_IFRAME_LINE_START}` };

    expect(parseLastLine(entry, 'XNtXWqeUtk')).toEqual({
      recordingId: 'L9AwCzx15r',
      gen: 0,
      timestamp: 1794212198380,
      lokiNs: '1794212210595813415',
    });
    expect(parseLastLine(entry, 'XNtXWqeUt')).toBeUndefined();
  });
});

describe('fetchReplayIndex', () => {
  const range = { from: 1_000_000, to: 9_000_000 };
  const answer = (respond: (args: Parameters<LokiFetcher>[0]) => LokiLine[]) => {
    const calls: Array<Parameters<LokiFetcher>[0]> = [];
    const fetcher: LokiFetcher = async (args) => {
      calls.push(args);
      return respond(args);
    };
    return { calls, fetcher };
  };
  const at = (ms: number) => `${ms}000000`;

  it('reads Metas and the newest line of every recording on the session bucket', async () => {
    const lines = {
      metas: [
        { tsNs: at(2_000_000), line: replayLine(meta(2_000_000), { recordingId: 'tabA' }) },
        { tsNs: at(3_000_000), line: replayLine(meta(3_000_000), { recordingId: 'tabB' }) },
      ],
      sessionNewest: {
        tsNs: at(8_000_000),
        line: replayLine(incremental(8_000_000), { recordingId: 'tabA', gen: 3, seq: 9 }),
      },
      tabBNewest: { tsNs: at(4_000_000), line: replayLine(incremental(4_000_000), { recordingId: 'tabB', seq: 5 }) },
    };
    const { calls, fetcher } = answer(({ expr, direction }) => {
      if (expr.endsWith(META_LINE_FILTER)) {
        return lines.metas;
      }
      if (direction === 'backward') {
        return expr.includes('tabB') ? [lines.tabBNewest] : [lines.sessionNewest];
      }
      return [];
    });
    const signal = new AbortController().signal;

    const index = await fetchReplayIndex(fetcher, SESSION_ID, range, { count: 256, sinceMs: 0 }, signal);

    expect(index.stream).toMatch(/^\{source="faro_replay", replay="payload", session_bucket="\d{3}"\}$/);
    expect(index.lastLokiNs).toBe(at(8_000_000));
    expect(
      index.recordings.map((recording) => [recording.recordingId, recording.gens.length, recording.endMs])
    ).toEqual([
      ['tabA', 4, 8_000_000],
      ['tabB', 1, 4_000_000],
    ]);
    expect(calls.every((call) => call.expr.startsWith(index.stream) && call.signal === signal)).toBe(true);
    expect(calls.find((call) => call.expr.endsWith(META_LINE_FILTER))).toMatchObject({ limit: LOKI_PAGE_SIZE });
    // One newest line for the session (tabA's), one for tabB alone; all limit 1, backward.
    const newest = calls.filter((call) => call.direction === 'backward');
    expect(newest.map((call) => call.expr.includes('event_data_recording_id'))).toEqual([false, true]);
    expect(newest.every((call) => call.limit === 1 && call.fromMs === range.from && call.toMs === range.to)).toBe(true);
  });

  it('reads the whole stream when the bucket holds nothing of the session', async () => {
    const { calls, fetcher } = answer(({ expr }) =>
      expr.startsWith(`${STREAMS.payloads} `) && expr.endsWith(META_LINE_FILTER)
        ? [{ tsNs: at(2_000_000), line: replayLine(meta(2_000_000)) }]
        : []
    );

    const index = await fetchReplayIndex(fetcher, SESSION_ID, range, { count: 256, sinceMs: 0 });

    expect(index.stream).toBe(STREAMS.payloads);
    expect(index.recordings).toHaveLength(1);
    expect(calls[0].expr.startsWith('{source="faro_replay", replay="payload", session_bucket=')).toBe(true);
  });

  it('reads the whole stream for a session from before the switch', async () => {
    const { calls, fetcher } = answer(() => []);

    const index = await fetchReplayIndex(fetcher, SESSION_ID, range, { count: 256, sinceMs: range.from + 1 });

    expect(index).toEqual({ stream: STREAMS.payloads, recordings: [], lastLokiNs: undefined });
    expect(calls.every((call) => call.expr.startsWith(`${STREAMS.payloads} `))).toBe(true);
  });
});

describe('fetchChunk', () => {
  it("reads the chunk's window in replay-sized pages and keeps only its own events", async () => {
    const calls: Array<Parameters<LokiFetcher>[0]> = [];
    const fetcher: LokiFetcher = async (args) => {
      calls.push(args);
      return [
        { tsNs: '1', line: replayLine(meta(1000), { gen: 2, seq: 0 }) },
        { tsNs: '2', line: replayLine(incremental(1001), { gen: 2, seq: 1 }) },
        // Page content quoting the filter text: another gen, parsed apart.
        {
          tsNs: '3',
          line: replayLine(
            { type: 3, timestamp: 1002, data: { text: ' event_data_gen=2 event_data_recording_id=rec1 ' } },
            { gen: 3, seq: 2 }
          ),
        },
        { tsNs: '4', line: replayLine(incremental(1003), { gen: 2, seq: 3, sessionId: 'other' }) },
      ];
    };

    const chunk = await fetchChunk(fetcher, BUCKETED, SESSION_ID, {
      recordingId: 'rec1',
      gen: 2,
      window: { fromMs: 10, toMs: 20 },
    });

    expect(chunk.events.map((entry) => entry.key)).toEqual(['rec1:2:0', 'rec1:2:1']);
    expect(calls[0]).toMatchObject({
      expr: chunkQuery(BUCKETED, 'rec1', 2),
      fromMs: 10,
      toMs: 20,
      limit: REPLAY_PAGE_SIZE,
      direction: 'forward',
    });
  });
});
