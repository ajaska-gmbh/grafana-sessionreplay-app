jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { buildJourney } from './journey';
import {
  decodeReplayLines,
  mergeReplayEvents,
  RRWEB_FULL_SNAPSHOT,
  RRWEB_META,
  type DecodedReplayEvent,
} from './replayEvents';
import { replayLine, SESSION_ID } from './fixtures';
import { SessionStore } from './sessionStore';
import type { LokiLine } from '../types';

/** A long session: recordings back to back, one without a snapshot (dropped), events out of order across pages, repeats. */
function replayLines(count: number): LokiLine[] {
  const lines: LokiLine[] = [];
  for (let i = 0; i < count; i++) {
    const recordingId = i < count / 2 ? 'rec1' : i % 3 === 0 ? 'rec3' : 'rec2';
    const start = recordingId === 'rec1' ? 0 : recordingId === 'rec2' ? 1e9 : 1e9 + 500;
    const position = recordingId === 'rec1' ? i : i - count / 2;
    const type = position === 0 ? RRWEB_META : position === 1 ? RRWEB_FULL_SNAPSHOT : 3;
    const payload = { type, timestamp: 1_762_000_000_000 + start + position * 250, data: { i } };
    lines.push({
      tsNs: String(1_762_000_000_000_000_000 + i),
      line: replayLine(payload, { recordingId, seq: position }),
    });
  }
  // Retried batches: late pages bring earlier events, and some twice.
  return [
    ...lines.slice(0, count / 4),
    ...lines.slice(count / 2),
    ...lines.slice(count / 4, count / 2),
    ...lines.slice(10, 40),
  ];
}

function pages<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

describe('loading page by page', () => {
  it('builds the same replay tracks as merging everything at once', () => {
    const lines = replayLines(2000);
    const store = new SessionStore(SESSION_ID);
    for (const page of pages(lines, 137)) {
      store.addReplayLines(page);
    }

    const known = new Map<string, DecodedReplayEvent>();
    const expected = mergeReplayEvents(known, decodeReplayLines(lines, SESSION_ID).decoded);

    expect(store.tracks).toEqual(expected);
    expect(store.tracks.length).toBeGreaterThan(0);
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

  it('loads a four-hour session in pages without re-sorting all of it each time', () => {
    // 4 h at ~10 rrweb events a second.
    const lines = replayLines(144_000);
    const store = new SessionStore(SESSION_ID);
    const started = performance.now();
    for (const page of pages(lines, 1000)) {
      store.addReplayLines(page);
    }
    const elapsed = performance.now() - started;

    expect(store.tracks.reduce((n, track) => n + track.length, 0)).toBeGreaterThan(100_000);
    // Generous for CI: decoding alone is most of it; a sort per page took several times this.
    expect(elapsed).toBeLessThan(30_000);
  });
});
