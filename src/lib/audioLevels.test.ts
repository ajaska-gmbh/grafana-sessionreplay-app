jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import {
  audioLevelsQuery,
  buildAudioLevels,
  parseAudioLevelLine,
  segmentAt,
  toTimelineSegments,
  type AudioLevelWindow,
} from './audioLevels';

const SESSION = 'te5FpMxWAh';

/** As Loki stored it on testing-1 (2026-11-04), shortened to the fields that matter. */
const IN_CALL =
  'timestamp="2026-11-04 12:33:42.775 +0000 UTC" kind=measurement type=twilio_audio_level agent_mic_avg=0.113031 ' +
  'agent_mic_max=0.190931 agent_mic_silent_ratio=0.000000 customer_audio_avg=0.016558 customer_audio_max=0.041176 ' +
  'customer_audio_silent_ratio=0.333333 hidden_ratio=0.000000 samples=18.000000 window_ms=949.000000 ' +
  'value_agent_mic_avg=0.11303104575163399 value_agent_mic_max=0.1909313725490196 value_agent_mic_silent_ratio=0 ' +
  'value_customer_audio_avg=0.016557734204793024 value_customer_audio_max=0.041176470588235294 ' +
  'value_customer_audio_silent_ratio=0.3333333333333333 value_hidden_ratio=0 value_samples=18 value_window_ms=949 ' +
  'context_callSid=CA123 context_phase=call context_visibility=visible ' +
  `app_name=ppd-testing-1-frontend session_id=${SESSION} page_url=https://testing-1.ppd.ajaska.de/`;

const IDLE =
  'timestamp="2026-11-04 12:33:43.777 +0000 UTC" kind=measurement type=twilio_mic_level_idle agent_mic_avg=0.270571 ' +
  'agent_mic_max=0.386520 agent_mic_silent_ratio=0.000000 hidden_ratio=0.500000 samples=14.000000 window_ms=1001.000000 ' +
  'value_agent_mic_avg=0.2705707282913165 value_agent_mic_max=0.38651960784313727 value_agent_mic_silent_ratio=0 ' +
  `value_hidden_ratio=0.5 value_samples=14 value_window_ms=1001 session_id=${SESSION}`;

const EMPTY_WINDOW = `timestamp="2026-11-04 12:33:44.775 +0000 UTC" kind=measurement type=twilio_audio_level samples=0.000000 window_ms=1000.000000 value_samples=0 value_window_ms=1000 session_id=${SESSION}`;

describe('audio level lines', () => {
  it('reads an in-call window with both channels, exactly, ending at the measurement time', () => {
    const window = parseAudioLevelLine('1793795622847758518', IN_CALL, SESSION);

    const endMs = Date.parse('2026-11-04T12:33:42.775Z');
    expect(window).toEqual({
      startMs: endMs - 949,
      endMs,
      phase: 'call',
      samples: 18,
      agentAvg: 0.11303104575163399,
      agentMax: 0.1909313725490196,
      agentSilentRatio: 0,
      customerAvg: 0.016557734204793024,
      customerMax: 0.041176470588235294,
      customerSilentRatio: 0.3333333333333333,
      hiddenRatio: 0,
      callSid: 'CA123',
    });
  });

  it('reads an idle window: the microphone only', () => {
    const window = parseAudioLevelLine('1', IDLE, SESSION)!;

    expect(window).toMatchObject({ phase: 'idle', samples: 14, agentAvg: 0.2705707282913165, hiddenRatio: 0.5 });
    expect(window.customerAvg).toBeUndefined();
  });

  it('reads a window without level data as samples=0', () => {
    expect(parseAudioLevelLine('1', EMPTY_WINDOW, SESSION)).toMatchObject({ samples: 0, agentAvg: undefined });
  });

  it('ignores other sessions, other measurements and other kinds of line', () => {
    expect(parseAudioLevelLine('1', IN_CALL, 'te5FpMxWA')).toBeUndefined();
    expect(
      parseAudioLevelLine('1', IN_CALL.replace('type=twilio_audio_level', 'type=leads_iframe_load'), SESSION)
    ).toBeUndefined();
    expect(parseAudioLevelLine('1', IN_CALL.replace('kind=measurement', 'kind=log'), SESSION)).toBeUndefined();
  });

  it('builds sorted windows from lines in any order', () => {
    const windows = buildAudioLevels(
      [
        { tsNs: '2', line: IDLE },
        { tsNs: '1', line: IN_CALL },
        { tsNs: '3', line: 'kind=event event_name=click' },
      ],
      SESSION
    );

    expect(windows.map((window) => window.phase)).toEqual(['call', 'idle']);
  });

  it("asks Loki for this session's level measurements only", () => {
    expect(audioLevelsQuery(SESSION)).toBe(
      `{source="faro"} |= "session_id=${SESSION}" |~ "(^| )type=(twilio_audio_level|telnyx_audio_level|twilio_mic_level_idle)( |$)"`
    );
  });
});

describe('audio levels on the timeline', () => {
  const window = (startMs: number, endMs: number): AudioLevelWindow => ({ startMs, endMs, phase: 'call', samples: 20 });

  it('positions windows from the recording start and clips them to the recording', () => {
    const segments = toTimelineSegments(
      [window(500, 1500), window(1500, 2500), window(9000, 11000), window(12000, 13000)],
      1000,
      10_000
    );

    expect(segments.map((segment) => [segment.startOffsetMs, segment.endOffsetMs])).toEqual([
      [0, 500],
      [500, 1500],
      [8000, 10_000],
    ]);
  });

  it('finds the window under an offset, and nothing in a gap', () => {
    const segments = toTimelineSegments([window(1000, 2000), window(2000, 3000), window(5000, 6000)], 0, 10_000);

    expect(segmentAt(segments, 1500)?.startOffsetMs).toBe(1000);
    expect(segmentAt(segments, 2000)?.startOffsetMs).toBe(2000);
    expect(segmentAt(segments, 5999)?.startOffsetMs).toBe(5000);
    expect(segmentAt(segments, 4000)).toBeUndefined();
    expect(segmentAt([], 0)).toBeUndefined();
  });
});
