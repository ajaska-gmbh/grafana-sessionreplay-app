# Replay bench

Checks that replays of phones and tablets show what the visitor saw. It runs
the app's real `ReplayPlayer` outside Grafana (`player.tsx`, bundled by
`webpack.config.ts`) and drives it with Playwright.

```sh
npm run bench                                   # build, type-check, run
BENCH_SESSIONS=/path/to/dir npm run bench       # also replay real sessions
```

## Scripted visits (`mobile.bench.ts`)

Records visits to the test pages in `pages/` on emulated devices (iPhone 13 and
iPad gen 7 in WebKit, Pixel 7 and Galaxy Tab S4 in Chromium), with the recorder
settings and zoom samples of LP Shop's storefront (`recorder.ts`): scrolling,
the URL bar showing and hiding, the keyboard, typing (a card number in a page
field is masked), a cross-origin card field with `data-replay-text`, a pinch
zoom (Chromium), turning to landscape and back, and a second page load. Each
visit also runs on a page wider than the screen (it opens zoomed out).

At every step the page records the ground truth (layout width, scroll
position, element positions, zoom). The replay at that moment must match: the
layout width it is laid out at, the scroll position, every marked element's
position and width within 3 px, the card field's replay text, the visitor's
pinch zoom, and a page that keeps its scale and place while only the height
changes. Screenshots and the reports go to `artifacts/mobile/<device>/`.

Known limits, not checked: on a page wider than the screen Chromium sizes fixed
elements to the zoomed-out view while the page lays out at the screen's width
(one iframe cannot show both); WebKit's emulation never opens a wide page
zoomed out (real iOS does), so that case runs in Chromium only.

## Real sessions (`real.bench.ts`)

`BENCH_SESSIONS` points to a directory of `<session>.lines.json` (the session's
Faro payload lines as Loki returns them) and optional `<session>.zoom.json`
(its zoom samples). Keep them outside the repository: they are visitor data.
Each session is stepped through every page load and resize; the replay must not
log errors and must keep its scale and place while only the height changes.
Screenshots go to `artifacts/real/<session>/`.
