import { logqlString } from './loki';
import { sessionBucket, type PayloadBuckets } from './sessionBucket';

/**
 * The Loki streams written by the Alloy Faro pipeline. They are a fixed set:
 * app and environment are structured metadata (`| app_name="…"`), not labels,
 * so new apps never change these selectors.
 */
export const STREAMS = {
  /** Faro logs, events, errors and measurements. */
  faro: '{source="faro"}',
  /** Session recording started/paused/resumed markers (small). */
  markers: '{source="faro_replay", replay="marker"}',
  /** rrweb events (DOM snapshots can be several MB). */
  payloads: '{source="faro_replay", replay="payload"}',
} as const;

/**
 * The payload stream of one session: its bucket where the session started
 * after the pipeline began labelling buckets, else the whole stream (which
 * also matches bucketed streams).
 */
export function sessionPayloads(sessionId: string, fromMs: number, buckets?: PayloadBuckets): string {
  if (!buckets || fromMs < buckets.sinceMs) {
    return STREAMS.payloads;
  }
  return `{source="faro_replay", replay="payload", session_bucket="${sessionBucket(sessionId, buckets.count)}"}`;
}

/** Escape a value for use inside a RE2 alternative. */
export function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Structured-metadata filter for the selected apps; empty for all apps. */
export function appFilter(apps: string[]): string {
  return apps.length > 0 ? ` | app_name=~${logqlString(apps.map(regexEscape).join('|'))}` : '';
}

/**
 * Line filter that narrows a query to one session before parsing. Session ids
 * are unique across apps, so no app filter is needed. Callers still compare
 * the parsed `session_id`, because the filter also matches as a prefix.
 */
export function sessionLineFilter(sessionId: string): string {
  return ` |= ${logqlString(`session_id=${sessionId}`)}`;
}

/** Line filter for one Faro event name. */
export function eventLineFilter(eventName: string): string {
  return ` |= ${logqlString(`event_name=${eventName}`)}`;
}
