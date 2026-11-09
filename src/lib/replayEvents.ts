import type { eventWithTime } from '@grafana/rrweb-types';
import { parseLogfmt } from './logfmt';
import type { GenIndex, ReplayIndex } from './replaySource';
import { mergeSorted } from './sorted';
import { StylesheetResolver } from './stylesheetRefs';

export const REPLAY_EVENT_NAME = 'faro.session_recording.event';

/** rrweb EventType values the player needs to start a recording. */
export const RRWEB_FULL_SNAPSHOT = 2;
export const RRWEB_META = 4;

export interface DecodedReplayEvent {
  key: string;
  /** One recording per page load (or per tab); empty for replay < 2.13. */
  recordingId: string;
  gen: number;
  seq: number;
  event: eventWithTime;
}

/**
 * Decode Loki lines of one session into rrweb events. Faro sends every rrweb
 * event as its own `faro.session_recording.event` with `recording_id`, `gen`
 * and `seq` attributes (logfmt keys `event_data_*`); the JSON payload is in
 * `event_data_event`. Lines of other sessions are ignored, broken ones counted.
 */
export function decodeReplayLines(
  lines: Iterable<{ line: string }>,
  sessionId: string
): { decoded: DecodedReplayEvent[]; skipped: number } {
  const decoded: DecodedReplayEvent[] = [];
  let skipped = 0;

  for (const { line } of lines) {
    const fields = parseLogfmt(line);
    if (fields.event_name !== REPLAY_EVENT_NAME || fields.session_id !== sessionId) {
      continue;
    }

    let event: eventWithTime | undefined;
    try {
      event = fields.event_data_event ? JSON.parse(fields.event_data_event) : undefined;
    } catch {
      event = undefined;
    }
    if (typeof event?.timestamp !== 'number' || typeof event?.type !== 'number') {
      skipped++;
      continue;
    }

    const recordingId = fields.event_data_recording_id ?? '';
    const gen = Number(fields.event_data_gen ?? 0) || 0;
    const seq = Number(fields.event_data_seq ?? 0) || 0;
    decoded.push({
      // Replay < 2.13 sends no recording id/gen/seq: only identical payloads are duplicates then.
      key: recordingId ? `${recordingId}:${gen}:${seq}` : fields.event_data_event,
      recordingId,
      gen,
      seq,
      event,
    });
  }

  return { decoded, skipped };
}

const inRecordingOrder = (a: DecodedReplayEvent, b: DecodedReplayEvent) =>
  a.event.timestamp - b.event.timestamp || a.gen - b.gen || a.seq - b.seq;

/** One chunk (a recording's gen) as the player sees it. Replaced, never changed, when it changes. */
export interface ReplayChunk {
  key: string;
  recordingId: string;
  gen: number;
  /** rrweb times: its Meta (or its first event / an estimate), and the next chunk's start or the recording's end. */
  startMs: number;
  endMs: number;
  /** Key of the chunk that must be loaded for this one to play (it has no Meta/snapshot of its own). */
  dependsOn?: string;
  loaded: boolean;
  /** Gave up loading it (after retries); asked for again on the next seek there. */
  failed: boolean;
  /** Sorted by time; empty until loaded. */
  events: readonly eventWithTime[];
}

export interface PageLoad {
  timestamp: number;
  href?: string;
}

/**
 * One tab's playback: recordings that follow each other (page reloads) back to
 * back. Times are rrweb times; offsets count from `startMs`, the first
 * recording's first Meta (`anchor`), whatever is loaded.
 */
export interface ReplayTrack {
  key: string;
  startMs: number;
  endMs: number;
  anchor: eventWithTime;
  chunks: readonly ReplayChunk[];
  /** Every Meta (page load or checkout) with its URL, sorted. */
  pages: readonly PageLoad[];
}

export const chunkKey = (recordingId: string, gen: number) => `${recordingId}:${gen}`;

interface ChunkState {
  info: GenIndex;
  loaded: boolean;
  failed: boolean;
  entries: DecodedReplayEvent[];
  keys: Set<string>;
  /** Live lines of a chunk not loaded yet: merged (and their stylesheets resolved) with it. */
  buffer: DecodedReplayEvent[];
  /** Kept while more lines may come (live); stylesheet references only resolve within a gen. */
  resolver?: StylesheetResolver;
  view?: ReplayChunk;
}

interface RecordingState {
  recordingId: string;
  firstGen: number;
  gens: ChunkState[];
  startMs: number;
  endMs: number;
}

/**
 * A session's replay as chunks: built from the index, filled chunk by chunk in
 * any order (and by live polling), split into tracks. Every change touches
 * only its chunk: events are never re-sorted or copied across chunks.
 *
 * Tracks: recordings that overlap in time (the session open in two tabs) get a
 * track each, because mixing their DOM changes would corrupt the playback;
 * recordings that follow each other share one. Decided from the index's start
 * and end of every recording, so tracks (and the `track` link parameter) are
 * known before anything is loaded.
 */
export class ReplayTimeline {
  skipped = 0;
  unresolvedStylesheets = 0;
  droppedStylesheets = 0;

  private readonly recordings = new Map<string, RecordingState>();
  private readonly chunks = new Map<string, ChunkState>();
  /** Live events of recordings not seen yet, until their first Meta arrives. */
  private readonly orphans = new Map<string, DecodedReplayEvent[]>();
  private retiredUnresolved = 0;
  private retiredDropped = 0;
  private cachedTracks?: ReplayTrack[];

  constructor(index?: ReplayIndex) {
    for (const recording of index?.recordings ?? []) {
      const state: RecordingState = {
        recordingId: recording.recordingId,
        firstGen: recording.gens[0].gen,
        gens: [],
        startMs: recording.startMs,
        endMs: recording.endMs,
      };
      this.recordings.set(recording.recordingId, state);
      for (const gen of recording.gens) {
        this.addGen(state, { ...gen }, false);
      }
    }
  }

  get tracks(): ReplayTrack[] {
    this.cachedTracks ??= this.buildTracks();
    return this.cachedTracks;
  }

  /** Where to fetch a chunk (undefined for an unknown key). */
  chunkInfo(key: string): GenIndex | undefined {
    return this.chunks.get(key)?.info;
  }

  isLoaded(key: string): boolean {
    return this.chunks.get(key)?.loaded ?? false;
  }

  /** A chunk's events arrived (all of them: its whole window). */
  addChunk(key: string, decoded: DecodedReplayEvent[], skipped = 0): void {
    const chunk = this.chunks.get(key);
    if (!chunk || chunk.loaded) {
      return;
    }
    this.skipped += skipped;
    chunk.loaded = true;
    chunk.failed = false;
    const buffered = chunk.buffer;
    chunk.buffer = [];
    this.merge(chunk, [...buffered, ...decoded]);
    if (!this.mayGrow(chunk)) {
      this.retireResolver(chunk);
    }
    this.countStylesheets();
  }

  /** A given-up chunk is being tried again. */
  retryChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (chunk?.failed) {
      chunk.failed = false;
      this.changed(chunk);
    }
  }

  failChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (chunk && !chunk.loaded) {
      chunk.failed = true;
      this.changed(chunk);
    }
  }

  /**
   * Lines polled live (from the index's end on): appended to their chunk, or to
   * a chunk not loaded yet (merged when it is); new gens and new recordings
   * (a reload, another tab) start chunks that live polling sees whole.
   */
  addLive(decoded: DecodedReplayEvent[], skipped = 0): void {
    this.skipped += skipped;
    const byChunk = new Map<string, DecodedReplayEvent[]>();
    for (const entry of decoded) {
      if (!entry.recordingId) {
        continue;
      }
      const recording = this.recordings.get(entry.recordingId) ?? this.startRecording(entry);
      if (!recording) {
        continue;
      }
      if (entry.gen < recording.firstGen) {
        continue;
      }
      const key = chunkKey(entry.recordingId, entry.gen);
      const list = byChunk.get(key) ?? [];
      list.push(entry);
      byChunk.set(key, list);
    }
    for (const [key, entries] of byChunk) {
      const recording = this.recordings.get(entries[0].recordingId)!;
      this.extendTo(recording, entries[0].gen, entries);
      const chunk = this.chunks.get(key)!;
      this.attachLateMeta(recording, chunk, entries);
      if (chunk.loaded) {
        this.merge(chunk, entries);
      } else {
        chunk.buffer.push(...entries.filter((entry) => !chunk.keys.has(entry.key)));
      }
      for (const entry of entries) {
        recording.endMs = Math.max(recording.endMs, entry.event.timestamp);
      }
      this.cachedTracks = undefined;
    }
    this.countStylesheets();
  }

  /** Live events of an unknown recording: kept until its first Meta starts it. */
  private startRecording(entry: DecodedReplayEvent): RecordingState | undefined {
    const pending = this.orphans.get(entry.recordingId) ?? [];
    pending.push(entry);
    const meta = pending.filter((candidate) => candidate.event.type === RRWEB_META).sort(inRecordingOrder)[0];
    if (!meta) {
      this.orphans.set(entry.recordingId, pending);
      return undefined;
    }
    this.orphans.delete(entry.recordingId);
    const recording: RecordingState = {
      recordingId: entry.recordingId,
      firstGen: meta.gen,
      gens: [],
      startMs: meta.event.timestamp,
      endMs: meta.event.timestamp,
    };
    this.recordings.set(entry.recordingId, recording);
    const info: GenIndex = {
      recordingId: entry.recordingId,
      gen: meta.gen,
      meta: meta.event,
      startMs: meta.event.timestamp,
      window: { fromMs: 0, toMs: 0 },
    };
    this.addGen(recording, info, true);
    const earlier = pending.filter((candidate) => candidate !== entry && candidate.gen >= meta.gen);
    if (earlier.length > 0) {
      this.addLive(earlier);
    }
    return recording;
  }

  /**
   * A gen's first mutations can arrive a few seconds before its Meta line, so
   * live polling may have started the gen without it: the Meta, once it
   * arrives, starts the gen (its page URL, and no dependency on the gen before).
   */
  private attachLateMeta(recording: RecordingState, chunk: ChunkState, entries: DecodedReplayEvent[]): void {
    if (chunk.info.meta) {
      return;
    }
    const meta = entries.find((entry) => entry.event.type === RRWEB_META);
    if (!meta) {
      return;
    }
    chunk.info.meta = meta.event;
    chunk.info.startMs = meta.event.timestamp;
    chunk.info.dependsOn = undefined;
    const index = recording.gens.indexOf(chunk);
    if (index > 0) {
      recording.gens[index - 1].view = undefined;
    }
    this.changed(chunk);
  }

  /** New gens up to `gen`, seen whole by live polling (they started after it began). */
  private extendTo(recording: RecordingState, gen: number, entries: DecodedReplayEvent[]): void {
    const last = recording.firstGen + recording.gens.length - 1;
    if (gen <= last) {
      return;
    }
    for (let next = last + 1; next <= gen; next++) {
      const meta = next === gen ? entries.find((entry) => entry.event.type === RRWEB_META) : undefined;
      const startMs = meta?.event.timestamp ?? Math.min(...entries.map((entry) => entry.event.timestamp));
      const info: GenIndex = {
        recordingId: recording.recordingId,
        gen: next,
        meta: meta?.event,
        startMs: next === recording.firstGen ? recording.startMs : startMs,
        window: { fromMs: 0, toMs: 0 },
        dependsOn: meta || next === recording.firstGen ? undefined : next - 1,
      };
      this.addGen(recording, info, true);
    }
    // Earlier gens get no more lines worth their stylesheet texts.
    for (const older of recording.gens.slice(0, -2)) {
      this.retireResolver(older);
    }
  }

  private addGen(recording: RecordingState, info: GenIndex, loaded: boolean): void {
    const chunk: ChunkState = { info, loaded, failed: false, entries: [], keys: new Set(), buffer: [] };
    if (recording.gens.length > 0) {
      // The chunk before ends where this one starts.
      recording.gens[recording.gens.length - 1].view = undefined;
    }
    recording.gens.push(chunk);
    this.chunks.set(chunkKey(info.recordingId, info.gen), chunk);
    this.cachedTracks = undefined;
  }

  /** Adds new entries to a chunk: deduplicated, stylesheets resolved, merged in order. */
  private merge(chunk: ChunkState, incoming: DecodedReplayEvent[]): void {
    const recording = this.recordings.get(chunk.info.recordingId)!;
    const firstOfRecording = chunk.info.gen === recording.firstGen;
    const fresh: DecodedReplayEvent[] = [];
    for (const entry of incoming) {
      if (chunk.keys.has(entry.key)) {
        continue;
      }
      chunk.keys.add(entry.key);
      const meta = chunk.info.meta;
      if (meta && entry.event !== meta && entry.event.type === RRWEB_META && entry.event.timestamp === meta.timestamp) {
        // The index's Meta object stands for its line: one object per event for the player.
        fresh.push({ ...entry, event: meta });
        continue;
      }
      // Nothing plays before a recording's first Meta: it would shift the track's start.
      if (firstOfRecording && entry.event.timestamp < recording.startMs) {
        continue;
      }
      fresh.push(entry);
    }
    if (fresh.length === 0) {
      this.changed(chunk);
      return;
    }
    chunk.resolver ??= new StylesheetResolver();
    chunk.resolver.addEvents(fresh.filter((entry) => entry.event !== chunk.info.meta).map((entry) => entry.event));
    fresh.sort(inRecordingOrder);
    chunk.entries = mergeSorted(chunk.entries, fresh, inRecordingOrder);
    if (!chunk.info.meta && chunk.entries.length > 0) {
      // A gen without Meta starts with its first event, not the estimate.
      chunk.info.startMs = chunk.entries[0].event.timestamp;
      const index = recording.gens.indexOf(chunk);
      if (index > 0) {
        recording.gens[index - 1].view = undefined;
      }
    }
    recording.endMs = Math.max(recording.endMs, chunk.entries[chunk.entries.length - 1].event.timestamp);
    this.changed(chunk);
  }

  /** Only a recording's newest gens can still grow (live). */
  private mayGrow(chunk: ChunkState): boolean {
    const recording = this.recordings.get(chunk.info.recordingId)!;
    return recording.gens[recording.gens.length - 1] === chunk;
  }

  private retireResolver(chunk: ChunkState): void {
    if (chunk.resolver) {
      this.retiredUnresolved += chunk.resolver.unresolved;
      this.retiredDropped += chunk.resolver.droppedTexts;
      chunk.resolver = undefined;
    }
  }

  private countStylesheets(): void {
    let unresolved = this.retiredUnresolved;
    let dropped = this.retiredDropped;
    for (const chunk of this.chunks.values()) {
      unresolved += chunk.resolver?.unresolved ?? 0;
      dropped += chunk.resolver?.droppedTexts ?? 0;
    }
    this.unresolvedStylesheets = unresolved;
    this.droppedStylesheets = dropped;
  }

  private changed(chunk: ChunkState): void {
    chunk.view = undefined;
    this.cachedTracks = undefined;
  }

  private viewOf(recording: RecordingState, index: number): ReplayChunk {
    const chunk = recording.gens[index];
    if (chunk.view) {
      return chunk.view;
    }
    const next = recording.gens[index + 1];
    const { info } = chunk;
    chunk.view = {
      key: chunkKey(info.recordingId, info.gen),
      recordingId: info.recordingId,
      gen: info.gen,
      startMs: info.startMs,
      endMs: Math.max(info.startMs, next ? next.info.startMs : recording.endMs),
      dependsOn: info.dependsOn === undefined ? undefined : chunkKey(info.recordingId, info.dependsOn),
      loaded: chunk.loaded,
      failed: chunk.failed,
      events: chunk.entries.map((entry) => entry.event),
    };
    return chunk.view;
  }

  private buildTracks(): ReplayTrack[] {
    const recordings = [...this.recordings.values()].sort((a, b) => a.startMs - b.startMs);
    const groups: RecordingState[][] = [];
    for (const recording of recordings) {
      const group = groups.find((candidate) => candidate[candidate.length - 1].endMs <= recording.startMs);
      if (group) {
        group.push(recording);
      } else {
        groups.push([recording]);
      }
    }
    return groups.map((group) => {
      const chunks: ReplayChunk[] = [];
      const pages: PageLoad[] = [];
      for (const recording of group) {
        recording.gens.forEach((chunk, index) => {
          chunks.push(this.viewOf(recording, index));
          if (chunk.info.meta) {
            pages.push({
              timestamp: chunk.info.meta.timestamp,
              href: (chunk.info.meta.data as { href?: string }).href,
            });
          }
        });
      }
      return {
        key: group[0].recordingId,
        startMs: group[0].startMs,
        endMs: Math.max(...group.map((recording) => recording.endMs)),
        anchor: group[0].gens[0].info.meta!,
        chunks,
        pages,
      };
    });
  }
}
