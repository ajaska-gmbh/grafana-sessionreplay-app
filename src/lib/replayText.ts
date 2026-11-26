/**
 * Text a recorded page wants shown where the recording cannot see: an element
 * with `data-replay-text="…"` gets that text drawn over it in the replay only
 * (the visitor's page has no such style). LP Shop's checkout sets it on the
 * boxes of Stripe's card fields, whose cross-origin frames rrweb cannot record,
 * to show what the buyer did with stars instead of the card data
 * (`•••• •••• •••• ••••`); `data-replay-state="invalid"` shows it as an
 * error, and `data-replay-kind="badge"` as a small label in the corner of a
 * large box (the Payment Element) instead of the box's text.
 */
export const REPLAY_TEXT_RULES: string[] = [
  '[data-replay-text] { position: relative; }',
  [
    '[data-replay-text]::after {',
    'content: attr(data-replay-text);',
    'position: absolute; top: 0; right: 0; bottom: 0; left: 0;',
    'display: flex; align-items: center; padding: 0 12px;',
    'font: 500 16px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 1px;',
    'color: #1f2937; white-space: nowrap; overflow: hidden;',
    'pointer-events: none; z-index: 2147483647;',
    '}',
  ].join(' '),
  [
    '[data-replay-text][data-replay-kind="badge"]::after {',
    'top: auto; right: auto; bottom: 6px; left: 6px;',
    'padding: 3px 8px; border-radius: 4px; font-size: 13px;',
    'background: rgba(17, 24, 39, 0.85); color: #fff;',
    '}',
  ].join(' '),
  '[data-replay-text][data-replay-state="invalid"]::after { color: #dc2626; }',
  '[data-replay-text][data-replay-kind="badge"][data-replay-state="invalid"]::after { color: #fecaca; }',
];
