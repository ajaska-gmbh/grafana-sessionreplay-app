jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

const queries: string[] = [];
const fetcherState = { failAudio: false };

const SESSION = 'p033owWikG';
const LEVEL_LINE =
  'timestamp="2026-11-04 12:33:42.775 +0000 UTC" kind=measurement type=twilio_audio_level ' +
  'value_agent_mic_avg=0.11 value_agent_mic_max=0.19 value_customer_audio_avg=0.02 value_customer_audio_max=0.04 ' +
  `value_samples=18 value_window_ms=949 context_phase=call session_id=${SESSION}`;

jest.mock('../lib/loki', () => {
  const actual = jest.requireActual('../lib/loki');
  return {
    ...actual,
    createLokiFetcher:
      () =>
      async ({ expr }: { expr: string }) => {
        queries.push(expr);
        // Only the graph's own query includes these types; the journey's excludes them (!~).
        if (!expr.includes(' |~ ')) {
          return [];
        }
        if (fetcherState.failAudio) {
          throw new Error('loki timeout');
        }
        return [{ tsNs: '1793795622847758518', line: LEVEL_LINE }];
      },
  };
});

import { renderHook, waitFor } from '@testing-library/react';
import { useSessionData } from './useSessionData';

const isAudioQuery = (expr: string) => expr.includes(' |~ ');

describe('useSessionData audio levels', () => {
  beforeEach(() => {
    queries.length = 0;
    fetcherState.failAudio = false;
  });

  it("loads the session's audio levels on their own, and keeps them coming live", async () => {
    const { result, unmount } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, from: 1_000, to: 2_000, live: true })
    );
    try {
      await waitFor(() => expect(result.current.loadingAudioLevels).toBe(false));
      expect(result.current.audioLevels).toHaveLength(1);
      expect(result.current.audioLevels[0]).toMatchObject({
        phase: 'call',
        samples: 18,
        agentAvg: 0.11,
        customerAvg: 0.02,
      });
      // The initial load and at least one live poll.
      await waitFor(() => expect(queries.filter(isAudioQuery).length).toBeGreaterThanOrEqual(2));
    } finally {
      unmount();
    }
  });

  it('shows the replay and the journey even when the audio levels cannot be loaded', async () => {
    fetcherState.failAudio = true;
    const { result } = renderHook(() =>
      useSessionData({ lokiUid: 'loki', sessionId: SESSION, from: 1_000, to: 2_000 })
    );

    await waitFor(() => expect(result.current.loadingAudioLevels).toBe(false));
    expect(result.current.error).toBeUndefined();
    expect(result.current.audioLevels).toEqual([]);
    await waitFor(() => expect(result.current.loadingJourney).toBe(false));
  });
});
