import type { Day } from './agents';
import { faroTimeMs } from './journey';
import { parseLogfmt } from './logfmt';
import type { LokiLine } from '../types';
import { logqlString } from './loki';
import { STREAMS, appLineFilter, regexEscape } from './logql';
import type { RecordingIndex } from './replaySource';
import type { SessionSummary } from './sessions';

/**
 * An agent's day as one timeline: the sessions' recorded spans one after the
 * other on the agent's computer's clock (rrweb time, which every session of
 * the day shares), with what lies between them (the agent was not in the app).
 * The day page plays one session at a time and moves on at a span's end.
 */

export interface DaySpan {
  session: SessionSummary;
  /** First recording start and newest event of the session (rrweb time). */
  startMs: number;
  endMs: number;
}

/** A session's span from its index; none when it recorded nothing. */
export function spanOf(session: SessionSummary, recordings: RecordingIndex[]): DaySpan | undefined {
  if (recordings.length === 0) {
    return undefined;
  }
  return {
    session,
    startMs: Math.min(...recordings.map((recording) => recording.startMs)),
    endMs: Math.max(...recordings.map((recording) => recording.endMs)),
  };
}

/**
 * The spans within the day, in time order. Spans that overlap (two sessions at
 * once, e.g. a second browser) are kept: playback follows the one started
 * first until it ends, then the next one that is still running.
 */
export function daySpans(spans: Array<DaySpan | undefined>, day: Day): DaySpan[] {
  return spans
    .filter((span): span is DaySpan => span !== undefined && span.endMs > day.startMs && span.startMs < day.endMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Where the day's recordings begin and end (clipped to the day). */
export function dayExtent(spans: DaySpan[], day: Day): { startMs: number; endMs: number } | undefined {
  if (spans.length === 0) {
    return undefined;
  }
  return {
    startMs: Math.max(day.startMs, spans[0].startMs),
    endMs: Math.min(day.endMs, Math.max(...spans.map((span) => span.endMs))),
  };
}

/** The span playing at `atMs`: the earliest-started one containing it. */
export function spanAt(spans: DaySpan[], atMs: number): DaySpan | undefined {
  return spans.find((span) => span.startMs <= atMs && atMs < span.endMs);
}

/** Where playback goes from `atMs`: the span there, else the next one to start (a gap is jumped). */
export function playAt(spans: DaySpan[], atMs: number): { span: DaySpan; atMs: number } | undefined {
  const here = spanAt(spans, atMs);
  if (here) {
    return { span: here, atMs };
  }
  const next = spans.find((span) => span.startMs > atMs);
  return next ? { span: next, atMs: next.startMs } : undefined;
}

/** What follows `span` once it ended: another span still running then, or the next to start. */
export function after(spans: DaySpan[], span: DaySpan): { span: DaySpan; atMs: number } | undefined {
  // By id: a refresh of the day builds new span objects for the same sessions.
  const others = spans.filter((candidate) => candidate.session.sessionId !== span.session.sessionId);
  const running = others.find((candidate) => candidate.startMs <= span.endMs && span.endMs < candidate.endMs);
  if (running) {
    return { span: running, atMs: span.endMs };
  }
  const next = others.find((candidate) => candidate.startMs >= span.endMs);
  return next ? { span: next, atMs: next.startMs } : undefined;
}

/** The stretches of the day between spans, where the agent was not in the app. */
export function dayGaps(
  spans: DaySpan[],
  extent: { startMs: number; endMs: number }
): Array<{ fromMs: number; toMs: number }> {
  const gaps: Array<{ fromMs: number; toMs: number }> = [];
  let reached = extent.startMs;
  for (const span of spans) {
    if (span.startMs > reached) {
      gaps.push({ fromMs: reached, toMs: Math.min(span.startMs, extent.endMs) });
    }
    reached = Math.max(reached, span.endMs);
  }
  return gaps.filter((gap) => gap.toMs > gap.fromMs);
}

/** The dialer's events that mark an agent's day: calls, and the clock offsets of its recordings. */
export const DAY_EVENTS = ['call.bridged', 'call.ended', 'recording.started', 'recording.clock'] as const;

/**
 * One query for the agent's day events (not one per session): the app and
 * user line filters keep Loki from parsing other agents' lines; user_id is
 * compared exactly once parsed (dayEventsOf).
 */
export function dayEventsQuery(appName: string, userId: string): string {
  return (
    STREAMS.faro +
    appLineFilter([appName]) +
    ` |= ${logqlString(` user_id=${userId} `)}` +
    ` |= "kind=event"` +
    ` |~ ${logqlString(`event_name=(?:${DAY_EVENTS.map(regexEscape).join('|')}) `)}`
  );
}

export interface DayEvent {
  name: string;
  /** Event time (epoch ms, the agent's computer's clock, as rrweb time). */
  timeMs: number;
  sessionId: string;
  attributes: Record<string, string>;
}

export function dayEventsOf(lines: LokiLine[], appName: string, userId: string): DayEvent[] {
  const events: DayEvent[] = [];
  for (const { tsNs, line } of lines) {
    const fields = parseLogfmt(line);
    if (fields.app_name !== appName || fields.user_id !== userId || !fields.event_name || !fields.session_id) {
      continue;
    }
    events.push({
      name: fields.event_name,
      timeMs: faroTimeMs(fields, tsNs),
      sessionId: fields.session_id,
      attributes: fields,
    });
  }
  return events.sort((a, b) => a.timeMs - b.timeMs);
}

/** The latest clock offset the agent's computer measured (server minus computer, ms), for times of day. */
export function latestClockOffset(events: DayEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const offset = Number(events[i].attributes.event_data_clock_offset_ms);
    if ((events[i].name === 'recording.started' || events[i].name === 'recording.clock') && Number.isFinite(offset)) {
      return offset;
    }
  }
  return 0;
}

/** Calls of the day: a bridged call, with its lead, and when it ended (if seen). */
export interface DayCall {
  atMs: number;
  endMs?: number;
  leadId?: string;
  crmLeadId?: string;
  callSid?: string;
  sessionId: string;
}

export function dayCalls(events: DayEvent[]): DayCall[] {
  const calls: DayCall[] = [];
  const open = new Map<string, DayCall>();
  for (const event of events) {
    const sid = event.attributes.event_data_call_sid;
    if (event.name === 'call.bridged') {
      const call: DayCall = {
        atMs: event.timeMs,
        leadId: event.attributes.event_data_lead_id || undefined,
        crmLeadId: event.attributes.event_data_crm_lead_id || undefined,
        callSid: sid || undefined,
        sessionId: event.sessionId,
      };
      calls.push(call);
      if (sid) {
        open.set(sid, call);
      }
    } else if (event.name === 'call.ended' && sid && open.has(sid)) {
      open.get(sid)!.endMs = event.timeMs;
      open.delete(sid);
    }
  }
  return calls;
}
