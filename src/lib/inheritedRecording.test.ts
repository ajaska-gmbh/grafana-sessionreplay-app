import { audioSourcesOf, clockOffsetsOf } from './callAudio';
import {
  inheritRecording,
  inheritedRecordingQuery,
  needsInheritance,
  sessionRecordingFacts,
} from './inheritedRecording';
import type { JourneyEvent } from './journey';
import type { LokiLine } from '../types';

const HOUR = 3600_000;
const T = Date.parse('2026-11-12T08:17:13Z');

/** A Faro event line of agent 118 (leads), at `ms` on the agent's computer. */
function line(sessionId: string, ms: number, name: string, data: Record<string, string>, extra = ''): LokiLine {
  const ts = new Date(ms).toISOString().replace('T', ' ').replace('Z', ' +0000 UTC');
  const fields = Object.entries(data)
    .map(([k, v]) => `event_data_${k}=${v}`)
    .join(' ');
  return {
    tsNs: `${ms}000000`,
    line:
      `timestamp="${ts}" kind=event event_name=${name} event_domain=ppd ${fields} ` +
      `app_name=ppd-leads-frontend user_id=118 session_id=${sessionId}${extra}`,
  };
}
const started = (sessionId: string, ms: number, recordingId: string, offset = '22') =>
  line(sessionId, ms, 'recording.started', {
    recording_contract: 'v1',
    source: 'browser',
    env: 'ppdleads-',
    agent_id: '118',
    recording_id: recordingId,
    clock_offset_ms: offset,
  });
const clock = (sessionId: string, ms: number, recordingId: string, offset: string) =>
  line(sessionId, ms, 'recording.clock', { recording_contract: 'v1', recording_id: recordingId, clock_offset_ms: offset });
const stopped = (sessionId: string, ms: number, recordingId: string) =>
  line(sessionId, ms, 'recording.stopped', { recording_id: recordingId });

/** The journey of the later session: Faro's session_extend, then (optionally) a source change naming the recording. */
function laterSession(startMs: number, recordingId?: string, previous = 'P02G0FFUv3'): JourneyEvent[] {
  const attributes = (name: string, extra: Record<string, string> = {}) => ({
    event_name: name,
    app_name: 'ppd-leads-frontend',
    user_id: '118',
    session_id: '5NS12Z7EBS',
    session_attr_previousSession: previous,
    ...extra,
  });
  const journey: JourneyEvent[] = [
    { id: 'a', timeMs: startMs, category: 'custom', title: 'session_extend', attributes: attributes('session_extend') },
  ];
  if (recordingId) {
    journey.push({
      id: 'b',
      timeMs: startMs + 30_000,
      category: 'custom',
      title: 'recording.source-changed',
      attributes: attributes('recording.source-changed', { event_data_recording_id: recordingId, event_data_origin: 'leg' }),
    });
  }
  return journey;
}

describe('the recording a later Faro session continues', () => {
  it('is found with one query over the agent\'s recording events', () => {
    expect(inheritedRecordingQuery('ppd-leads-frontend', '118')).toBe(
      '{source="faro"} |= " app_name=ppd-leads-frontend " |= " user_id=118 " |= "kind=event"' +
        ' |~ "event_name=(?:recording\\\\.started|recording\\\\.clock|recording\\\\.stopped) "'
    );
  });

  it('gives the session the env, agent and offsets of the recording started 4 h before (session_extend)', () => {
    const facts = sessionRecordingFacts('5NS12Z7EBS', laterSession(T + 4 * HOUR, 'rec-1'));
    expect(needsInheritance(facts)).toBe(true);

    const inherited = inheritRecording(
      [started('P02G0FFUv3', T, 'rec-1'), clock('P02G0FFUv3', T + HOUR, 'rec-1', '-1500')],
      facts
    );

    expect(audioSourcesOf(inherited)).toEqual({ browser: { env: 'ppdleads-', agentId: 118 } });
    expect(clockOffsetsOf(inherited)).toEqual([22, -1500]);
  });

  it('reaches a recording started more than 4 h before (a rotation after a quiet spell, or several sessions on)', () => {
    const facts = sessionRecordingFacts('5NS12Z7EBS', laterSession(T + 9 * HOUR, 'rec-1', 'middle'));

    const inherited = inheritRecording([started('P02G0FFUv3', T, 'rec-1')], facts);

    expect(audioSourcesOf(inherited).browser?.env).toBe('ppdleads-');
  });

  it('takes nothing from a recording that stopped before the session (a reload started another)', () => {
    const facts = sessionRecordingFacts('5NS12Z7EBS', laterSession(T + 4 * HOUR));

    const inherited = inheritRecording([started('P02G0FFUv3', T, 'rec-1'), stopped('P02G0FFUv3', T + HOUR, 'rec-1')], facts);

    expect(inherited).toEqual([]);
  });

  it('takes only the recording the session names (another computer of the same agent records under another id)', () => {
    const facts = sessionRecordingFacts('5NS12Z7EBS', laterSession(T + 4 * HOUR, 'rec-1'));

    const inherited = inheritRecording(
      [
        started('P02G0FFUv3', T, 'rec-1', '22'),
        started('otherComputer', T + 2 * HOUR, 'rec-2', '-9000000'),
        clock('otherComputer', T + 3 * HOUR, 'rec-2', '-9100000'),
      ],
      facts
    );

    expect(clockOffsetsOf(inherited)).toEqual([22]);
  });

  it('takes the latest recording started before it when the session names none', () => {
    const facts = sessionRecordingFacts('5NS12Z7EBS', laterSession(T + 4 * HOUR));

    const inherited = inheritRecording(
      [started('P02G0FFUv3', T, 'rec-1', '22'), started('later', T + 2 * HOUR, 'rec-2', '40')],
      facts
    );

    expect(clockOffsetsOf(inherited)).toEqual([40]);
  });

  it('takes nothing started after the session', () => {
    const facts = sessionRecordingFacts('5NS12Z7EBS', laterSession(T + 4 * HOUR));

    expect(inheritRecording([started('next', T + 5 * HOUR, 'rec-9')], facts)).toEqual([]);
  });

  it('is not needed by a session that announces its recording itself', () => {
    const journey = laterSession(T, 'rec-1');
    journey.push({
      id: 'c',
      timeMs: T + 1,
      category: 'custom',
      title: 'recording.started',
      attributes: { ...journey[0].attributes, event_name: 'recording.started' },
    });

    expect(needsInheritance(sessionRecordingFacts('5NS12Z7EBS', journey))).toBe(false);
  });

  it('ignores the session\'s own lines and other agents\' or apps\' lines', () => {
    const facts = sessionRecordingFacts('5NS12Z7EBS', laterSession(T + 4 * HOUR));
    const other = started('P02G0FFUv3', T, 'rec-1');

    expect(
      inheritRecording(
        [
          started('5NS12Z7EBS', T, 'rec-1'),
          { ...other, line: other.line.replace('user_id=118', 'user_id=1180') },
          { ...other, line: other.line.replace('app_name=ppd-leads-frontend', 'app_name=ppd-sales-frontend') },
        ],
        facts
      )
    ).toEqual([]);
  });
});
