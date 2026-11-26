/**
 * Plays real recordings through the bench player: BENCH_SESSIONS points to a
 * directory of <session>.lines.json files (Faro payload lines as Loki returns
 * them, never committed) and optional <session>.zoom.json (zoom samples). For
 * every resize and page load it checks what the player shows and saves
 * screenshots to results/real/<session>/.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { linesFromPayload, openPlayer, seek } from './lib';
import type { ReplayState } from './player';

const dir = process.env.BENCH_SESSIONS;
const sessions = dir
  ? readdirSync(dir)
      .filter((file) => file.endsWith('.lines.json'))
      .map((file) => file.replace('.lines.json', ''))
  : [];

for (const sessionId of sessions) {
  test(`real session ${sessionId}`, async ({ page }) => {
    const lines: string[] = JSON.parse(readFileSync(path.join(dir!, `${sessionId}.lines.json`), 'utf8'));
    const zoomFile = path.join(dir!, `${sessionId}.zoom.json`);
    const zoom = existsSync(zoomFile) ? JSON.parse(readFileSync(zoomFile, 'utf8')) : undefined;
    // A phone-sized player and a desktop-sized one.
    await openPlayer(page, { sessionId, lines: linesFromPayload(lines), zoom, width: 900, height: 700 });
    const bench = await page.evaluate(() => ({
      startMs: window.bench.startMs,
      totalMs: window.bench.totalMs,
      pages: window.bench.pages,
    }));

    // Every event that changes the viewport, and a second after it.
    const events = lines
      .map((line) => /event_data_event="((?:[^"\\]|\\.)*)"/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(
        (match) =>
          JSON.parse(JSON.parse(`"${match[1]}"`)) as { type: number; timestamp: number; data: Record<string, unknown> }
      );
    const marks = events
      .filter((event) => event.type === 4 || (event.type === 3 && event.data.source === 4))
      .flatMap((event) => [event.timestamp - bench.startMs + 50, event.timestamp - bench.startMs + 1000])
      .filter((offset) => offset >= 0 && offset <= bench.totalMs);
    const out = path.join(__dirname, 'artifacts', 'real', sessionId);
    mkdirSync(out, { recursive: true });
    const report: ReplayState[] = [];
    for (const [index, offset] of [...new Set(marks)].sort((a, b) => a - b).entries()) {
      const state = await seek(page, offset);
      report.push(state);
      if (index < 40) {
        await page
          .locator('#root')
          .screenshot({ path: path.join(out, `${String(index).padStart(2, '0')}-${Math.round(offset)}.png`) });
      }
    }
    writeFileSync(path.join(out, 'report.json'), JSON.stringify({ bench, report }, null, 1));
    // While only the height changes (URL bar, keyboard) the page keeps its scale and place on the stage.
    const jumps = report.filter((state, index) => {
      const before = report[index - 1];
      const place = (value: typeof state) => `${value.wrapper.transform} ${value.wrapper.left} ${value.wrapper.top}`;
      return before && before.iframe.width === state.iframe.width && place(before) !== place(state);
    });
    expect(jumps.map((state) => `${Math.round(state.offsetMs)} ms: ${state.wrapper.transform}`)).toEqual([]);
    expect(report.flatMap((state) => state.errors)).toEqual([]);
  });
}
