jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { of } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { fetchSegmentAudio, listSessionAudio } from './recorderClient';

describe('recorder client', () => {
  it("lists the browser and every leg's carrier segments through the plugin route, by track", async () => {
    const fetch = jest.fn(({ url }: { url: string }) =>
      of({
        data: {
          segments: url.includes('browser/')
            ? [
                { key: 'b2', source: 'browser', track: 'mic', start_ms: 2000, duration_ms: 10000 },
                { key: 'b1', source: 'browser', track: 'mic', start_ms: 1000, duration_ms: 10000 },
              ]
            : [
                {
                  key: `c-${url}`,
                  source: 'carrier',
                  track: 'outbound',
                  start_ms: 1000,
                  duration_ms: 60000,
                  gaps: [{ start_ms: 5000, end_ms: 6000 }],
                },
              ],
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const audio = await listSessionAudio(
      { browser: { env: 'ppdtesting-', agentId: 7 }, clockOffsetMs: 0, legSids: ['CA1', 'CA2'] },
      0,
      3600_000
    );

    const urls = fetch.mock.calls.map(([request]) => request.url);
    expect(urls).toEqual([
      'api/plugin-proxy/ajaska-sessionreplay-app/recorder/v1/browser/segments?env=ppdtesting-&agent_id=7&from=0&to=3600000',
      'api/plugin-proxy/ajaska-sessionreplay-app/recorder/v1/carrier/segments?leg_sid=CA1&from=0&to=3600000',
      'api/plugin-proxy/ajaska-sessionreplay-app/recorder/v1/carrier/segments?leg_sid=CA2&from=0&to=3600000',
    ]);
    expect(audio.mic.map((s) => s.key)).toEqual(['b1', 'b2']);
    expect(audio.customer).toHaveLength(2);
    expect(audio.customer[0].gaps).toEqual([{ startMs: 5000, endMs: 6000 }]);
    expect(audio.agent).toEqual([]);
  });

  it("splits a long session into the recorder's 48-hour listings", async () => {
    const fetch = jest.fn(() => of({ data: { segments: [] } }));
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    await listSessionAudio({ clockOffsetMs: 0, legSids: ['CA1'] }, 0, 50 * 3600_000);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches a segment's audio as bytes", async () => {
    const bytes = new ArrayBuffer(4);
    const fetch = jest.fn(() => of({ data: bytes }));
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    expect(await fetchSegmentAudio('v1/carrier/CA1/inbound/1_2.opus')).toBe(bytes);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        responseType: 'arraybuffer',
        url: expect.stringContaining('audio?key=v1%2Fcarrier%2FCA1'),
      })
    );
  });
});
