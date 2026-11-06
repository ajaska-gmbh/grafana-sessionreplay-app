import type { JourneyEvent } from './journey';
import {
  audioSourcesOf,
  clockOffsetsOf,
  coverage,
  listingRange,
  LIST_CLOCK_SLACK_MS,
  missing,
  segmentAt,
  subtract,
  trackOf,
  union,
  type AudioSegment,
  type CallAudioTrack,
} from './callAudio';

const event = (attributes: Record<string, string>): JourneyEvent => ({
  id: Math.random().toString(),
  timeMs: 0,
  category: 'custom',
  title: '',
  attributes,
});
const seg = (track: CallAudioTrack, startMs: number, durationMs: number): AudioSegment => ({
  key: `${track}-${startMs}`,
  track,
  startMs,
  durationMs,
});

describe('call audio', () => {
  it("reads the agent computer's measured clock offsets, in order", () => {
    const offsets = clockOffsetsOf([
      event({
        event_name: 'recording.started',
        event_data_recording_contract: 'v1',
        event_data_clock_offset_ms: '-7200000',
      }),
      event({
        event_name: 'recording.clock',
        event_data_recording_contract: 'v1',
        event_data_clock_offset_ms: '-7195000',
      }),
      event({ event_name: 'recording.clock', event_data_recording_contract: 'v1', event_data_clock_offset_ms: 'x' }),
      event({ event_name: 'recording.started', event_data_recording_contract: 'v9', event_data_clock_offset_ms: '5' }),
      event({ event_name: 'recording.started', event_data_recording_contract: 'v1' }),
    ]);

    expect(offsets).toEqual([-7_200_000, -7_195_000]);
  });

  it("lists over the server's clock: the session moved by each offset, and by none for older segments", () => {
    const range = { startMs: 1_000_000, endMs: 2_000_000 };

    expect(listingRange(range, [])).toEqual({
      startMs: 1_000_000 - LIST_CLOCK_SLACK_MS,
      endMs: 2_000_000 + LIST_CLOCK_SLACK_MS,
    });
    expect(listingRange(range, [-7_200_000, 3_000])).toEqual({
      startMs: 1_000_000 - 7_200_000 - LIST_CLOCK_SLACK_MS,
      endMs: 2_000_000 + 3_000 + LIST_CLOCK_SLACK_MS,
    });
  });

  it('reads where the audio is from the recording events (contract v1)', () => {
    const sources = audioSourcesOf([
      event({
        event_name: 'recording.started',
        event_data_recording_contract: 'v1',
        event_data_source: 'browser',
        event_data_env: 'ppdtesting-',
        event_data_agent_id: '7',
      }),
      event({ event_name: 'recording.source-changed', event_data_origin: 'idle' }),
      event({ event_name: 'recording.source-changed', event_data_origin: 'leg', event_data_leg_sid: 'CA1' }),
    ]);

    expect(sources).toEqual({ browser: { env: 'ppdtesting-', agentId: 7 } });
  });

  it('finds nothing in a session of another app, or of another contract version', () => {
    expect(audioSourcesOf([event({ event_name: 'click' })])).toEqual({ browser: undefined });
    expect(
      audioSourcesOf([
        event({
          event_name: 'recording.started',
          event_data_recording_contract: 'v2',
          event_data_source: 'browser',
          event_data_env: 'e',
          event_data_agent_id: '7',
        }),
      ]).browser
    ).toBeUndefined();
  });

  it('names the recorder tracks', () => {
    expect([
      trackOf('browser', 'mic'),
      trackOf('browser', 'heard'),
      trackOf('browser', 'x'),
      trackOf('carrier', 'outbound'),
    ]).toEqual(['mic', 'heard', undefined, undefined]);
  });

  it('finds the segment at a moment, and none in a hole between segments', () => {
    const segments = [seg('mic', 0, 10_000), seg('mic', 10_000, 10_000), seg('mic', 30_000, 10_000)];
    expect(segmentAt(segments, 0)?.startMs).toBe(0);
    expect(segmentAt(segments, 19_999)?.startMs).toBe(10_000);
    expect(segmentAt(segments, 25_000)).toBeUndefined();
    expect(segmentAt(segments, 40_000)).toBeUndefined();
    expect(segmentAt([], 1)).toBeUndefined();
  });

  it('does interval arithmetic', () => {
    const i = (a: number, b: number) => ({ startMs: a, endMs: b });
    expect(union([i(5, 7), i(0, 2), i(1, 3)])).toEqual([i(0, 3), i(5, 7)]);
    expect(subtract([i(0, 10)], [i(2, 3), i(5, 12)])).toEqual([i(0, 2), i(3, 5)]);
    expect(coverage([seg('mic', 0, 10_000), seg('mic', 10_000, 10_000), seg('mic', 30_000, 10_000)])).toEqual([
      i(0, 20_000),
      i(30_000, 40_000),
    ]);
  });

  it("shows where the agent's microphone was not recorded within the session, ignoring seams", () => {
    const i = (a: number, b: number) => ({ startMs: a, endMs: b });
    const mic = [seg('mic', 5_000, 10_000), seg('mic', 15_200, 10_000), seg('mic', 40_000, 10_000)];

    expect(missing(mic, i(0, 60_000))).toEqual([i(0, 5_000), i(25_200, 40_000), i(50_000, 60_000)]);
    expect(missing([], i(0, 1_000))).toEqual([i(0, 1_000)]);
  });
});
