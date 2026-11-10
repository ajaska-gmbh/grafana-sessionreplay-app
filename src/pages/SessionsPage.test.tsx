jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ lokiUid: 'loki', tempoUid: 'tempo', searchFields: ['lead_id'], recorder: false }),
}));
const mockMatching = jest.fn();
jest.mock('../lib/sessionQueries', () => ({
  fetchAppNames: () => Promise.resolve([]),
  fetchSessions: () => Promise.resolve({ sessions: [], truncated: false }),
  fetchErrorCounts: () => Promise.resolve(new Map()),
  fetchActiveSessionIds: () => Promise.resolve(new Set()),
  fetchMatchingSessionIds: (...args: unknown[]) => {
    mockMatching(...args);
    return Promise.resolve(new Set<string>());
  },
}));

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { testIds } from '../components/testIds';
import SessionsPage from './SessionsPage';

const LEAD = 'cc90db97-dce5-11f1-8ef7-cab94425963e';

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <SessionsPage />
    </MemoryRouter>
  );
  return screen.getByTestId(testIds.sessions.search) as HTMLInputElement;
}

describe('sessions page search', () => {
  beforeEach(() => mockMatching.mockClear());

  it('looks a typed lead id up as typed, not regex-escaped', async () => {
    const input = renderAt('/sessions');
    fireEvent.change(input, { target: { value: LEAD } });

    expect(input.value).toBe(LEAD);
    await waitFor(() => expect(mockMatching).toHaveBeenCalled(), { timeout: 3000 });
    expect(mockMatching.mock.calls.at(-1)?.[2]).toBe(LEAD);
  });

  it('reads links holding the old escaping as the plain value', async () => {
    const input = renderAt(`/sessions?q=${encodeURIComponent(LEAD.replace(/-/g, '\\-'))}`);

    expect(input.value).toBe(LEAD);
    await waitFor(() => expect(mockMatching).toHaveBeenCalled(), { timeout: 3000 });
    expect(mockMatching.mock.calls.at(-1)?.[2]).toBe(LEAD);
  });
});
