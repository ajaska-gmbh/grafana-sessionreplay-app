import type { eventWithTime } from '@grafana/rrweb-types';
import { LOKI_PAGE_SIZE, REPLAY_PAGE_SIZE } from '../constants';
import type { LokiLine } from '../types';
import { parseLogfmt } from './logfmt';
import { sessionLineFilter, sessionPayloads, STREAMS } from './logql';
import { compareNs, logqlString, readForward, type LokiFetcher } from './loki';
import { decodeReplayLines, REPLAY_EVENT_NAME, RRWEB_META, type DecodedReplayEvent } from './replayEvents';
import type { PayloadBuckets } from './sessionBucket';

/**
 * Where a session's replay lives in Loki, without loading it: the index.
 *
 * Faro's recorder writes every rrweb event as its own line with
 * `event_data_recording_id` (one per page load or tab), `event_data_gen` (bumped
 * at every checkout: a Meta + full snapshot, every 5 minutes) and
 * `event_data_seq`. A (recording, gen) — a chunk — is therefore playable on its
 * own: it starts with the DOM it needs. The index lists every chunk with its
 * rrweb start time and a Loki-time window to fetch it in, from the Meta lines
 * alone (about one small line per 5 minutes) and the last line of every
 * recording; chunks are then fetched in any order (chunkLoader).
 *
 * Two clocks: rrweb timestamps are the agent's browser clock (playback offsets
 * count in these); Loki time is when the line arrived (query windows use it).
 * They differ by the browser clock's error (can be hours) plus the send delay
 * (seen up to ~90 s), so one never stands in for the other.
 */

/**
 * The line filter for Meta events. Faro writes the rrweb event JSON as
 * `event_data_event="{\"type\":4,…`: Meta events always start with their type
 * (only events forwarded from cross-origin iframes start with their timestamp,
 * and those are never Metas). Pinned by tests against real lines.
 */
export const META_LINE_FILTER = ` |= ${logqlString('event_data_event="{\\"type\\":4,')}`;

/** Chunk windows start this long before the chunk's Meta arrived in Loki (lines of one batch arrive out of order). */
export const CHUNK_BEFORE_MS = 5 * 60 * 1000;
/** …and end this long after the next chunk's Meta (or the recording's last line): retried batches arrive late. */
export const CHUNK_AFTER_MS = 10 * 60 * 1000;

/** One checkout of one recording: what is fetched as one chunk. */
export interface GenIndex {
  recordingId: string;
  gen: number;
  /** The checkout's Meta event; none when its line was lost (the gen then depends on the one before). */
  meta?: eventWithTime;
  /** rrweb time the gen starts: its Meta, else estimated between its neighbours (until loaded). */
  startMs: number;
  /** Loki time of the Meta line (epoch ms). */
  lokiMs?: number;
  /** Loki-time window that holds the gen's lines. */
  window: { fromMs: number; toMs: number };
  /** A gen without Meta has no DOM of its own: the gen before it must be played first. */
  dependsOn?: number;
}

export interface RecordingIndex {
  recordingId: string;
  /** Contiguous gens, from the first one with a Meta to the last one seen. */
  gens: GenIndex[];
  /** rrweb time of the first gen's Meta. */
  startMs: number;
  /** rrweb time of the newest event known. */
  endMs: number;
  /** Loki time of the recording's newest line (epoch ms). */
  lastLokiMs: number;
}

export interface ReplayIndex {
  /** The payload selector the session was found on; chunks and live polls use it too. */
  stream: string;
  /** Sorted by start. */
  recordings: RecordingIndex[];
  /** Loki time of the newest payload line of the session (ns), where live polling starts. */
  lastLokiNs?: string;
}

/** A parsed Meta line. */
export interface MetaLine {
  key: string;
  recordingId: string;
  gen: number;
  seq: number;
  event: eventWithTime;
  lokiNs: string;
}

/** The newest line of a recording. */
export interface LastLine {
  recordingId: string;
  gen: number;
  /** rrweb time of its event. */
  timestamp: number;
  lokiNs: string;
}

export function nsToMs(tsNs: string): number {
  return Math.floor(Number(tsNs.slice(0, -6)) || 0);
}

/** Meta lines of one session (`|= session_id=` also matches longer ids: compared exactly here). */
export function indexQuery(stream: string, sessionId: string): string {
  return stream + sessionLineFilter(sessionId) + META_LINE_FILTER;
}

/**
 * The newest line of a session, or of one of its recordings. Faro writes
 * ` event_data_recording_id=<id> event_data_seq=` right after the event, so
 * the spaces make the id exact.
 */
export function lastLineQuery(stream: string, sessionId: string, recordingId?: string): string {
  return (
    stream +
    sessionLineFilter(sessionId) +
    (recordingId ? ` |= ${logqlString(` event_data_recording_id=${recordingId} `)}` : '')
  );
}

/**
 * One chunk's lines: Faro writes ` event_data_gen=<g> event_data_recording_id=<id> `
 * in this order right after the event (confirmed on live lines), so this one
 * filter selects exactly the gen of the recording.
 */
export function chunkQuery(stream: string, recordingId: string, gen: number): string {
  return stream + ` |= ${logqlString(` event_data_gen=${gen} event_data_recording_id=${recordingId} `)}`;
}

/** Fields of a replay line of `sessionId`, or undefined for anything else. */
function replayFields(line: string, sessionId: string): Record<string, string> | undefined {
  const fields = parseLogfmt(line);
  if (fields.event_name !== REPLAY_EVENT_NAME || fields.session_id !== sessionId || !fields.event_data_recording_id) {
    return undefined;
  }
  return fields;
}

function parseEvent(json: string | undefined): eventWithTime | undefined {
  try {
    const event = json ? JSON.parse(json) : undefined;
    return typeof event?.timestamp === 'number' && typeof event?.type === 'number' ? event : undefined;
  } catch {
    return undefined;
  }
}

/** The session's Meta lines, deduplicated by recording, gen and seq (batches are retried). */
export function parseMetaLines(lines: Iterable<LokiLine>, sessionId: string): MetaLine[] {
  const metas = new Map<string, MetaLine>();
  for (const { tsNs, line } of lines) {
    const fields = replayFields(line, sessionId);
    const event = fields && parseEvent(fields.event_data_event);
    if (!fields || !event || event.type !== RRWEB_META) {
      continue;
    }
    const recordingId = fields.event_data_recording_id;
    const gen = Number(fields.event_data_gen ?? 0) || 0;
    const seq = Number(fields.event_data_seq ?? 0) || 0;
    const key = `${recordingId}:${gen}:${seq}`;
    const known = metas.get(key);
    // A retried batch: keep the copy that arrived first.
    if (!known || compareNs(tsNs, known.lokiNs) < 0) {
      metas.set(key, { key, recordingId, gen, seq, event, lokiNs: tsNs });
    }
  }
  return [...metas.values()];
}

export function parseLastLine(entry: LokiLine, sessionId: string): LastLine | undefined {
  const fields = replayFields(entry.line, sessionId);
  const event = fields && parseEvent(fields.event_data_event);
  if (!fields || !event) {
    return undefined;
  }
  return {
    recordingId: fields.event_data_recording_id,
    gen: Number(fields.event_data_gen ?? 0) || 0,
    timestamp: event.timestamp,
    lokiNs: entry.tsNs,
  };
}

/**
 * The recordings and their gens from Meta lines and each recording's last
 * line. Gen numbers are contiguous, so a gen whose Meta never arrived (seen:
 * ~10 minutes of mutations only) is still listed, windowed by its neighbours
 * and depending on the gen before it. Gens before a recording's first Meta,
 * and recordings without any, cannot be played (no DOM) and are left out.
 */
export function buildRecordings(metaLines: MetaLine[], lastLines: LastLine[]): RecordingIndex[] {
  const byRecording = new Map<string, Map<number, MetaLine>>();
  for (const meta of metaLines) {
    const gens = byRecording.get(meta.recordingId) ?? new Map<number, MetaLine>();
    const known = gens.get(meta.gen);
    // One Meta per checkout; should a gen hold two, the first one starts it.
    if (!known || meta.seq < known.seq) {
      gens.set(meta.gen, meta);
    }
    byRecording.set(meta.recordingId, gens);
  }
  const lastByRecording = new Map(lastLines.map((last) => [last.recordingId, last]));

  const recordings: RecordingIndex[] = [];
  for (const [recordingId, metasByGen] of byRecording) {
    const metas = [...metasByGen.values()].sort((a, b) => a.gen - b.gen);
    const last = lastByRecording.get(recordingId);
    const lastMeta = metas[metas.length - 1];
    const lastGen = Math.max(lastMeta.gen, last?.gen ?? 0);
    const endMs = Math.max(lastMeta.event.timestamp, last?.timestamp ?? -Infinity);
    const lastLokiMs = Math.max(nsToMs(lastMeta.lokiNs), last ? nsToMs(last.lokiNs) : -Infinity);
    recordings.push({
      recordingId,
      gens: gensOf(recordingId, metas, lastGen, endMs, lastLokiMs),
      startMs: metas[0].event.timestamp,
      endMs,
      lastLokiMs,
    });
  }
  return recordings.sort((a, b) => a.startMs - b.startMs);
}

function gensOf(
  recordingId: string,
  metas: MetaLine[],
  lastGen: number,
  endMs: number,
  lastLokiMs: number
): GenIndex[] {
  const gens: GenIndex[] = [];
  let m = 0;
  for (let gen = metas[0].gen; gen <= lastGen; gen++) {
    while (m + 1 < metas.length && metas[m + 1].gen <= gen) {
      m++;
    }
    const before = metas[m];
    const after = metas[m + 1];
    const own = before.gen === gen ? before : undefined;
    const fromMs = nsToMs(before.lokiNs) - CHUNK_BEFORE_MS;
    const toMs = (after ? nsToMs(after.lokiNs) : lastLokiMs) + CHUNK_AFTER_MS;
    if (own) {
      gens.push({
        recordingId,
        gen,
        meta: own.event,
        startMs: own.event.timestamp,
        lokiMs: nsToMs(own.lokiNs),
        window: { fromMs, toMs },
      });
      continue;
    }
    // No Meta: estimated in proportion between the neighbours' starts (corrected once loaded).
    const nextGen = after ? after.gen : lastGen + 1;
    const nextStart = after ? after.event.timestamp : Math.max(endMs, before.event.timestamp);
    const share = (gen - before.gen) / (nextGen - before.gen);
    gens.push({
      recordingId,
      gen,
      startMs: Math.round(before.event.timestamp + (nextStart - before.event.timestamp) * share),
      window: { fromMs, toMs },
      dependsOn: gen - 1,
    });
  }
  return gens;
}

async function readAll(
  fetcher: LokiFetcher,
  expr: string,
  fromMs: number,
  toMs: number,
  pageSize: number,
  signal?: AbortSignal
): Promise<LokiLine[]> {
  const lines: LokiLine[] = [];
  for await (const page of readForward(fetcher, expr, fromMs, toMs, pageSize, signal)) {
    for (const entry of page) {
      lines.push(entry);
    }
  }
  return lines;
}

async function newestLine(
  fetcher: LokiFetcher,
  expr: string,
  range: { from: number; to: number },
  sessionId: string,
  signal?: AbortSignal
): Promise<LastLine | undefined> {
  const lines = await fetcher({ expr, fromMs: range.from, toMs: range.to, limit: 1, direction: 'backward', signal });
  return lines.length > 0 ? parseLastLine(lines[0], sessionId) : undefined;
}

/** Index of the session's replay on one payload selector. */
async function indexOn(
  fetcher: LokiFetcher,
  stream: string,
  sessionId: string,
  range: { from: number; to: number },
  signal?: AbortSignal
): Promise<ReplayIndex> {
  // The session's newest line is asked for at once: with one recording (the
  // usual case) it is that recording's end, and no further query is needed.
  const [metaLines, sessionLast] = await Promise.all([
    readAll(fetcher, indexQuery(stream, sessionId), range.from, range.to, LOKI_PAGE_SIZE, signal).then((lines) =>
      parseMetaLines(lines, sessionId)
    ),
    newestLine(fetcher, lastLineQuery(stream, sessionId), range, sessionId, signal),
  ]);
  const recordingIds = [...new Set(metaLines.map((meta) => meta.recordingId))];
  const lastLines = await Promise.all(
    recordingIds.map((recordingId) =>
      sessionLast?.recordingId === recordingId
        ? sessionLast
        : newestLine(fetcher, lastLineQuery(stream, sessionId, recordingId), range, sessionId, signal)
    )
  );
  const known = lastLines.filter((last): last is LastLine => last !== undefined);
  let lastLokiNs = sessionLast?.lokiNs;
  for (const candidate of [...known.map((last) => last.lokiNs), ...metaLines.map((meta) => meta.lokiNs)]) {
    if (lastLokiNs === undefined || compareNs(candidate, lastLokiNs) > 0) {
      lastLokiNs = candidate;
    }
  }
  return { stream, recordings: buildRecordings(metaLines, known), lastLokiNs };
}

/**
 * The session's index on its payload selector: its own bucket when it started
 * after the pipeline labelled buckets; when that holds nothing (a session from
 * before, seen through an agent clock running ahead), the whole stream.
 */
export async function fetchReplayIndex(
  fetcher: LokiFetcher,
  sessionId: string,
  range: { from: number; to: number },
  buckets?: PayloadBuckets,
  signal?: AbortSignal
): Promise<ReplayIndex> {
  const stream = sessionPayloads(sessionId, range.from, buckets);
  const index = await indexOn(fetcher, stream, sessionId, range, signal);
  if (index.recordings.length > 0 || index.lastLokiNs !== undefined || stream === STREAMS.payloads) {
    return index;
  }
  return indexOn(fetcher, STREAMS.payloads, sessionId, range, signal);
}

/** The events of one chunk, in Loki pages of REPLAY_PAGE_SIZE (DOM snapshots are large). */
export async function fetchChunk(
  fetcher: LokiFetcher,
  stream: string,
  sessionId: string,
  gen: Pick<GenIndex, 'recordingId' | 'gen' | 'window'>,
  signal?: AbortSignal
): Promise<{ events: DecodedReplayEvent[]; skipped: number }> {
  const lines = await readAll(
    fetcher,
    chunkQuery(stream, gen.recordingId, gen.gen),
    gen.window.fromMs,
    gen.window.toMs,
    REPLAY_PAGE_SIZE,
    signal
  );
  const { decoded, skipped } = decodeReplayLines(lines, sessionId);
  // The filter also matches page content quoting it; the parsed fields decide.
  return {
    events: decoded.filter((entry) => entry.recordingId === gen.recordingId && entry.gen === gen.gen),
    skipped,
  };
}
