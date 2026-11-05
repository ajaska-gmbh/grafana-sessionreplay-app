jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { of } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { fetchSegmentAudio, listSessionAudio } from './recorderClient';

describe('recorder client', () => {
  it("lists the agent's browser segments through the plugin route, by track, sorted", async () => {
    const fetch = jest.fn(() =>
      of({
        data: {
          segments: [
            { key: 'b2', source: 'browser', track: 'mic', start_ms: 2000, duration_ms: 10000 },
            { key: 'b1', source: 'browser', track: 'mic', start_ms: 1000, duration_ms: 10000 },
            { key: 'h1', source: 'browser', track: 'heard', start_ms: 1000, duration_ms: 10000 },
            { key: 'x', source: 'carrier', track: 'outbound', start_ms: 1000, duration_ms: 60000 },
          ],
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const audio = await listSessionAudio({ browser: { env: 'ppdtesting-', agentId: 7 } }, 0, 3600_000);

    expect(fetch.mock.calls.map(([request]: any) => request.url)).toEqual([
      'api/plugin-proxy/ajaska-sessionreplay-app/recorder/v1/browser/segments?env=ppdtesting-&agent_id=7&from=0&to=3600000',
    ]);
    expect(audio.mic.map((s) => s.key)).toEqual(['b1', 'b2']);
    expect(audio.heard.map((s) => s.key)).toEqual(['h1']);
    expect(Object.keys(audio).sort()).toEqual(['heard', 'mic']);
  });

  it('asks for nothing without a browser recording', async () => {
    const fetch = jest.fn(() => of({ data: { segments: [] } }));
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    expect(await listSessionAudio({}, 0, 3600_000)).toEqual({ mic: [], heard: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("splits a long session into the recorder's 48-hour listings", async () => {
    const fetch = jest.fn(() => of({ data: { segments: [] } }));
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    await listSessionAudio({ browser: { env: 'e', agentId: 7 } }, 0, 50 * 3600_000);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches a segment's audio as bytes", async () => {
    const bytes = new ArrayBuffer(4);
    const fetch = jest.fn(() => of({ data: bytes }));
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    expect(await fetchSegmentAudio('v1/browser/e/7/2025-11-05/mic/1_2_leg_r_0.opus')).toBe(bytes);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        responseType: 'arraybuffer',
        url: expect.stringContaining('audio?key=v1%2Fbrowser%2Fe%2F7'),
      })
    );
  });
});
