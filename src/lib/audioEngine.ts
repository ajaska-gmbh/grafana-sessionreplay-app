import { CALL_AUDIO_TRACKS, segmentAt, segmentStartingFrom, type AudioSegment, type CallAudioTrack } from './callAudio';
import type { ClockState } from './playerClock';

/** Faster than this the audio would be noise: it is muted, the replay plays on. */
export const MAX_AUDIBLE_SPEED = 2;
/** Audio further off the replay's clock than this is moved back onto it. */
export const MAX_DRIFT_S = 0.08;
/** Decoded segments kept: around the playhead for every track, not the whole session. */
export const DECODED_CACHE_SIZE = 10;
/** The next segment is fetched and decoded this long before the current one ends. */
export const PREFETCH_S = 4;
/** Touching segments (end of one within this of the next's start) play back to back. */
const CONTIGUOUS_MS = 60;
/** Decoding rate: the recordings are speech at 8–16 kHz. */
export const CONTEXT_SAMPLE_RATE = 16_000;

const STEREO_PAN: Record<CallAudioTrack, number> = { mic: -0.7, heard: 0.7 };

/** The slice of Web Audio the engine uses, so tests can stand in for it. */
export interface EngineContext {
  readonly currentTime: number;
  readonly state: AudioContextState;
  readonly destination: AudioNode;
  resume: () => Promise<void>;
  close: () => Promise<void>;
  createGain: () => GainNode;
  createStereoPanner: () => StereoPannerNode;
  createBufferSource: () => AudioBufferSourceNode;
  decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer>;
}

export interface CallAudioEngineOptions {
  fetchAudio: (key: string) => Promise<ArrayBuffer>;
  createContext?: () => EngineContext;
  onError?: (message: string) => void;
}

interface Playing {
  segment: AudioSegment;
  source: AudioBufferSourceNode;
  /** Context time the source starts (or started) at. */
  contextStart: number;
  /** Seconds into the segment at contextStart. */
  offsetS: number;
  rate: number;
}

interface Track {
  gain: GainNode;
  panner: StereoPannerNode;
  current?: Playing;
  /** The next segment, scheduled to start the moment the current one ends. */
  next?: Playing;
}

function browserContext(): EngineContext {
  return new AudioContext({ sampleRate: CONTEXT_SAMPLE_RATE, latencyHint: 'playback' });
}

/**
 * Plays the call audio in step with the replay. sync() is called with the
 * replay's clock on every change; each audible track plays the segment at the
 * playhead from the right offset, at the replay's speed, and is moved back
 * onto the clock when it drifts (a seek, skipped inactivity, a slow frame).
 */
export class CallAudioEngine {
  private context: EngineContext | null = null;
  private readonly tracks = new Map<CallAudioTrack, Track>();
  /** Fetch-and-decode in progress or done, by segment key; `ready` holds the finished ones. */
  private readonly decoded = new Map<string, Promise<AudioBuffer | null>>();
  private readonly ready = new Map<string, AudioBuffer>();
  private segments: Record<CallAudioTrack, AudioSegment[]> = { mic: [], heard: [] };
  private audible: ReadonlySet<CallAudioTrack> = new Set();
  private volume = 1;
  private stereo = false;
  private last?: ClockState;
  private disposed = false;

  constructor(private readonly options: CallAudioEngineOptions) {}

  setSegments(segments: Record<CallAudioTrack, AudioSegment[]>): void {
    this.segments = segments;
    this.resync();
  }

  setAudible(audible: ReadonlySet<CallAudioTrack>): void {
    this.audible = audible;
    this.resync();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    for (const track of this.tracks.values()) {
      track.gain.gain.value = this.volume;
    }
  }

  setStereo(stereo: boolean): void {
    this.stereo = stereo;
    for (const [name, track] of this.tracks) {
      track.panner.pan.value = stereo ? STEREO_PAN[name] : 0;
    }
  }

  /** The replay's clock changed: follow it. */
  sync(state: ClockState): void {
    this.last = state;
    if (this.disposed) {
      return;
    }
    const wallMs = state.startTimeMs === undefined ? undefined : state.startTimeMs + state.offsetMs;
    // Silent while rrweb skips inactivity too: the playhead jumps further every frame than audio can follow.
    const silent = !state.playing || state.skipping || state.speed > MAX_AUDIBLE_SPEED || wallMs === undefined;

    for (const name of CALL_AUDIO_TRACKS) {
      if (silent || !this.audible.has(name)) {
        this.stopTrack(name);
        continue;
      }
      this.follow(name, wallMs, state.speed);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const name of CALL_AUDIO_TRACKS) {
      this.stopTrack(name);
    }
    void this.context?.close();
    this.context = null;
    this.decoded.clear();
    this.ready.clear();
  }

  private resync(): void {
    if (this.last) {
      this.sync(this.last);
    }
  }

  private ensureContext(): EngineContext {
    if (!this.context) {
      this.context = (this.options.createContext ?? browserContext)();
    }
    if (this.context.state === 'suspended') {
      // Browsers start audio only after a user gesture; pressing play is one.
      void this.context.resume();
    }
    return this.context;
  }

  private trackFor(name: CallAudioTrack, context: EngineContext): Track {
    let track = this.tracks.get(name);
    if (!track) {
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      gain.gain.value = this.volume;
      panner.pan.value = this.stereo ? STEREO_PAN[name] : 0;
      gain.connect(panner);
      panner.connect(context.destination);
      track = { gain, panner };
      this.tracks.set(name, track);
    }
    return track;
  }

  private follow(name: CallAudioTrack, wallMs: number, speed: number): void {
    const segment = segmentAt(this.segments[name], wallMs);
    if (!segment && !this.tracks.get(name)?.current) {
      return;
    }
    const context = this.ensureContext();
    const track = this.trackFor(name, context);

    // The scheduled next segment has begun.
    if (segment && track.next?.segment.key === segment.key && track.current?.segment.key !== segment.key) {
      if (track.current) {
        release(track.current);
      }
      track.current = track.next;
      track.next = undefined;
    }

    if (!segment) {
      this.stopTrack(name);
      return;
    }

    const expectedS = (wallMs - segment.startMs) / 1000;
    const current = track.current;
    if (current?.segment.key === segment.key && current.rate === speed) {
      const playedS = current.offsetS + Math.max(0, context.currentTime - current.contextStart) * current.rate;
      if (Math.abs(playedS - expectedS) <= MAX_DRIFT_S) {
        this.prepareNext(name, track, segment, wallMs, speed, context);
        return;
      }
    }

    this.stopTrack(name);
    this.startAt(name, segment, expectedS, speed, context.currentTime);
  }

  /** Starts `segment` `offsetS` in at context time `when`, once it is decoded (silence until then). */
  private startAt(name: CallAudioTrack, segment: AudioSegment, offsetS: number, speed: number, when: number): void {
    const buffer = this.decodedNow(segment.key);
    if (!buffer) {
      return;
    }
    const context = this.ensureContext();
    const track = this.trackFor(name, context);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    source.connect(track.gain);
    source.start(when, Math.max(0, Math.min(offsetS, buffer.duration)));
    track.current = { segment, source, contextStart: when, offsetS, rate: speed };
  }

  /** Near a segment's end: decode the next one and, when it follows right on, schedule it to start on the exact sample. */
  private prepareNext(
    name: CallAudioTrack,
    track: Track,
    segment: AudioSegment,
    wallMs: number,
    speed: number,
    context: EngineContext
  ): void {
    const endMs = segment.startMs + segment.durationMs;
    const leftS = (endMs - wallMs) / 1000;
    if (leftS > PREFETCH_S) {
      return;
    }
    const following = segmentStartingFrom(this.segments[name], endMs - CONTIGUOUS_MS);
    if (!following || track.next?.segment.key === following.key) {
      return;
    }
    const buffer = this.decodedNow(following.key);
    if (!buffer || following.startMs - endMs > CONTIGUOUS_MS) {
      return;
    }
    const current = track.current!;
    const when = current.contextStart + (segment.durationMs / 1000 - current.offsetS) / current.rate;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    source.connect(track.gain);
    source.start(when, 0);
    track.next = { segment: following, source, contextStart: when, offsetS: 0, rate: speed };
  }

  /** The decoded audio if it is ready; otherwise starts fetching it and returns null. */
  private decodedNow(key: string): AudioBuffer | null {
    let pending = this.decoded.get(key);
    if (!pending) {
      pending = this.options
        .fetchAudio(key)
        .then((data) => this.ensureContext().decodeAudioData(data))
        .catch((error: unknown) => {
          this.options.onError?.(`could not play ${key}: ${String(error)}`);
          return null;
        });
      this.decoded.set(key, pending);
      void pending.then((buffer) => {
        if (buffer && !this.disposed) {
          this.ready.set(key, buffer);
          this.evict();
          this.resync();
        }
      });
      return null;
    }
    return this.ready.get(key) ?? null;
  }

  /** Keeps the cache bounded: drops the oldest decoded segments that are not playing. */
  private evict(): void {
    const inUse = new Set<string>();
    for (const track of this.tracks.values()) {
      if (track.current) {
        inUse.add(track.current.segment.key);
      }
      if (track.next) {
        inUse.add(track.next.segment.key);
      }
    }
    for (const key of this.ready.keys()) {
      if (this.ready.size <= DECODED_CACHE_SIZE) {
        break;
      }
      if (!inUse.has(key)) {
        this.ready.delete(key);
        this.decoded.delete(key);
      }
    }
  }

  private stopTrack(name: CallAudioTrack): void {
    const track = this.tracks.get(name);
    if (!track) {
      return;
    }
    for (const playing of [track.current, track.next]) {
      if (playing) {
        release(playing);
      }
    }
    track.current = undefined;
    track.next = undefined;
  }
}

function release(playing: Playing): void {
  try {
    playing.source.stop();
  } catch {
    // Already stopped, or never started.
  }
  playing.source.disconnect();
}
