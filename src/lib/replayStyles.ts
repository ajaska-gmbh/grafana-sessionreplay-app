import { REPLAY_TEXT_RULES } from './replayText';

/**
 * Style rules injected into every replayed page (rrweb insertStyleRules).
 *
 * Scroll anchoring off: when the replayed viewport's height changes (a phone's
 * URL bar or keyboard) and content above the scroll position changes size
 * with it (100vh sections), Chromium shifts the scroll position to keep the
 * visible content in place. The visitor's browser did that already, or did
 * not (Safari has no scroll anchoring); either way the recording holds the
 * scroll positions it ended up at, and the replay must show exactly those.
 */
export const REPLAY_STYLE_RULES: string[] = [
  'html, body, * { overflow-anchor: none !important; }',
  ...REPLAY_TEXT_RULES,
];
