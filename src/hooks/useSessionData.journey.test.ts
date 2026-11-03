jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

const queries: string[] = [];

jest.mock('../lib/loki', () => {
  const actual = jest.requireActual('../lib/loki');
  return {
    ...actual,
    createLokiFetcher:
      () =>
      async ({ expr }: { expr: string }) => {
        queries.push(expr);
        return [];
      },
  };
});

import { renderHook, waitFor } from '@testing-library/react';
import { useSessionData } from './useSessionData';

const HIDDEN = '!~ "(^| )type=(twilio_audio_level|telnyx_audio_level|twilio_mic_level_idle)( |$)"';
const isJourneyQuery = (expr: string) => expr.startsWith('{source="faro"}');

describe('useSessionData', () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it('never asks Loki for the per-second audio level measurements, neither on load nor live', async () => {
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: 'p033owWikG', from: 1_000, to: 2_000, live: true })
    );
    // Live mode polls until unmounted; stop it whatever the outcome.
    try {
      await waitFor(() => expect(result.current.loadingJourney).toBe(false));
      // The initial journey query and at least one live poll.
      await waitFor(() => expect(queries.filter(isJourneyQuery).length).toBeGreaterThanOrEqual(2));
    } finally {
      unmount();
    }

    const journeyQueries = queries.filter(isJourneyQuery);
    expect(journeyQueries.length).toBeGreaterThanOrEqual(2);
    for (const expr of journeyQueries) {
      expect(expr).toBe(`{source="faro"} |= "session_id=p033owWikG" ${HIDDEN}`);
    }
  });
});
