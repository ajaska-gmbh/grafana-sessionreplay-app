/**
 * Records scripted visits on emulated phones and tablets (WebKit for iOS,
 * Chromium for Android) with the storefront's recorder settings, then plays
 * them in the app's ReplayPlayer and compares the replay with what the page
 * really showed at every step: the layout width the page was laid out at, the
 * scroll position, where elements were, the card field's replay text, and
 * that the replay keeps its scale while only the height changes.
 */
import {
  chromium,
  devices,
  expect,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { eventWithTime } from '@grafana/rrweb-types';
import { openPlayer, seek } from './lib';
import type { Truth, ZoomOut } from './recorder';

interface Device {
  name: string;
  engine: 'webkit' | 'chromium';
  descriptor: (typeof devices)[string];
}

const DEVICES: Device[] = [
  { name: 'iphone', engine: 'webkit', descriptor: devices['iPhone 13'] },
  { name: 'ipad', engine: 'webkit', descriptor: devices['iPad (gen 7)'] },
  { name: 'pixel', engine: 'chromium', descriptor: devices['Pixel 7'] },
  { name: 'galaxy-tab', engine: 'chromium', descriptor: devices['Galaxy Tab S4'] },
];

interface Visit {
  events: eventWithTime[];
  truth: Truth[];
  zoom: ZoomOut[];
  /** The page load each event belongs to (Faro starts a new recording per page load). */
  recordings: string[];
}

/** Collects what the recorder on the current page gathered (before it is left). */
async function collect(page: Page, visit: Visit, recording: string): Promise<void> {
  // Let rrweb's throttled scroll and resize events out.
  await page.waitForTimeout(300);
  const { events, truth, zoom } = await page.evaluate(() => ({
    events: window.benchEvents,
    truth: window.benchTruth,
    zoom: window.benchZoom,
  }));
  visit.events.push(...events);
  visit.recordings.push(...events.map(() => recording));
  visit.truth.push(...truth);
  visit.zoom.push(...zoom);
}

async function mark(page: Page, label: string): Promise<void> {
  // rrweb's scroll (100 ms) and resize observers settle first.
  await page.waitForTimeout(400);
  await page.evaluate((value) => window.benchMark(value), label);
}

/** The browser chrome appearing or going (URL bar, keyboard): only the height changes. */
async function setHeight(page: Page, height: number): Promise<void> {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height });
}

async function scenario(page: Page, device: Device, visit: Visit, overflow: boolean): Promise<void> {
  const { width, height } = device.descriptor.viewport;
  await page.goto(`/pages/shop.html${overflow ? '?overflow=1' : ''}`);
  await page.waitForFunction(() => window.benchEvents?.length > 1);
  await mark(page, 'load');
  await page.evaluate(() => window.scrollTo(0, 900));
  await mark(page, 'scrolled');
  // URL bar hides and shows while scrolling (iOS: several times a second).
  for (const delta of [40, 0, 28, 0]) {
    await setHeight(page, height + delta);
    await mark(page, `url bar ${delta}`);
  }
  // Tap the email field, the keyboard opens (in-app browsers shrink the viewport).
  await page.locator('[data-bench="email"]').scrollIntoViewIfNeeded();
  await page.locator('[data-bench="email"]').tap();
  await setHeight(page, Math.round(height * 0.55));
  await page.keyboard.type('jane@example.com', { delay: 20 });
  await mark(page, 'keyboard');
  await page.locator('[data-bench="manual-card"]').tap();
  await page.keyboard.type('4242424242424242', { delay: 10 });
  // The checkout writes the card field's state for the replay (LP Shop: storefront/stripe/replayText.ts).
  await page.evaluate(() => {
    const box = document.querySelector('[data-bench="card-number"]')!;
    box.setAttribute('data-replay-text', 'Visa •••• •••• •••• ••••');
    box.setAttribute('data-replay-state', 'complete');
    box.setAttribute('data-replay-kind', 'field');
  });
  await setHeight(page, height);
  await mark(page, 'keyboard closed');
  if (device.engine === 'chromium') {
    // Pinch zoom in on the card field.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await mark(page, 'pinch 2x');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await mark(page, 'pinch back');
  }
  // Turned to landscape and back.
  await page.setViewportSize({ width: height, height: width });
  await mark(page, 'landscape');
  await page.setViewportSize({ width, height });
  await mark(page, 'portrait');
  await collect(page, visit, overflow ? 'shop-wide' : 'shop');
  // On to the checkout: a new page load.
  await page.goto('/pages/checkout.html');
  await page.waitForFunction(() => window.benchEvents?.length > 1);
  await mark(page, 'checkout');
  await page.evaluate(() => window.scrollTo(0, 400));
  await mark(page, 'checkout scrolled');
  await collect(page, visit, overflow ? 'checkout-wide' : 'checkout');
}

const SESSION = 'BenchSessn';

/** A payload line as Alloy's faro.receiver writes it (see src/lib/fixtures.ts replayLine). */
function replayLine(event: eventWithTime, recordingId: string, seq: number): string {
  return (
    `timestamp="2026-11-26 12:00:00.000 +0000 UTC" kind=event event_name=faro.session_recording.event event_domain=browser ` +
    `event_data_event=${JSON.stringify(JSON.stringify(event))} event_data_gen=0 event_data_recording_id=${recordingId} ` +
    `event_data_seq=${seq} sdk_name=faro-web app_name=bench app_environment=bench session_id=${SESSION} browser_mobile=true`
  );
}

function linesOf(visit: Visit) {
  const seqs = new Map<string, number>();
  return visit.events
    .map((event, index) => ({ event, recording: visit.recordings[index] }))
    .sort((a, b) => a.event.timestamp - b.event.timestamp)
    .map(({ event, recording }) => {
      const seq = seqs.get(recording) ?? 0;
      seqs.set(recording, seq + 1);
      return { tsNs: `${event.timestamp + 500}000000`, line: replayLine(event, recording, seq) };
    });
}

for (const device of DEVICES) {
  for (const overflow of [false, true]) {
    test(`${device.name}${overflow ? ', page wider than the screen' : ''}: the replay shows what the visitor saw`, async ({
      page: player,
      baseURL,
    }) => {
      const browser: Browser = await (device.engine === 'webkit' ? webkit : chromium).launch();
      const context: BrowserContext = await browser.newContext({ ...device.descriptor, baseURL });
      const page = await context.newPage();
      const visit: Visit = { events: [], truth: [], zoom: [], recordings: [] };
      try {
        await scenario(page, device, visit, overflow);
      } finally {
        await browser.close();
      }

      const out = path.join(__dirname, 'artifacts', 'mobile', `${device.name}${overflow ? '-wide' : ''}`);
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, 'visit.json'), JSON.stringify(visit));
      await openPlayer(player, {
        sessionId: SESSION,
        lines: linesOf(visit),
        zoom: visit.zoom,
        width: 900,
        height: 700,
      });
      const startMs = await player.evaluate(() => window.bench.startMs);

      const rows = [];
      for (const [index, truth] of visit.truth.entries()) {
        const state = await seek(player, truth.timestamp - startMs);
        const shown = Object.fromEntries(
          await Promise.all(
            Object.keys(truth.elements).map(async (name) => [
              name,
              (await player.evaluate((selector) => window.bench.query(selector), `[data-bench="${name}"]`))[0],
            ])
          )
        );
        await player
          .locator('#root')
          .screenshot({
            path: path.join(out, `${String(index).padStart(2, '0')}-${truth.label.replace(/\W+/g, '-')}.png`),
          });
        rows.push({ truth, state, shown });
      }
      writeFileSync(path.join(out, 'report.json'), JSON.stringify(rows, null, 1));

      const problems: string[] = [];
      let lastScale: { width: number; transform: string } | undefined;
      for (const { truth, state, shown } of rows) {
        const at = `${truth.label}:`;
        if (state.iframe.width !== truth.layoutWidth) {
          problems.push(`${at} laid out at ${state.iframe.width} px, the visitor's page at ${truth.layoutWidth} px`);
        }
        if (state.doc && Math.abs(state.doc.scrollY - truth.scrollY) > 3) {
          problems.push(`${at} scrolled to ${state.doc.scrollY}, the visitor to ${truth.scrollY}`);
        }
        for (const [name, real] of Object.entries(truth.elements)) {
          const replayed = shown[name];
          if (!replayed) {
            problems.push(`${at} ${name} missing`);
            continue;
          }
          // Known limit: on a page wider than the screen Chromium sizes fixed elements to the zoomed-out
          // view while the page lays out at the screen's width; one iframe cannot show both.
          if (name === 'cta' && truth.layoutWidth < truth.innerWidth) {
            continue;
          }
          for (const key of ['top', 'left', 'width'] as const) {
            // The 100vh hero follows the replayed viewport's height, like the visitor's.
            if (Math.abs(replayed[key] - real[key]) > 3 && !(name === 'hero' && key === 'top')) {
              problems.push(`${at} ${name}.${key} ${Math.round(replayed[key])} instead of ${Math.round(real[key])}`);
            }
          }
          if (real.text && replayed.after !== JSON.stringify(real.text)) {
            problems.push(`${at} ${name} shows ${replayed.after} instead of "${real.text}"`);
          }
        }
        // A pinch zoom shows on the page (the visitor's zoom, from the page's zoom samples).
        if (truth.scale > 1.01 && !state.wrapper.clipPath) {
          problems.push(`${at} the visitor's ${truth.scale}x zoom is not shown`);
        }
        // Only the height changed since the last step: the page keeps its scale and place.
        if (
          lastScale &&
          lastScale.width === state.iframe.width &&
          truth.label.startsWith('url bar') &&
          lastScale.transform !== `${state.wrapper.transform} ${state.wrapper.left} ${state.wrapper.top}`
        ) {
          problems.push(
            `${at} the replay moved (${lastScale.transform} → ${state.wrapper.transform} ${state.wrapper.left} ${state.wrapper.top})`
          );
        }
        lastScale = {
          width: state.iframe.width,
          transform: `${state.wrapper.transform} ${state.wrapper.left} ${state.wrapper.top}`,
        };
        problems.push(...state.errors.map((error) => `${at} ${error}`));
      }
      writeFileSync(path.join(out, 'problems.txt'), problems.join('\n'));
      expect(problems).toEqual([]);
    });
  }
}
