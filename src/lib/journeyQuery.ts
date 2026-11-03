import { HIDDEN_MEASUREMENT_TYPES } from './journey';
import { logqlString } from './loki';
import { regexEscape, sessionLineFilter, STREAMS } from './logql';

/**
 * Line filter that drops the measurement types the journey never shows, so
 * Loki does not send a line per second of every call only for the browser to
 * throw it away. Anchored on the logfmt field, so `context_type=…` and longer
 * type names do not match.
 */
export function hiddenMeasurementsLineFilter(): string {
  const types = HIDDEN_MEASUREMENT_TYPES.map(regexEscape).join('|');
  return ` !~ ${logqlString(`(^| )type=(${types})( |$)`)}`;
}

/** One session's journey lines: the Faro stream without the hidden measurements. */
export function journeyQuery(sessionId: string): string {
  return STREAMS.faro + sessionLineFilter(sessionId) + hiddenMeasurementsLineFilter();
}
