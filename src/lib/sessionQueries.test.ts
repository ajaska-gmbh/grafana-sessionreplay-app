jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { of } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { fetchMatchingSessionIds } from './sessionQueries';

function seriesResponse(sessions: Array<[string, number]>) {
  return of({
    data: {
      results: {
        A: {
          frames: sessions.map(([sessionId, value]) => ({
            schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: { session_id: sessionId } }] },
            data: { values: [[0], [value]] },
          })),
        },
      },
    },
  });
}

describe('fetchMatchingSessionIds', () => {
  it('asks Loki for the sessions whose events carry the value, and returns them', async () => {
    const fetch = jest.fn(() =>
      seriesResponse([
        ['s1', 3],
        ['s2', 0],
        ['s3', 1],
      ])
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const ids = await fetchMatchingSessionIds('loki', ['lead_id', 'crm_lead_id'], '48211', [], 0, 3600_000);

    expect([...ids]).toEqual(['s1', 's3']);
    const query = (fetch.mock.calls[0] as unknown as [{ data: { queries: Array<{ expr: string }> } }])[0].data
      .queries[0];
    expect(query.expr).toContain('event_data_lead_id="48211" or event_data_crm_lead_id="48211"');
  });

  it('asks nothing without search fields', async () => {
    const fetch = jest.fn();
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    expect([...(await fetchMatchingSessionIds('loki', [], '48211', [], 0, 1))]).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
