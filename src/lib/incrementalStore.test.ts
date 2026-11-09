jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { buildJourney } from './journey';
import { RRWEB_FULL_SNAPSHOT, RRWEB_META } from './replayEvents';
import { loadedTimeline, replayLine, SESSION_ID, trackEvents } from './fixtures';
import { SessionStore } from './sessionStore';
import type { LokiLine } from '../types';

/**
 * A long session: two recordings back to back, then a tab open alongside the
 * second; a checkout (new gen: Meta + full snapshot) every 1200 events.
 */
function replayLines(count: number): LokiLine[] {
  const lines: LokiLine[] = [];
  const positions = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const recordingId = i < count / 2 ? 'rec1' : i % 3 === 0 ? 'rec3' : 'rec2';
    const start = recordingId === 'rec1' ? 0 : recordingId === 'rec2' ? 1e9 : 1e9 + 500;
    const position = positions.get(recordingId) ?? 0;
    positions.set(recordingId, position + 1);
    const gen = Math.floor(position / 1200);
    const inGen = position % 1200;
    const type = inGen === 0 ? RRWEB_META : inGen === 1 ? RRWEB_FULL_SNAPSHOT : 3;
    const payload = { type, timestamp: 1_762_000_000_000 + start + position * 250, data: { i } };
    lines.push({
      tsNs: String(1_762_000_000_000_000_000 + (start + position * 250) * 1_000_000),
      line: replayLine(payload, { recordingId, gen, seq: position }),
    });
  }
  return lines;
}

function pages<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

describe('loading page by page', () => {
  it('builds the same replay tracks whatever order the chunks load in', () => {
    const lines = replayLines(12_000);
    const inOrder = loadedTimeline(lines);
    const keys = inOrder.tracks.flatMap((track) => track.chunks.map((chunk) => chunk.key));
    // Outward from the middle, as the loader does for a target there.
    const shuffled = [...keys.slice(keys.length / 2), ...keys.slice(0, keys.length / 2).reverse()];

    const outOfOrder = loadedTimeline(lines, SESSION_ID, shuffled);

    expect(outOfOrder.tracks.map(trackEvents)).toEqual(inOrder.tracks.map(trackEvents));
    expect(inOrder.tracks.length).toBe(2);
  });

  it('builds the same journey as building it from all lines at once', () => {
    const journeyLines: LokiLine[] = Array.from({ length: 3000 }, (_, i) => ({
      tsNs: String(1_762_000_000_000_000_000 + ((i * 7919) % 3000) * 1_000_000),
      line: `timestamp="2026-11-03 12:00:${String(i % 60).padStart(2, '0')}.000 +0000 UTC" kind=event event_name=e${(i * 7919) % 3000} event_domain=browser session_id=${SESSION_ID}`,
    }));
    const store = new SessionStore(SESSION_ID);
    for (const page of pages([...journeyLines, ...journeyLines.slice(0, 100)], 250)) {
      store.addJourneyLines(page);
    }

    expect(store.journey).toEqual(buildJourney(journeyLines, SESSION_ID));
  });

  it('loads a four-hour session chunk by chunk without re-sorting or copying all of it each time', () => {
    // 4 h at ~10 rrweb events a second.
    const lines = replayLines(144_000);
    const started = performance.now();
    const timeline = loadedTimeline(lines);
    const tracks = timeline.tracks;
    const elapsed = performance.now() - started;

    expect(tracks.reduce((n, track) => n + trackEvents(track).length, 0)).toBeGreaterThan(100_000);
    // Generous for CI: decoding alone is most of it.
    expect(elapsed).toBeLessThan(30_000);
  });
});
