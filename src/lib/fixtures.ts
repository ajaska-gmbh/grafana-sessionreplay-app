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
  'value_input_avg=0.21 value_input_max=0.48 value_output_avg=0.17 value_output_max=0.44 ' +
  'value_input_silent_ratio=0 value_output_silent_ratio=0.1 value_samples=20 value_window_ms=1000 ' +
  `context_context=agent-conference context_callSid=CA123 context_direction=OUTGOING context_phase=call ${meta}`;

export const micSilentLine =
  'timestamp="2026-11-03 12:37:28.000 +0000 UTC" kind=log message="[PPD] Twilio mic silent" level=warn ' +
  `context_callSid=CA123 context_silentForMs=8000 ${meta}`;

export const idleMicLevelLine =
  'timestamp="2026-11-03 12:37:21.000 +0000 UTC" kind=measurement type=twilio_mic_level_idle ' +
  'value_input_avg=0.18 value_input_max=0.41 value_input_silent_ratio=0 value_samples=60 value_window_ms=1000 ' +
  `context_phase=idle ${meta}`;

export const idleMicSilentLine =
  'timestamp="2026-11-03 12:37:29.000 +0000 UTC" kind=log message="[PPD] Twilio mic silent (idle)" level=warn ' +
  `context_phase=idle context_silentForMs=8000 ${meta}`;

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

/** Replay event line; `payload` is the rrweb event, logfmt-quoted like go-logfmt does. */
export function replayLine(
  payload: Record<string, unknown>,
  opts: { recordingId?: string; gen?: number; seq?: number; sessionId?: string } = {}
): string {
  const quoted = JSON.stringify(JSON.stringify(payload));
  const sessionMeta = meta.replace(`session_id=${SESSION_ID}`, `session_id=${opts.sessionId ?? SESSION_ID}`);
  return (
    `timestamp="2026-11-03 12:00:00.000 +0000 UTC" kind=event event_name=faro.session_recording.event event_domain=browser ` +
    `event_data_event=${quoted} event_data_recording_id=${opts.recordingId ?? 'rec1'} ` +
    `event_data_gen=${opts.gen ?? 0} event_data_seq=${opts.seq ?? 0} ${sessionMeta}`
  );
}

export function startedLine(timestamp: string, sessionId = SESSION_ID, recordingId = 'rec1'): string {
  const recording = recordingId ? `event_data_recording_id=${recordingId} ` : '';
  return (
    `timestamp="${timestamp}" kind=event event_name=faro.session_recording.started event_domain=browser ` +
    `${recording}${meta.replace(`session_id=${SESSION_ID}`, `session_id=${sessionId}`)}`
  );
}
