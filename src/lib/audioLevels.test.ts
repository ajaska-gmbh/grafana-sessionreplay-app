jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import {
  audioLevelsQuery,
  buildAudioLevels,
  byStart,
  decodeLevelSeries,
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

  it("reads the window's 50 ms readings when the dialer sent them", () => {
    const line = `${IN_CALL} context_levels_format=pct2 context_agent_mic_levels=12000599 context_customer_audio_levels=00010203`;

    expect(parseAudioLevelLine('1', line, SESSION)).toMatchObject({
      agentLevels: [0.12, 0, 0.05, 0.99],
      customerLevels: [0, 0.01, 0.02, 0.03],
    });
    expect(parseAudioLevelLine('1', IN_CALL, SESSION)?.agentLevels).toBeUndefined();
  });

  it('decodes only the pct2 format, and nothing malformed', () => {
    expect(decodeLevelSeries('pct2', '0099')).toEqual([0, 0.99]);
    expect(decodeLevelSeries('pct3', '0099')).toBeUndefined();
    expect(decodeLevelSeries(undefined, '0099')).toBeUndefined();
    expect(decodeLevelSeries('pct2', '009')).toBeUndefined();
    expect(decodeLevelSeries('pct2', '00x9')).toBeUndefined();
    expect(decodeLevelSeries('pct2', '')).toBeUndefined();
  });

  it("tells a customer on the line from waiting with the line open, by the agent's state", () => {
    const withState = (state: string) => `${IN_CALL} user_attr_state=${state}`;

    expect(parseAudioLevelLine('1', withState('ON_CALL'), SESSION)).toMatchObject({
      phase: 'call',
      agentState: 'ON_CALL',
    });
    expect(parseAudioLevelLine('1', withState('AVAILABLE'), SESSION)?.phase).toBe('waiting');
    expect(parseAudioLevelLine('1', withState('CONNECTING_AVAILABLE_SECONDARY'), SESSION)?.phase).toBe('waiting');
    // Lines without a state are assumed to have a customer, as before.
    expect(parseAudioLevelLine('1', IN_CALL, SESSION)?.phase).toBe('call');
    expect(parseAudioLevelLine('1', `${IDLE} user_attr_state=AVAILABLE`, SESSION)?.phase).toBe('idle');
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
  const buildSorted = (windows: AudioLevelWindow[]) => [...windows].sort(byStart);
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

  it('finds the window under an offset when two legs overlap: the one that started last', () => {
    // Leg A's windows run on while leg B starts half-way through one of them.
    const legA = [window(0, 1000), window(1000, 2000), window(2000, 3000)];
    const legB = [window(1500, 2500), window(2500, 3500)];
    const segments = toTimelineSegments(buildSorted([...legA, ...legB]), 0, 10_000);

    expect(segmentAt(segments, 1200)?.startOffsetMs).toBe(1000);
    expect(segmentAt(segments, 1600)?.startOffsetMs).toBe(1500);
    expect(segmentAt(segments, 2100)?.startOffsetMs).toBe(2000);
    expect(segmentAt(segments, 3200)?.startOffsetMs).toBe(2500);
    expect(segmentAt(segments, 3600)).toBeUndefined();
  });

  it('looks back past a short window of the other leg to the one that still covers the offset', () => {
    const segments = toTimelineSegments(buildSorted([window(1000, 2000), window(1100, 1200)]), 0, 10_000);

    expect(segmentAt(segments, 1500)?.startOffsetMs).toBe(1000);
  });

  it('sorts windows by start, which differs from end order when legs overlap', () => {
    const level = (start: string, windowMs: number) =>
      `timestamp="2026-11-04 12:33:${start} +0000 UTC" kind=measurement type=twilio_audio_level value_samples=20 value_window_ms=${windowMs} session_id=${SESSION}`;
    // Ends at :03 after starting at :01; the other ends at :02.500 after starting at :01.500.
    const windows = buildAudioLevels(
      [
        { tsNs: '1', line: level('03.000', 2000) },
        { tsNs: '2', line: level('02.500', 1000) },
      ],
      SESSION
    );

    expect(windows.map((entry) => entry.endMs - entry.startMs)).toEqual([2000, 1000]);
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
