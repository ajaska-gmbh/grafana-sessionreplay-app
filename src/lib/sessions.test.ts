import { formatClock, formatOffset, replayUrl, traceExploreUrl } from './format';
import { matchesSearch, summariseSessions } from './sessions';
import { startedLine } from './fixtures';

describe('summariseSessions', () => {
  it('groups started markers per session, newest session first', () => {
    const sessions = summariseSessions([
      // A reload: the old recording is announced again, then the new one starts.
      { tsNs: '0', line: startedLine('2026-11-03 10:05:00.000 +0000 UTC', 'aaaaaaaaaa', 'rec1') },
      { tsNs: '0', line: startedLine('2026-11-03 10:05:00.008 +0000 UTC', 'aaaaaaaaaa', 'rec2') },
      { tsNs: '0', line: startedLine('2026-11-03 10:00:00.000 +0000 UTC', 'aaaaaaaaaa', 'rec1') },
      { tsNs: '0', line: startedLine('2026-11-03 11:00:00.000 +0000 UTC', 'bbbbbbbbbb') },
    ]);

    expect(sessions.map((session) => session.sessionId)).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa']);
    expect(sessions[1]).toMatchObject({
      recordings: 2,
      startedMs: Date.parse('2026-11-03T10:00:00Z'),
      lastStartedMs: Date.parse('2026-11-03T10:05:00.008Z'),
      appName: 'ppd-testing-1-frontend',
      environment: 'testing',
      userEmail: 'agent@example.com',
      browser: 'Edge 156.0.0.0',
      os: 'Windows 10',
    });
  });

  it('counts markers without recording id (replay < 2.13) one each', () => {
    const [session] = summariseSessions([
      { tsNs: '0', line: startedLine('2026-11-03 10:00:00.000 +0000 UTC', 'cccccccccc', '') },
      { tsNs: '0', line: startedLine('2026-11-03 10:01:00.000 +0000 UTC', 'cccccccccc', '') },
    ]);

    expect(session.recordings).toBe(2);
  });

  it('searches across the shown fields', () => {
    const [session] = summariseSessions([{ tsNs: '0', line: startedLine('2026-11-03 10:00:00.000 +0000 UTC') }]);

    expect(matchesSearch(session, 'AGENT@example')).toBe(true);
    expect(matchesSearch(session, 'edge')).toBe(true);
    expect(matchesSearch(session, 'firefox')).toBe(false);
    expect(matchesSearch(session, '  ')).toBe(true);
  });
});

describe('format', () => {
  it('formats clock and offsets', () => {
    expect(formatClock(41_615)).toBe('0:41');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatOffset(136)).toBe('0:00.136');
    expect(formatOffset(-1500)).toBe('-0:01.500');
  });

  it('builds the viewer URL like Grafana (…/app/<app>/session/<id>?t=)', () => {
    expect(replayUrl('ppd-leads-frontend', 'abc', { t: 41615.4, from: 1, to: 2 })).toBe(
      '/a/ajaska-sessionreplay-app/app/ppd-leads-frontend/session/abc?t=41615&from=1&to=2'
    );
    expect(replayUrl('a b', 'c/d')).toBe('/a/ajaska-sessionreplay-app/app/a%20b/session/c%2Fd');
  });

  it('links traces to Explore', () => {
    const url = traceExploreUrl('tempo', 'abc', 1_000_000);
    const panes = JSON.parse(decodeURIComponent(url.split('panes=')[1]));

    expect(panes.trace.queries[0]).toMatchObject({ query: 'abc', datasource: { uid: 'tempo' } });
  });
});
