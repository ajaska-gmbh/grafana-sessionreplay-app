import {
  after,
  dayCalls,
  dayEventsOf,
  dayEventsQuery,
  dayExtent,
  dayGaps,
  daySpans,
  latestClockOffset,
  playAt,
  spanAt,
  spanOf,
} from './agentDay';
import { dayOf } from './agents';
import type { SessionSummary } from './sessions';

const MIN = 60_000;
const day = dayOf('2026-11-11');
const T = day.startMs + 8 * 60 * MIN;
const summary = (sessionId: string): SessionSummary => ({
  sessionId,
  appName: 'ppd-leads-frontend',
  environment: 'production',
  userId: '7',
  startedMs: 0,
  lastStartedMs: 0,
  recordings: 1,
});
const recording = (startMs: number, endMs: number) => ({
  recordingId: 'r',
  gens: [],
  startMs,
  endMs,
  lastLokiMs: endMs,
});
const span = (sessionId: string, from: number, to: number) =>
  spanOf(summary(sessionId), [recording(T + from * MIN, T + to * MIN)])!;

describe("an agent's day", () => {
  const morning = span('morning', 0, 60);
  const lunch = span('lunch', 90, 120);
  const second = span('second-browser', 100, 150);
  const spans = daySpans([lunch, undefined, second, morning, span('yesterday', -24 * 60, -23 * 60)], day);

  it('spans each session from its first recording to its newest event, in time order, within the day', () => {
    expect(spanOf(summary('x'), [recording(5, 9), recording(1, 4)])).toMatchObject({ startMs: 1, endMs: 9 });
    expect(spanOf(summary('x'), [])).toBeUndefined();
    expect(spans.map((s) => s.session.sessionId)).toEqual(['morning', 'lunch', 'second-browser']);
    expect(dayExtent(spans, day)).toEqual({ startMs: T, endMs: T + 150 * MIN });
  });

  it('plays the span at a time, or jumps a gap to the next', () => {
    expect(spanAt(spans, T + 30 * MIN)?.session.sessionId).toBe('morning');
    expect(playAt(spans, T + 70 * MIN)).toEqual({ span: lunch, atMs: T + 90 * MIN });
    expect(playAt(spans, T + 105 * MIN)).toEqual({ span: lunch, atMs: T + 105 * MIN });
    expect(playAt(spans, T + 200 * MIN)).toBeUndefined();
  });

  it('moves on at a span end: to a session still running then, else the next to start', () => {
    expect(after(spans, morning)).toEqual({ span: lunch, atMs: T + 90 * MIN });
    expect(after(spans, lunch)).toEqual({ span: second, atMs: T + 120 * MIN });
    expect(after(spans, second)).toBeUndefined();
  });

  it('marks where the agent was not in the app', () => {
    expect(dayGaps(spans, dayExtent(spans, day)!)).toEqual([{ fromMs: T + 60 * MIN, toMs: T + 90 * MIN }]);
  });

  it('reads calls and clock offsets of the day from one query, for this agent only', () => {
    expect(dayEventsQuery('ppd-leads-frontend', '7')).toBe(
      '{source="faro"} |= " app_name=ppd-leads-frontend " |= " user_id=7 " |= "kind=event" |~ "event_name=(?:call\\\\.bridged|call\\\\.ended|recording\\\\.started|recording\\\\.clock) "'
    );
    const line = (ts: string, name: string, extra: string, user = '7') => ({
      tsNs: '0',
      line: `timestamp="${ts}" kind=event event_name=${name} ${extra} app_name=ppd-leads-frontend user_id=${user} session_id=S1`,
    });
    const events = dayEventsOf(
      [
        line('2026-11-11 08:00:00 +0000 UTC', 'recording.started', 'event_data_clock_offset_ms=-500'),
        line(
          '2026-11-11 08:01:00 +0000 UTC',
          'call.bridged',
          'event_data_call_sid=CA1 event_data_lead_id=L1 event_data_crm_lead_id=42'
        ),
        line('2026-11-11 08:03:00 +0000 UTC', 'call.ended', 'event_data_call_sid=CA1'),
        line('2026-11-11 08:04:00 +0000 UTC', 'call.bridged', 'event_data_call_sid=CA2', '70'),
        line('2026-11-11 08:05:00 +0000 UTC', 'recording.clock', 'event_data_clock_offset_ms=1200'),
      ],
      'ppd-leads-frontend',
      '7'
    );
    expect(events.map((event) => event.name)).toEqual([
      'recording.started',
      'call.bridged',
      'call.ended',
      'recording.clock',
    ]);
    expect(latestClockOffset(events)).toBe(1200);
    const [call] = dayCalls(events);
    expect(call).toMatchObject({ leadId: 'L1', crmLeadId: '42', callSid: 'CA1', sessionId: 'S1' });
    expect((call.endMs ?? 0) - call.atMs).toBe(2 * MIN);
  });
});
