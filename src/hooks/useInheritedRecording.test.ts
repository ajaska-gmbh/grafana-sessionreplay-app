import { act, renderHook, waitFor } from '@testing-library/react';
import { audioSourcesOf } from '../lib/callAudio';
import type { JourneyEvent } from '../lib/journey';
import type { LokiFetcher } from '../lib/loki';
import { INHERIT_LOOKBACK_MS } from '../lib/inheritedRecording';
import { useInheritedRecording } from './useInheritedRecording';

jest.mock('../lib/loki', () => ({ ...jest.requireActual('../lib/loki'), createLokiFetcher: jest.fn() }));

const T = Date.parse('2026-11-12T12:17:13Z');
const base = { app_name: 'ppd-leads-frontend', user_id: '118', session_id: 'NEW', session_attr_previousSession: 'OLD' };
const event = (name: string, timeMs: number, extra: Record<string, string> = {}): JourneyEvent => ({
  id: `${name}-${timeMs}`,
  timeMs,
  category: 'custom',
  title: name,
  attributes: { ...base, event_name: name, ...extra },
});
const startedLine = {
  tsNs: `${T - 4 * 3600_000}000000`,
  line:
    'kind=event event_name=recording.started event_data_recording_contract=v1 event_data_source=browser ' +
    'event_data_env=ppdleads- event_data_agent_id=118 event_data_recording_id=rec-1 event_data_clock_offset_ms=22 ' +
    'app_name=ppd-leads-frontend user_id=118 session_id=OLD',
};

function setup(fetcher: LokiFetcher, enabled = true) {
  const journey = [event('session_extend', T)];
  return renderHook(
    (props: { journey: JourneyEvent[]; loadingJourney: boolean }) =>
      useInheritedRecording({
        lokiUid: 'loki',
        sessionId: 'NEW',
        range: { from: T - 60_000, to: T + 3600_000 },
        enabled,
        fetcher,
        ...props,
      }),
    { initialProps: { journey, loadingJourney: true } }
  );
}

describe('useInheritedRecording', () => {
  it('looks the recording up once the journey has loaded, and holds live until it knows', async () => {
    let answer: (lines: Awaited<ReturnType<LokiFetcher>>) => void = () => undefined;
    const fetcher = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>(
      () => new Promise((resolve) => (answer = resolve))
    );
    const { result, rerender } = setup(fetcher);
    expect(result.current.resolving).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ journey: [event('session_extend', T)], loadingJourney: false });
    expect(result.current.resolving).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toMatchObject({ fromMs: T - 60_000 - INHERIT_LOOKBACK_MS, direction: 'backward' });

    await act(async () => answer([startedLine]));
    expect(result.current.resolving).toBe(false);
    expect(audioSourcesOf(result.current.journey)).toEqual({ browser: { env: 'ppdleads-', agentId: 118 } });
  });

  it('drops what it inherited once the session announces the recording itself (live)', async () => {
    const fetcher = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>(async () => [startedLine]);
    const { result, rerender } = setup(fetcher);
    rerender({ journey: [event('session_extend', T)], loadingJourney: false });
    await waitFor(() => expect(result.current.journey).toHaveLength(2));

    const own = [
      event('session_extend', T),
      event('recording.started', T + 1000, {
        event_data_recording_contract: 'v1',
        event_data_source: 'browser',
        event_data_env: 'ppdleads-',
        event_data_agent_id: '118',
        event_data_recording_id: 'rec-1',
      }),
    ];
    rerender({ journey: own, loadingJourney: false });

    expect(result.current.journey).toBe(own);
  });

  it('plays without sound, as before, when the lookup fails', async () => {
    const fetcher = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>(async () => {
      throw new Error('loki down');
    });
    const { result, rerender } = setup(fetcher);
    rerender({ journey: [event('session_extend', T)], loadingJourney: false });

    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(audioSourcesOf(result.current.journey)).toEqual({ browser: undefined });
  });

  it('asks nothing when the recorder is not configured', () => {
    const fetcher = jest.fn<ReturnType<LokiFetcher>, Parameters<LokiFetcher>>(async () => []);
    const { result, rerender } = setup(fetcher, false);
    rerender({ journey: [event('session_extend', T)], loadingJourney: false });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.resolving).toBe(false);
  });
});
