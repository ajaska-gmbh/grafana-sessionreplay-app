jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ lokiUid: 'loki', tempoUid: 'tempo', searchFields: ['lead_id'], recorder: false }),
}));
const mockMatching = jest.fn();
const mockData = {
  sessions: [] as unknown[],
  frustration: new Map<string, number>(),
  outcomes: new Map<string, string>(),
};
jest.mock('../lib/sessionQueries', () => ({
  fetchAppNames: () => Promise.resolve([]),
  fetchSessions: () => Promise.resolve({ sessions: mockData.sessions, truncated: false }),
  fetchErrorCounts: () => Promise.resolve(new Map()),
  fetchFrustrationCounts: () => Promise.resolve(mockData.frustration),
  fetchOutcomes: () => Promise.resolve(mockData.outcomes),
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

describe('sessions page insights', () => {
  const session = (sessionId: string, mobile: boolean, startedMs: number) => ({
    sessionId,
    appName: 'lp-shop-storefront',
    environment: 'production',
    startedMs,
    lastStartedMs: startedMs,
    recordings: 1,
    browser: 'Safari 18',
    mobile,
  });

  beforeEach(() => {
    mockData.sessions = [
      session('phoneStuck', true, 3000),
      session('desktopBought', false, 2000),
      session('phoneLeft', true, 1000),
    ];
    mockData.frustration = new Map([['phoneStuck', 3]]);
    mockData.outcomes = new Map([
      ['phoneStuck', 'initiate_checkout'],
      ['desktopBought', 'purchase'],
    ]);
  });
  afterEach(() => {
    mockData.sessions = [];
    mockData.frustration = new Map();
    mockData.outcomes = new Map();
  });

  const ids = () =>
    [...document.querySelectorAll('code')].map((code) => code.textContent).filter((text) => text !== null);

  it('shows how far each visitor got, their frustration and device', async () => {
    renderAt('/sessions');
    expect(await screen.findByText('phoneStuck')).toBeInTheDocument();
    expect(screen.getByText('Checkout')).toBeInTheDocument();
    expect(screen.getByText('Purchase')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Phone or tablet')).toHaveLength(2);
  });

  it('filters by funnel step, problems and device from the link', async () => {
    renderAt('/sessions?outcome=initiate_checkout');
    await screen.findByText('phoneStuck');
    expect(ids()).toEqual(['phoneStuck']);
  });

  it('lists only sessions with problems when asked', async () => {
    renderAt('/sessions?problems=1');
    await screen.findByText('phoneStuck');
    expect(ids()).toEqual(['phoneStuck']);
    fireEvent.click(screen.getByLabelText('With problems only'));
    await waitFor(() => expect(ids()).toHaveLength(3));
  });

  it('lists one kind of device', async () => {
    renderAt('/sessions?device=desktop');
    await screen.findByText('desktopBought');
    expect(ids()).toEqual(['desktopBought']);
  });
});
