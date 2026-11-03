import { parseLogfmt } from './logfmt';

export type JourneyCategory = 'navigation' | 'custom' | 'error' | 'network';

export interface JourneyEvent {
  id: string;
  /** Epoch milliseconds of the browser-side event. */
  timeMs: number;
  category: JourneyCategory;
  title: string;
  detail?: string;
  traceId?: string;
  attributes: Record<string, string>;
}

/** Faro events that never appear in the journey (noise or the replay itself). */
const HIDDEN_EVENTS = new Set([
  'faro.session_recording.event',
  'faro.session_recording.started',
  'faro.session_recording.paused',
  'faro.session_recording.resumed',
  'faro.performance.resource',
]);

/**
 * Measurements that never appear in the journey: the dialer's audio levels
 * (per call, and of the idle microphone) arrive every second and would bury
 * everything else. Their silence warnings are logs and still show as errors.
 *
 * The journey query already leaves them out (journeyQuery); this is the
 * safety net for any line that still gets through.
 */
export const HIDDEN_MEASUREMENT_TYPES = ['twilio_audio_level', 'telnyx_audio_level', 'twilio_mic_level_idle'] as const;
const HIDDEN_MEASUREMENTS = new Set<string>(HIDDEN_MEASUREMENT_TYPES);

const NAVIGATION_EVENTS = new Set([
  'session_start',
  'session_resume',
  'session_extend',
  'view_changed',
  'route_change',
  'faro.performance.navigation',
]);

/** Faro web-vitals measurements: value key and display name. */
const WEB_VITALS: Array<[string, string]> = [
  ['cls', 'Cumulative Layout Shift'],
  ['lcp', 'Largest Contentful Paint'],
  ['inp', 'Interaction to Next Paint'],
  ['fcp', 'First Contentful Paint'],
  ['ttfb', 'Time to First Byte'],
  ['fid', 'First Input Delay'],
];

const NETWORK_EVENTS: Record<string, string> = {
  'faro.tracing.fetch': 'Fetch request',
  'faro.tracing.xml-http-request': 'XHR request',
};

/**
 * Parse the timestamp Faro writes into each line
 * (`timestamp="2026-11-03 12:12:24.428 +0000 UTC"`), falling back to the
 * Loki ingestion time.
 */
export function faroTimeMs(fields: Record<string, string>, fallbackNs: string): number {
  const raw = fields.timestamp;
  if (raw) {
    const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{4})/);
    if (match) {
      const offset = `${match[3].slice(0, 3)}:${match[3].slice(3)}`;
      const ms = Date.parse(`${match[1]}T${match[2]}${offset}`);
      if (!Number.isNaN(ms)) {
        return ms;
      }
    }
  }
  return Number(fallbackNs.slice(0, -6));
}

function first(fields: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (fields[key]) {
      return fields[key];
    }
  }
  return undefined;
}

function networkEvent(fields: Record<string, string>, label: string) {
  const method = first(fields, 'event_data_http.request.method', 'event_data_http.method') ?? '';
  const status = first(fields, 'event_data_http.response.status_code', 'event_data_http.status_code') ?? '';
  const url = first(fields, 'event_data_url.full', 'event_data_http.url') ?? '';
  const durationNs = Number(fields.event_data_duration_ns);
  const duration = Number.isFinite(durationNs) && durationNs > 0 ? ` · ${Math.round(durationNs / 1e6)} ms` : '';
  return {
    title: `${label} (${[method, status].filter(Boolean).join(' ')})`,
    detail: `${url}${duration}`,
  };
}

/**
 * Turn one Faro log line into a user-journey entry, or undefined when the
 * line is not shown (replay payloads, resource timings, other sessions).
 */
export function toJourneyEvent(tsNs: string, line: string, sessionId: string): JourneyEvent | undefined {
  const fields = parseLogfmt(line);
  if (fields.session_id !== sessionId) {
    return undefined;
  }

  const timeMs = faroTimeMs(fields, tsNs);
  const traceId = fields.traceID || fields.trace_id || undefined;
  const base = {
    id: `${tsNs}:${fields.kind}:${fields.event_name ?? fields.type ?? ''}`,
    timeMs,
    traceId,
    attributes: fields,
  };

  switch (fields.kind) {
    case 'exception':
      return {
        ...base,
        category: 'error',
        title: fields.type ? `${fields.type}: ${fields.value ?? ''}` : (fields.value ?? 'Exception'),
        detail: fields.stacktrace?.split('\n')[0],
      };
    case 'log': {
      const isProblem = fields.level === 'error' || fields.level === 'warn';
      return {
        ...base,
        category: isProblem ? 'error' : 'custom',
        title: fields.message ?? 'Log',
        detail: fields.level,
      };
    }
    case 'measurement': {
      if (HIDDEN_MEASUREMENTS.has(fields.type ?? '')) {
        return undefined;
      }
      const vital = fields.type === 'web-vitals' ? WEB_VITALS.find(([key]) => fields[`value_${key}`]) : undefined;
      if (vital) {
        const [key, label] = vital;
        const value = Number(fields[`value_${key}`]);
        const shown = key === 'cls' ? value.toFixed(4) : `${Math.round(value)} ms`;
        const rating = fields.context_rating ? ` (${fields.context_rating})` : '';
        return { ...base, category: 'custom', title: `${label}: ${shown}${rating}` };
      }
      const values = Object.entries(fields)
        .filter(([key]) => key.startsWith('value_'))
        .map(([key, value]) => `${key.slice(6)}=${value}`)
        .join(' ');
      return { ...base, category: 'custom', title: fields.type ?? 'Measurement', detail: values };
    }
    case 'event': {
      const name = fields.event_name ?? '';
      if (HIDDEN_EVENTS.has(name)) {
        return undefined;
      }
      if (NETWORK_EVENTS[name]) {
        const network = networkEvent(fields, NETWORK_EVENTS[name]);
        return { ...base, category: 'network', title: network.title, detail: network.detail };
      }
      if (NAVIGATION_EVENTS.has(name)) {
        const to = first(fields, 'event_data_to', 'view_name', 'page_url');
        return { ...base, category: 'navigation', title: name, detail: to };
      }
      return { ...base, category: 'custom', title: name };
    }
    default:
      return undefined;
  }
}

/** Sort by time and drop duplicates (overlapping pages / retried sends). */
export function buildJourney(entries: Iterable<{ tsNs: string; line: string }>, sessionId: string): JourneyEvent[] {
  const byId = new Map<string, JourneyEvent>();
  for (const entry of entries) {
    const event = toJourneyEvent(entry.tsNs, entry.line, sessionId);
    if (event && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => a.timeMs - b.timeMs);
}
