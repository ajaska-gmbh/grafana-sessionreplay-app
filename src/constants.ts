import pluginJson from './plugin.json';

export const PLUGIN_ID = pluginJson.id;
export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Sessions = 'sessions',
  Agents = 'agents',
  App = 'app',
}

export const DEFAULT_LOKI_UID = 'loki';
export const DEFAULT_TEMPO_UID = 'tempo';

/** Faro ends a session after 4h at most; replays never span more than that. */
export const MAX_SESSION_MS = 4 * 60 * 60 * 1000;
/** Lines per Loki request; also Loki's default max_entries_limit_per_query. */
export const LOKI_PAGE_SIZE = 5000;
/**
 * Lines per request for replay payloads: DOM snapshots can be several MB each
 * and Grafana's backend holds the whole response in memory.
 */
export const REPLAY_PAGE_SIZE = 1000;
/**
 * Slack around a session's time range: Loki stores the receive time, the
 * markers carry the browser's clock, and agent PCs' clocks drift.
 */
export const CLOCK_SLACK_MS = 10 * 60 * 1000;
