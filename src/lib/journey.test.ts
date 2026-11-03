import { buildJourney, faroTimeMs, toJourneyEvent } from './journey';
import {
  exceptionLine,
  fetchLine,
  logLine,
  replayLine,
  resourceLine,
  routeLine,
  SESSION_ID,
  webVitalLine,
} from './fixtures';

describe('faroTimeMs', () => {
  it('parses the Faro timestamp field', () => {
    expect(faroTimeMs({ timestamp: '2026-11-03 12:37:15.539 +0000 UTC' }, '0000000')).toBe(
      Date.parse('2026-11-03T12:37:15.539Z')
    );
  });

  it('falls back to the Loki timestamp', () => {
    expect(faroTimeMs({}, '1793709435702765236')).toBe(1793709435702);
  });
});

describe('toJourneyEvent', () => {
  it('classifies network requests like "Fetch request (POST 200)"', () => {
    const event = toJourneyEvent('1', fetchLine, SESSION_ID);

    expect(event).toMatchObject({
      category: 'network',
      title: 'Fetch request (POST 200)',
      detail: 'https://testing-1.ppd.ajaska.de/graphql · 123 ms',
      traceId: 'a14cb11472798be32fe77dd3027b78f2',
    });
  });

  it('classifies route changes as navigation', () => {
    expect(toJourneyEvent('1', routeLine, SESSION_ID)).toMatchObject({
      category: 'navigation',
      title: 'route_change',
      detail: '/admin/users',
    });
  });

  it('shows exceptions as errors with type and message', () => {
    expect(toJourneyEvent('1', exceptionLine, SESSION_ID)).toMatchObject({
      category: 'error',
      title: 'Error: console.error: Error updating user state: ApolloError: Failed to fetch',
      traceId: '6f3bcc02329606149b345051f07ec85e',
    });
  });

  it('names web vitals', () => {
    expect(toJourneyEvent('1', webVitalLine, SESSION_ID)).toMatchObject({
      category: 'custom',
      title: 'Cumulative Layout Shift: 0.0148 (good)',
    });
  });

  it('keeps info logs as custom events', () => {
    expect(toJourneyEvent('1', logLine, SESSION_ID)).toMatchObject({
      category: 'custom',
      title: '[PPD] Twilio lifecycle',
    });
  });

  it('hides replay payloads, resource timings and other sessions', () => {
    expect(toJourneyEvent('1', replayLine({ type: 2, timestamp: 1, data: {} }), SESSION_ID)).toBeUndefined();
    expect(toJourneyEvent('1', resourceLine, SESSION_ID)).toBeUndefined();
    expect(toJourneyEvent('1', logLine, 'someoneElse')).toBeUndefined();
  });
});

describe('buildJourney', () => {
  it('sorts by browser time and drops duplicates', () => {
    const journey = buildJourney(
      [
        { tsNs: '3', line: logLine },
        { tsNs: '1', line: fetchLine },
        { tsNs: '1', line: fetchLine },
        { tsNs: '2', line: routeLine },
      ],
      SESSION_ID
    );

    expect(journey.map((event) => event.category)).toEqual(['network', 'navigation', 'custom']);
  });
});
