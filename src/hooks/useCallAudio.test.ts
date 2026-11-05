jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));
jest.mock('../lib/recorderClient', () => ({
  ...jest.requireActual('../lib/recorderClient'),
  listSessionAudio: jest.fn(),
}));

import { renderHook, waitFor } from '@testing-library/react';
import type { JourneyEvent } from '../lib/journey';
import { PlayerClock } from '../lib/playerClock';
import { listSessionAudio, noSegments } from '../lib/recorderClient';
import { useCallAudio } from './useCallAudio';

const started: JourneyEvent = {
  id: '1',
  timeMs: 0,
  category: 'custom',
  title: 'recording.started',
  attributes: {
    event_name: 'recording.started',
    event_data_recording_contract: 'v1',
    event_data_source: 'browser',
    event_data_env: 'ppdtesting-',
    event_data_agent_id: '7',
  },
};

describe('useCallAudio', () => {
  beforeEach(() =>
    jest
      .mocked(listSessionAudio)
      .mockReset()
      .mockResolvedValue({
        ...noSegments(),
        mic: [{ key: 'k', track: 'mic', startMs: 0, durationMs: 10_000, gaps: [] }],
      })
  );

  it("lists the session's audio where its recording events say it is", async () => {
    const { result } = renderHook(() =>
      useCallAudio({ journey: [started], range: { from: 0, to: 60_000 }, clock: new PlayerClock(), enabled: true })
    );

    await waitFor(() => expect(result.current.segments.mic).toHaveLength(1));
    expect(result.current.available).toBe(true);
    expect(listSessionAudio).toHaveBeenCalledWith(
      { browser: { env: 'ppdtesting-', agentId: 7 }, legSids: [] },
      0,
      60_000
    );
  });

  it('asks the recorder nothing for a session of another app, or without the recorder configured', () => {
    const other = renderHook(() =>
      useCallAudio({ journey: [], range: { from: 0, to: 1 }, clock: new PlayerClock(), enabled: true })
    );
    const unconfigured = renderHook(() =>
      useCallAudio({ journey: [started], range: { from: 0, to: 1 }, clock: new PlayerClock(), enabled: false })
    );

    expect(other.result.current.available).toBe(false);
    expect(unconfigured.result.current.available).toBe(false);
    expect(listSessionAudio).not.toHaveBeenCalled();
  });

  it('plays the conversation by default, and lets a track be muted', async () => {
    const { result } = renderHook(() =>
      useCallAudio({ journey: [started], range: { from: 0, to: 60_000 }, clock: new PlayerClock(), enabled: true })
    );
    expect([...result.current.audible].sort()).toEqual(['customer', 'mic']);

    result.current.toggle('mic');

    await waitFor(() => expect([...result.current.audible]).toEqual(['customer']));
  });
});
