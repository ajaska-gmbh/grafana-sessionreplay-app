import type { LokiLine } from '../types';
import { STREAMS } from './logql';
import { compareNs } from './loki';
import { chunkKey, decodeReplayLines, ReplayTimeline, type DecodedReplayEvent, type ReplayTrack } from './replayEvents';
import { buildRecordings, parseLastLine, parseMetaLines, type LastLine, type ReplayIndex } from './replaySource';

/**
 * Real Faro lines as written by Alloy's faro.receiver (logfmt), trimmed of
 * the browser user agent and with user details replaced by test values.
 */
const meta =
  'sdk_name=faro-web sdk_version=2.13.0 app_name=ppd-testing-1-frontend app_version=abc123 app_environment=testing ' +
  'user_email=agent@example.com user_id=16 user_username=Agent user_attr_state=AVAILABLE session_id=p033owWikG ' +
  'page_url=https://testing-1.ppd.ajaska.de/ browser_name=Edge browser_version=156.0.0.0 browser_os="Windows 10" ' +
  'browser_mobile=false browser_language=de view_name=/';

export const SESSION_ID = 'p033owWikG';

export const logLine = `timestamp="2026-11-03 12:37:15.539 +0000 UTC" kind=log message="[PPD] Twilio lifecycle" level=info context_event=call.remote-audio-created ${meta}`;

export const exceptionLine =
  'timestamp="2026-11-03 12:15:44.537 +0000 UTC" kind=exception type=Error ' +
  'value="console.error: Error updating user state: ApolloError: Failed to fetch" ' +
  'stacktrace="Error: console.error: Error updating user state\\n  at ? (https://ppd.ajaska.de/build/assets/app.js:71:2349)\\n  at Array.forEach (\\u003canonymous\\u003e:0:0)" ' +
  `hash=12651449463755804055 traceID=6f3bcc02329606149b345051f07ec85e ${meta}`;

export const audioLevelLine = (type: string) =>
  `timestamp="2026-11-03 12:37:20.000 +0000 UTC" kind=measurement type=${type} ` +
  'value_agent_mic_avg=0.21 value_agent_mic_max=0.48 value_customer_audio_avg=0.17 value_customer_audio_max=0.44 ' +
  'value_agent_mic_silent_ratio=0 value_customer_audio_silent_ratio=0.1 value_samples=20 value_window_ms=1000 ' +
  `context_context=agent-conference context_callSid=CA123 context_direction=OUTGOING context_phase=call ${meta}`;

export const micSilentLine =
  'timestamp="2026-11-03 12:37:28.000 +0000 UTC" kind=log message="[PPD] Twilio agent mic silent" level=warn ' +
  `context_callSid=CA123 context_channel=agent_mic context_silentForMs=8000 ${meta}`;

export const idleMicLevelLine =
  'timestamp="2026-11-03 12:37:21.000 +0000 UTC" kind=measurement type=twilio_mic_level_idle ' +
  'value_agent_mic_avg=0.18 value_agent_mic_max=0.41 value_agent_mic_silent_ratio=0 value_samples=60 value_window_ms=1000 ' +
  `context_phase=idle ${meta}`;

export const idleMicSilentLine =
  'timestamp="2026-11-03 12:37:29.000 +0000 UTC" kind=log message="[PPD] Twilio agent mic silent (idle)" level=warn ' +
  `context_phase=idle context_channel=agent_mic context_silentForMs=8000 ${meta}`;

export const webVitalLine =
  'timestamp="2026-11-03 12:37:14.016 +0000 UTC" kind=measurement type=web-vitals cls=0.014845 ' +
  'context_rating=good value_cls=0.014844889771139692 value_delta=0.0011547316454430957 ' +
  meta;

export const fetchLine =
  'timestamp="2026-11-03 12:12:24.213 +0000 UTC" kind=event event_name=faro.tracing.fetch event_domain=browser ' +
  'event_data_duration_ns=123000064 event_data_http.request.method=POST event_data_http.response.status_code=200 ' +
  'event_data_url.full=https://testing-1.ppd.ajaska.de/graphql traceID=a14cb11472798be32fe77dd3027b78f2 ' +
  `spanID=782a389ab8f7c043 ${meta}`;

export const routeLine = `timestamp="2026-11-03 12:12:25.000 +0000 UTC" kind=event event_name=route_change event_domain=browser event_data_to=/admin/users ${meta}`;

export const resourceLine = `timestamp="2026-11-03 12:12:24.428 +0000 UTC" kind=event event_name=faro.performance.resource event_domain=browser ${meta}`;

/**
 * Replay event line; `payload` is the rrweb event, logfmt-quoted like go-logfmt
 * does. Field order as Faro writes it: the event, then gen, recording id and seq.
 * Events forwarded from cross-origin iframes (the CRM) are serialised with their
 * timestamp first; pass them as `{ timestamp, type, data }`.
 */
export function replayLine(
  payload: Record<string, unknown>,
  opts: { recordingId?: string; gen?: number; seq?: number; sessionId?: string; timestamp?: string } = {}
): string {
  const quoted = JSON.stringify(JSON.stringify(payload));
  const sessionMeta = meta.replace(`session_id=${SESSION_ID}`, `session_id=${opts.sessionId ?? SESSION_ID}`);
  return (
    `timestamp="${opts.timestamp ?? '2026-11-03 12:00:00.000 +0000 UTC'}" kind=event event_name=faro.session_recording.event event_domain=browser ` +
    `event_data_event=${quoted} event_data_gen=${opts.gen ?? 0} event_data_recording_id=${opts.recordingId ?? 'rec1'} ` +
    `event_data_seq=${opts.seq ?? 0} ${sessionMeta}`
  );
}

/**
 * A Meta line exactly as Loki returned it (session XNtXWqeUtk, production,
 * 2026-11-09), user details replaced: pins the index's line filter.
 */
export const REAL_META_LINE =
  'timestamp="2026-11-09 08:14:07.383 +0000 UTC" kind=event event_name=faro.session_recording.event event_domain=browser ' +
  'event_data_event="{\\"type\\":4,\\"data\\":{\\"href\\":\\"https://ppd.ajaska.de/\\",\\"width\\":2554,\\"height\\":1050},\\"timestamp\\":1794212047357}" ' +
  'event_data_gen=0 event_data_recording_id=L9AwCzx15r event_data_seq=0 sdk_name=faro-web sdk_version=2.13.0 ' +
  'app_name=ppd-leads-frontend app_version=ad3b0c67e5540bfb0b7f54b19c9c0e8c6d1617cd app_environment=production ' +
  'user_email=agent@example.com user_id=96 user_username=Agent session_id=XNtXWqeUtk page_url=https://ppd.ajaska.de/ ' +
  'browser_name=Chrome browser_version=157.0.0.0 browser_os="Windows 10" browser_mobile=false ' +
  'browser_userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" ' +
  'browser_language=en-US browser_viewportWidth=2554 browser_viewportHeight=1050 view_name=/';

/** The start of a CRM iframe event line as Loki returned it (same session): timestamp first. */
export const REAL_IFRAME_LINE_START =
  'timestamp="2026-11-09 08:16:38.380 +0000 UTC" kind=event event_name=faro.session_recording.event event_domain=browser ' +
  'event_data_event="{\\"timestamp\\":1794212198380,\\"type\\":3,\\"data\\":{\\"source\\":0,\\"adds\\":[]}}" ' +
  'event_data_gen=0 event_data_recording_id=L9AwCzx15r event_data_seq=139 sdk_name=faro-web ' +
  'app_name=ppd-leads-frontend app_environment=production session_id=XNtXWqeUtk';

export function startedLine(timestamp: string, sessionId = SESSION_ID, recordingId = 'rec1'): string {
  const recording = recordingId ? `event_data_recording_id=${recordingId} ` : '';
  return (
    `timestamp="${timestamp}" kind=event event_name=faro.session_recording.started event_domain=browser ` +
    `${recording}${meta.replace(`session_id=${SESSION_ID}`, `session_id=${sessionId}`)}`
  );
}

/** A session's index from its lines, as fetchReplayIndex builds it from Loki's answers. */
export function indexFromLines(lines: LokiLine[], sessionId = SESSION_ID): ReplayIndex {
  const last = new Map<string, LastLine>();
  let lastLokiNs: string | undefined;
  for (const entry of lines) {
    const parsed = parseLastLine(entry, sessionId);
    const known = parsed && last.get(parsed.recordingId);
    if (parsed && (!known || compareNs(entry.tsNs, known.lokiNs) >= 0)) {
      last.set(parsed.recordingId, parsed);
    }
    if (parsed && (lastLokiNs === undefined || compareNs(entry.tsNs, lastLokiNs) > 0)) {
      lastLokiNs = entry.tsNs;
    }
  }
  return {
    stream: STREAMS.payloads,
    recordings: buildRecordings(parseMetaLines(lines, sessionId), [...last.values()]),
    lastLokiNs,
  };
}

/** The lines' events by chunk key. */
export function chunksOf(lines: LokiLine[], sessionId = SESSION_ID): Map<string, DecodedReplayEvent[]> {
  const chunks = new Map<string, DecodedReplayEvent[]>();
  for (const entry of decodeReplayLines(lines, sessionId).decoded) {
    const key = chunkKey(entry.recordingId, entry.gen);
    chunks.set(key, [...(chunks.get(key) ?? []), entry]);
  }
  return chunks;
}

/** A timeline of the lines with every chunk loaded (in `order` when given). */
export function loadedTimeline(lines: LokiLine[], sessionId = SESSION_ID, order?: string[]): ReplayTimeline {
  const timeline = new ReplayTimeline(indexFromLines(lines, sessionId));
  const chunks = chunksOf(lines, sessionId);
  for (const key of order ?? [...chunks.keys()]) {
    timeline.addChunk(key, chunks.get(key) ?? []);
  }
  return timeline;
}

/** All loaded events of a track, in playing order. */
export function trackEvents(track: ReplayTrack) {
  return track.chunks.flatMap((chunk) => chunk.events);
}

/** Lines with Loki times: each line arrives `lagMs` after its rrweb time. */
export function linesOf(
  events: Array<{ event: Record<string, unknown> & { timestamp: number }; recordingId?: string; gen?: number }>,
  lagMs = 2000,
  sessionId = SESSION_ID
): LokiLine[] {
  const seqs = new Map<string, number>();
  return events.map(({ event, recordingId = 'rec1', gen = 0 }) => {
    const seq = seqs.get(recordingId) ?? 0;
    seqs.set(recordingId, seq + 1);
    return {
      tsNs: `${event.timestamp + lagMs}000000`,
      line: replayLine(event, { recordingId, gen, seq, sessionId }),
    };
  });
}
