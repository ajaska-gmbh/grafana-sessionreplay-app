import { faroTimeMs, type JourneyEvent } from './journey';
import { parseLogfmt } from './logfmt';
import { logqlString } from './loki';
import { STREAMS, appLineFilter, regexEscape } from './logql';
import type { LokiLine } from '../types';

/**
 * The recording a session continues when it has no recording.started of its own.
 *
 * Faro starts a new session after 4 h, or after 15 min without signals, while
 * the dialer's recording of the agent goes on. Dialers before the fix announced
 * the recording (contract "recording" v1) only in the session it started in,
 * so later sessions name it only in recording.source-changed, if at all. The
 * audio is filed by environment and agent, not by session: the recording's
 * recording.started, in an earlier session of the same agent, says where.
 *
 * The recording continued is the latest one started before the session that
 * was not stopped before it. When the session names its recording (any
 * recording.* event with a recording_id), only that one: another computer of
 * the same agent records under another id. A tie goes to the session Faro
 * names as the previous one.
 */

export const RECORDING_EVENTS = ['recording.started', 'recording.clock', 'recording.stopped'] as const;

/** How far back the started recording is looked for: a recording lasts one page, at most a day of work. */
export const INHERIT_LOOKBACK_MS = 24 * 3600_000;
/** After the session's first event: its own first lines and those of the previous session can be a moment apart. */
export const INHERIT_SLACK_MS = 60_000;

/** The agent's recording events over all their sessions (one query, as the agent's day reads its events). */
export function inheritedRecordingQuery(appName: string, userId: string): string {
  return (
    STREAMS.faro +
    appLineFilter([appName]) +
    ` |= ${logqlString(` user_id=${userId} `)}` +
    ` |= "kind=event"` +
    ` |~ ${logqlString(`event_name=(?:${RECORDING_EVENTS.map(regexEscape).join('|')}) `)}`
  );
}

/** What the session tells about itself: who, when it began, which recording it names, its predecessor. */
export interface SessionRecordingFacts {
  sessionId: string;
  appName?: string;
  userId?: string;
  /** The session's first event (the agent's computer's clock). */
  startMs?: number;
  /** recording_ids named by the session's own recording.* events. */
  recordingIds: Set<string>;
  hasStarted: boolean;
  previousSession?: string;
}

export function sessionRecordingFacts(sessionId: string, journey: JourneyEvent[]): SessionRecordingFacts {
  const facts: SessionRecordingFacts = { sessionId, recordingIds: new Set(), hasStarted: false };
  for (const event of journey) {
    const a = event.attributes;
    facts.appName ??= a.app_name || undefined;
    facts.userId ??= a.user_id || undefined;
    facts.previousSession ??= a.session_attr_previousSession || undefined;
    if (facts.startMs === undefined || event.timeMs < facts.startMs) {
      facts.startMs = event.timeMs;
    }
    if (a.event_name?.startsWith('recording.') && a.event_data_recording_id) {
      facts.recordingIds.add(a.event_data_recording_id);
    }
    if (a.event_name === 'recording.started') {
      facts.hasStarted = true;
    }
  }
  return facts;
}

/** Whether the session needs another session's recording.started to find its audio. */
export function needsInheritance(facts: SessionRecordingFacts): boolean {
  return !facts.hasStarted && facts.appName !== undefined && facts.userId !== undefined && facts.startMs !== undefined;
}

interface Candidate {
  name: string;
  timeMs: number;
  sessionId: string;
  attributes: Record<string, string>;
}

/**
 * The recording.started and recording.clock events (from before the session)
 * of the recording it continues, as journey events for the call audio to read;
 * none when there is none.
 */
export function inheritRecording(lines: LokiLine[], facts: SessionRecordingFacts): JourneyEvent[] {
  if (facts.startMs === undefined) {
    return [];
  }
  const before = facts.startMs + INHERIT_SLACK_MS;
  const candidates: Candidate[] = [];
  for (const { tsNs, line } of lines) {
    const a = parseLogfmt(line);
    if (
      a.app_name !== facts.appName ||
      a.user_id !== facts.userId ||
      !a.session_id ||
      a.session_id === facts.sessionId ||
      !a.event_data_recording_id ||
      !(RECORDING_EVENTS as readonly string[]).includes(a.event_name ?? '')
    ) {
      continue;
    }
    const timeMs = faroTimeMs(a, tsNs);
    if (timeMs <= before) {
      candidates.push({ name: a.event_name, timeMs, sessionId: a.session_id, attributes: a });
    }
  }
  const stopped = new Set(candidates.filter((c) => c.name === 'recording.stopped').map((c) => c.attributes.event_data_recording_id));
  const started = candidates
    .filter(
      (c) =>
        c.name === 'recording.started' &&
        !stopped.has(c.attributes.event_data_recording_id) &&
        (facts.recordingIds.size === 0 || facts.recordingIds.has(c.attributes.event_data_recording_id))
    )
    .sort(
      (a, b) =>
        a.timeMs - b.timeMs ||
        Number(a.sessionId === facts.previousSession) - Number(b.sessionId === facts.previousSession)
    );
  const chosen = started.at(-1);
  if (!chosen) {
    return [];
  }
  const recordingId = chosen.attributes.event_data_recording_id;
  return candidates
    .filter(
      (c) =>
        c.attributes.event_data_recording_id === recordingId &&
        (c === chosen || (c.name === 'recording.clock' && c.timeMs >= chosen.timeMs))
    )
    .sort((a, b) => a.timeMs - b.timeMs)
    .map((c, i) => ({
      id: `inherited-${c.sessionId}-${i}`,
      timeMs: c.timeMs,
      category: 'custom' as const,
      title: c.name,
      attributes: c.attributes,
    }));
}
