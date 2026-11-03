import pluginJson from './plugin.json';

export const PLUGIN_ID = pluginJson.id;
export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Sessions = 'sessions',
  App = 'app',
}

export const DEFAULT_LOKI_UID = 'loki';
export const DEFAULT_TEMPO_UID = 'tempo';

/** Loki stream that holds the small Faro signals, incl. the replay markers. */
export const FARO_SOURCE = 'faro';
/** Loki stream that holds the rrweb payloads (see the Alloy loki.process "faro"). */
export const FARO_REPLAY_SOURCE = 'faro_replay';

/** Faro ends a session after 4h at most; replays never span more than that. */
export const MAX_SESSION_MS = 4 * 60 * 60 * 1000;
/** Lines per Loki request; also Loki's default max_entries_limit_per_query. */
export const LOKI_PAGE_SIZE = 5000;
