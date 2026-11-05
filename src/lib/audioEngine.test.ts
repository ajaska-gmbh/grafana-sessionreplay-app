import { CallAudioEngine, MAX_DRIFT_S, type EngineContext } from './audioEngine';
import type { AudioSegment, CallAudioTrack } from './callAudio';
import type { ClockState } from './playerClock';

interface FakeSource {
  buffer: { duration: number; key: string } | null;
  playbackRate: { value: number };
  started?: { when: number; offset: number };
  stopped: boolean;
  connect: jest.Mock;
  disconnect: jest.Mock;
  start: (when: number, offset: number) => void;
  stop: () => void;
}

function fakeContext() {
  const sources: FakeSource[] = [];
  const node = () => ({ connect: jest.fn(), disconnect: jest.fn(), gain: { value: 1 }, pan: { value: 0 } });
  const context = {
    currentTime: 0,
    state: 'running' as AudioContextState,
    destination: {} as AudioNode,
    resume: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    createGain: () => node() as unknown as GainNode,
    createStereoPanner: () => node() as unknown as StereoPannerNode,
    createBufferSource: () => {
      const source: FakeSource = {
        buffer: null,
        playbackRate: { value: 1 },
        stopped: false,
        connect: jest.fn(),
        disconnect: jest.fn(),
        start(when, offset) {
          source.started = { when, offset };
        },
        stop() {
          source.stopped = true;
        },
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    decodeAudioData: async (data: ArrayBuffer) =>
      ({ duration: 10, key: new TextDecoder().decode(data) }) as unknown as AudioBuffer,
  };
  return { context: context as EngineContext & { currentTime: number }, sources };
}

const seg = (track: CallAudioTrack, startMs: number, durationMs = 10_000): AudioSegment => ({
  key: `${track}@${startMs}`,
  track,
  startMs,
  durationMs,
  gaps: [],
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function engineWith(
  segments: Partial<Record<CallAudioTrack, AudioSegment[]>>,
  audible: CallAudioTrack[] = ['mic', 'customer']
) {
  const fake = fakeContext();
  const fetchAudio = jest.fn(async (key: string) => new TextEncoder().encode(key).buffer as ArrayBuffer);
  const engine = new CallAudioEngine({ fetchAudio, createContext: () => fake.context });
  engine.setSegments({ mic: [], heard: [], agent: [], customer: [], ...segments });
  engine.setAudible(new Set(audible));
  return { engine, fetchAudio, ...fake };
}

const clock = (patch: Partial<ClockState>): ClockState => ({
  offsetMs: 0,
  totalMs: 600_000,
  startTimeMs: 1_000_000,
  playing: true,
  speed: 1,
  skipping: false,
  ...patch,
});
const live = (sources: FakeSource[]) => sources.filter((s) => s.started && !s.stopped);

describe('call audio engine', () => {
  it("plays each audible track from the playhead's place in its segment", async () => {
    const { engine, sources } = engineWith({
      mic: [seg('mic', 1_000_000)],
      customer: [seg('customer', 1_000_000)],
      agent: [seg('agent', 1_000_000)],
    });

    engine.sync(clock({ offsetMs: 2500 }));
    await settle();

    expect(live(sources).map((s) => [s.buffer?.key, s.started?.offset])).toEqual([
      ['mic@1000000', 2.5],
      ['customer@1000000', 2.5],
    ]);
  });

  it('keeps playing while in step, and moves back onto the clock when it drifts', async () => {
    const { engine, sources, context } = engineWith({ mic: [seg('mic', 1_000_000)] }, ['mic']);
    engine.sync(clock({ offsetMs: 0 }));
    await settle();
    const first = live(sources)[0];

    context.currentTime = 1;
    engine.sync(clock({ offsetMs: 1000 + (MAX_DRIFT_S * 1000) / 2 }));
    expect(live(sources)).toEqual([first]);

    // A seek.
    engine.sync(clock({ offsetMs: 6000 }));
    expect(first.stopped).toBe(true);
    expect(live(sources)[0].started?.offset).toBe(6);
  });

  it('is silent while paused, too fast, or where a track has no audio', async () => {
    const { engine, sources } = engineWith({ mic: [seg('mic', 1_000_000)] }, ['mic']);
    engine.sync(clock({}));
    await settle();
    expect(live(sources)).toHaveLength(1);

    engine.sync(clock({ playing: false }));
    expect(live(sources)).toHaveLength(0);

    engine.sync(clock({ speed: 4 }));
    expect(live(sources)).toHaveLength(0);

    engine.sync(clock({ offsetMs: 20_000 }));
    expect(live(sources)).toHaveLength(0);
  });

  it('is silent, and fetches nothing, while the replay skips inactivity', async () => {
    const { engine, sources, fetchAudio } = engineWith(
      { mic: Array.from({ length: 100 }, (_, i) => seg('mic', 1_000_000 + i * 10_000)) },
      ['mic']
    );

    for (let ms = 0; ms < 900_000; ms += 9_000) {
      engine.sync(clock({ offsetMs: ms, skipping: true }));
    }
    await settle();

    expect(live(sources)).toHaveLength(0);
    expect(fetchAudio).not.toHaveBeenCalled();
  });

  it("plays at the replay's speed", async () => {
    const { engine, sources } = engineWith({ mic: [seg('mic', 1_000_000)] }, ['mic']);
    engine.sync(clock({ speed: 2 }));
    await settle();
    expect(live(sources)[0].playbackRate.value).toBe(2);
  });

  it('starts the next segment on the exact moment the current one ends', async () => {
    const { engine, sources, context } = engineWith({ mic: [seg('mic', 1_000_000), seg('mic', 1_010_000)] }, ['mic']);
    engine.sync(clock({ offsetMs: 7000 }));
    await settle();
    // Within the prefetch window: the next one is decoded and scheduled.
    context.currentTime = 0.5;
    engine.sync(clock({ offsetMs: 7500 }));
    await settle();
    context.currentTime = 0.6;
    engine.sync(clock({ offsetMs: 7600 }));

    const [current, next] = live(sources);
    expect(current.buffer?.key).toBe('mic@1000000');
    expect(next.buffer?.key).toBe('mic@1010000');
    // Started at 7 s at context time 0: ends 3 s later.
    expect(next.started).toEqual({ when: 3, offset: 0 });

    // And takes over without a restart.
    context.currentTime = 3.2;
    engine.sync(clock({ offsetMs: 10_200 }));
    expect(live(sources)).toEqual([next]);
  });

  it('plays only the tracks chosen to be heard', async () => {
    const { engine, sources } = engineWith({ mic: [seg('mic', 1_000_000)], heard: [seg('heard', 1_000_000)] }, ['mic']);
    engine.sync(clock({}));
    await settle();
    expect(live(sources).map((s) => s.buffer?.key)).toEqual(['mic@1000000']);

    engine.setAudible(new Set(['heard']));
    await settle();
    expect(live(sources).map((s) => s.buffer?.key)).toEqual(['heard@1000000']);
  });

  it('fetches a segment once, however many frames ask for it', async () => {
    const { engine, fetchAudio } = engineWith({ mic: [seg('mic', 1_000_000)] }, ['mic']);
    for (let ms = 0; ms < 500; ms += 16) {
      engine.sync(clock({ offsetMs: ms }));
    }
    await settle();
    expect(fetchAudio).toHaveBeenCalledTimes(1);
  });
});
