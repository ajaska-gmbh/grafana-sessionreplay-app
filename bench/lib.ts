import type { Page } from '@playwright/test';
import type { BenchInput, ReplayState } from './player';

/** Opens the bench player with these lines. */
export async function openPlayer(page: Page, input: BenchInput): Promise<void> {
  await page.addInitScript((value) => {
    (window as unknown as { benchInput: BenchInput }).benchInput = value;
  }, input);
  await page.setViewportSize({ width: input.width ?? 1200, height: (input.height ?? 800) + 40 });
  await page.goto('/pages/player.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as unknown as { bench?: unknown }).bench));
}

export async function seek(page: Page, offsetMs: number): Promise<ReplayState> {
  return page.evaluate((offset) => window.bench.seek(offset), offsetMs);
}

/** Loki lines from Faro payload lines (the Loki timestamp: the event's own plus a little lag). */
export function linesFromPayload(lines: string[]): BenchInput['lines'] {
  return lines.map((line) => {
    const match = /\\"timestamp\\":(\d+)/.exec(line);
    return { tsNs: `${match ? Number(match[1]) + 2000 : 0}000000`, line };
  });
}
