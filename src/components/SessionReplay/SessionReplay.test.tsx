jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn(), getAppEvents: () => ({ publish: jest.fn() }) }));

/** Props the player got, last render last. */
const mockPlayerProps: Array<Record<string, unknown>> = [];
const mockData: { current: Record<string, unknown> } = { current: {} };

jest.mock('../Player/ReplayPlayer', () => ({
  ReplayPlayer: (props: Record<string, unknown>) => {
    mockPlayerProps.push(props);
    return null;
  },
}));
jest.mock('../Journey/UserJourney', () => ({ UserJourney: () => null }));
jest.mock('../../hooks/useCallAudio', () => ({ useCallAudio: () => ({ available: false }) }));
jest.mock('../../hooks/useSessionData', () => ({ useSessionData: () => mockData.current }));

import React from 'react';
import { render, screen } from '@testing-library/react';
import { indexFromLines, linesOf } from '../../lib/fixtures';
import type { JourneyEvent } from '../../lib/journey';
import { ReplayTimeline } from '../../lib/replayEvents';
import { SessionReplay } from './SessionReplay';

const MIN = 60_000;
const START = 1_800_000_000_000;
type Event = Record<string, unknown> & { timestamp: number };
const meta = (timestamp: number) => ({ type: 4, timestamp, data: { href: 'https://x/', width: 1, height: 1 } });

/** Index only: two tabs, nothing loaded. Tab A checks out every 5 minutes for 30 minutes. */
const lines = linesOf([
  ...Array.from({ length: 6 }, (_, gen) => ({ event: meta(START + gen * 5 * MIN) as Event, gen, recordingId: 'tabA' })),
  { event: meta(START + 29 * MIN) as Event, gen: 5, recordingId: 'tabA' },
  { event: meta(START + 2 * MIN) as Event, recordingId: 'tabB' },
  { event: meta(START + 3 * MIN) as Event, recordingId: 'tabB' },
]);
const tracks = new ReplayTimeline(indexFromLines(lines)).tracks;

const journeyEvent = (
  id: string,
  timeMs: number,
  category: JourneyEvent['category'],
  attributes = {}
): JourneyEvent => ({
  id,
  timeMs,
  category,
  title: id,
  attributes,
});
const lastProps = () => mockPlayerProps[mockPlayerProps.length - 1];
const focus = jest.fn();

function data(patch: Record<string, unknown> = {}) {
  mockData.current = {
    tracks,
    journey: [],
    audioLevels: [],
    loadingReplay: false,
    loadingChunks: true,
    loadingJourney: false,
    loadingAudioLevels: false,
    skippedEvents: 0,
    unresolvedStylesheets: 0,
    droppedStylesheets: 0,
    notFound: false,
    range: { from: START - 10 * MIN, to: START + 60 * MIN },
    focus,
    ...patch,
  };
}

const props = { appName: 'app', sessionId: 's1', lokiUid: 'loki', tempoUid: 'tempo' };

describe('SessionReplay with nothing loaded but the index', () => {
  beforeEach(() => {
    mockPlayerProps.length = 0;
    focus.mockClear();
  });

  it('starts at a share link offset counted from where the link range started', () => {
    data();
    // The link's range started after the checkout at 10 min: its t counts from 15 min.
    render(<SessionReplay {...props} from={START + 12 * MIN} to={START + 60 * MIN} t={30_000} />);

    expect(lastProps().initialOffsetMs).toBe(15 * MIN + 30_000);
    expect((lastProps().track as { key: string }).key).toBe('tabA');
  });

  it('places journey markers and the first search match on the track axis', () => {
    data({
      journey: [
        journeyEvent('err', START + 7 * MIN, 'error'),
        journeyEvent('lead', START + 21 * MIN, 'custom', { event_data_lead_id: '42' }),
      ],
    });
    render(<SessionReplay {...props} highlight="42" searchFields={['lead_id']} />);

    expect(lastProps().markers).toEqual([{ offsetMs: 7 * MIN, kind: 'error', title: 'err' }]);
    expect(lastProps().seekRequest).toEqual({ offsetMs: 21 * MIN, nonce: 1 });
  });

  it('plays the tab from the link, offers the other tabs, and loads where the player asks', () => {
    data();
    render(<SessionReplay {...props} track={1} t={5000} />);

    expect(screen.getByText(/open in 2 tabs/)).toBeInTheDocument();
    expect((lastProps().track as { key: string }).key).toBe('tabB');
    expect(lastProps().initialOffsetMs).toBe(5000);

    (lastProps().onTarget as (offsetMs: number) => void)(60_000);
    expect(focus).toHaveBeenCalledWith(1, 60_000, false);
  });

  it('shares a link to the moment with the tab and the loaded range', async () => {
    data();
    const writeText = jest.fn(async (_text: string) => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<SessionReplay {...props} track={1} />);

    await (lastProps().onShare as (offsetMs: number) => Promise<void>)(90_000);

    const link = new URL(writeText.mock.calls[0][0]);
    expect(Object.fromEntries(link.searchParams)).toEqual({
      t: '90000',
      track: '1',
      from: String(START - 10 * MIN),
      to: String(START + 60 * MIN),
    });
  });

  it('says there is nothing to replay when the index finds no recording', () => {
    data({ tracks: [] });
    render(<SessionReplay {...props} />);

    expect(screen.getByText('Nothing to replay')).toBeInTheDocument();
  });
});
