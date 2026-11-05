import type { JourneyEvent } from './journey';
import {
  audioSourcesOf,
  coverage,
  intersect,
  losses,
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
const seg = (
  track: CallAudioTrack,
  startMs: number,
  durationMs: number,
  gaps: Array<[number, number]> = []
): AudioSegment => ({
  key: `${track}-${startMs}`,
  track,
  startMs,
  durationMs,
  gaps: gaps.map(([startMs, endMs]) => ({ startMs, endMs })),
});

describe('call audio', () => {
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
      event({ event_name: 'recording.source-changed', event_data_origin: 'leg', event_data_leg_sid: 'CA1' }),
      event({ event_name: 'recording.source-changed', event_data_origin: 'leg', event_data_leg_sid: 'CA2' }),
    ]);

    expect(sources).toEqual({ browser: { env: 'ppdtesting-', agentId: 7 }, legSids: ['CA1', 'CA2'] });
  });

  it('finds nothing in a session of another app, or of another contract version', () => {
    expect(audioSourcesOf([event({ event_name: 'click' })])).toEqual({ browser: undefined, legSids: [] });
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
      trackOf('carrier', 'inbound'),
      trackOf('carrier', 'outbound'),
      trackOf('carrier', 'x'),
    ]).toEqual(['mic', 'heard', 'agent', 'customer', undefined]);
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
    expect(intersect([i(0, 4), i(6, 10)], [i(3, 7)])).toEqual([i(3, 4), i(6, 7)]);
    expect(coverage([seg('agent', 0, 60_000, [[10_000, 12_000]])])).toEqual([i(0, 10_000), i(12_000, 60_000)]);
  });

  it("shows where the agent's words did not reach the carrier, and where the customer did not reach the agent", () => {
    const tracks = {
      mic: [seg('mic', 0, 10_000), seg('mic', 10_000, 10_000)],
      // The carrier received nothing of the agent from 4 to 9 s: the agent's internet.
      agent: [seg('agent', 0, 20_000, [[4_000, 9_000]])],
      customer: [seg('customer', 0, 20_000)],
      // The agent's computer played nothing from 15 s: their downlink.
      heard: [seg('heard', 0, 15_000)],
    };

    expect(losses(tracks)).toEqual({
      uplink: [{ startMs: 4_000, endMs: 9_000 }],
      downlink: [{ startMs: 15_000, endMs: 20_000 }],
    });
  });

  it('reports nothing lost between legs, or shorter than half a second', () => {
    const tracks = {
      mic: [seg('mic', 0, 100_000)],
      agent: [seg('agent', 50_000, 10_000, [[55_000, 55_200]])],
      customer: [seg('customer', 50_000, 10_000)],
      heard: [seg('heard', 50_000, 10_000)],
    };

    expect(losses(tracks)).toEqual({ uplink: [], downlink: [] });
  });
});
