import { appFilter, appLineFilter, STREAMS } from './logql';
import { logqlString } from './loki';

/** A search field is a Faro event attribute name; Faro writes it as `event_data_<name>`. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Longest value searched for; longer input is not an id. */
export const MAX_SEARCH_LENGTH = 200;

/** The configured search fields that are attribute names; anything else is ignored. */
export function validSearchFields(fields: unknown): string[] {
  return Array.isArray(fields)
    ? [...new Set(fields.filter((f): f is string => typeof f === 'string' && FIELD.test(f)))]
    : [];
}

/**
 * The search text from a link's `q`. Links copied before 0.6.2 hold the
 * search box's regex escaping (`cc90db97\-dce5\-…`); a lead id, user, email
 * or page never contains a backslash, so they are dropped.
 */
export function searchParam(q: string | null): string {
  return (q ?? '').replace(/\\(.)/g, '$1');
}

/** The value to look up, or undefined when there is nothing (sensible) to look up. */
export function searchValue(text: string): string | undefined {
  const value = text.trim();
  return value.length > 0 && value.length <= MAX_SEARCH_LENGTH ? value : undefined;
}

/**
 * Sessions with an event whose `fields` attribute is exactly `value`, by
 * session: `sum by (session_id)(count_over_time(…))`. The line filter on the
 * value keeps Loki from parsing every event; the label filter then makes the
 * match exact, so `12345` finds lead 12345 and not every timestamp holding it.
 */
export function sessionSearchQuery(fields: string[], value: string, apps: string[], rangeSeconds: number): string {
  const exact = fields.map((field) => `event_data_${field}=${logqlString(value)}`).join(' or ');
  return (
    `sum by (session_id) (count_over_time(${STREAMS.faro}${appLineFilter(apps)}${appFilter(apps)}` +
    ` |= "kind=event" |= ${logqlString(value)} | logfmt | ${exact} [${rangeSeconds}s]))`
  );
}

/** Whether a journey event carries `value` in one of the search fields: what the replay highlights. */
export function eventMatches(attributes: Record<string, string>, fields: string[], value: string | undefined): boolean {
  return value !== undefined && fields.some((field) => attributes[`event_data_${field}`] === value);
}
