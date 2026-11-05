jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import type { JourneyEvent } from '../../lib/journey';
import { PlayerClock } from '../../lib/playerClock';
import { testIds } from '../testIds';
import { currentEventIndex, UserJourney } from './UserJourney';

function events(count: number): JourneyEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    timeMs: 1_000_000 + i * 1000,
    category: 'custom' as const,
    title: `event ${i}`,
    attributes: {},
  }));
}

describe('user journey', () => {
  // jsdom lays nothing out: give the list, and every row, a browser-like size.
  beforeEach(() => {
    // Each row measures 44 px.
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 44,
      top: 0,
      left: 0,
      bottom: 44,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  });

  afterEach(() => jest.restoreAllMocks());

  it('finds the event at the playhead as a linear scan would', () => {
    const list = events(50);
    for (const playhead of [undefined, 0, 999_999, 1_000_000, 1_000_500, 1_049_000, 2_000_000]) {
      const linear = playhead === undefined ? -1 : list.filter((e) => e.timeMs <= playhead).length - 1;
      expect(currentEventIndex(list, playhead)).toBe(linear);
    }
  });

  it('renders only the rows around the view, however long the session', async () => {
    render(<UserJourney events={events(5000)} recordingStartMs={1_000_000} tempoUid="tempo" onJump={jest.fn()} />);

    const rows = await screen.findAllByTestId(testIds.journey.row);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it('re-renders only when the playhead reaches another event', async () => {
    const clock = new PlayerClock();
    clock.update({ startTimeMs: 1_000_000 });
    const onJump = jest.fn();
    const view = render(
      <UserJourney events={events(20)} recordingStartMs={1_000_000} clock={clock} tempoUid="tempo" onJump={onJump} />
    );
    await screen.findAllByTestId(testIds.journey.row);
    const before = view.container.innerHTML;

    // Many frames within the same event: nothing changes.
    for (let ms = 0; ms < 900; ms += 16) {
      act(() => clock.update({ offsetMs: ms }));
    }
    expect(view.container.innerHTML).toBe(before);

    act(() => clock.update({ offsetMs: 2500 }));
    expect(view.container.innerHTML).not.toBe(before);
  });

  it("opens an event's details in place, in a long list too", async () => {
    const list = events(3000);
    list[1].attributes = { event_data_lead_id: 'uuid-55' };
    render(<UserJourney events={list} recordingStartMs={1_000_000} tempoUid="tempo" onJump={jest.fn()} />);
    await screen.findAllByTestId(testIds.journey.row);

    act(() => screen.getAllByLabelText('View event details')[1].click());

    expect(await screen.findByText('uuid-55')).toBeInTheDocument();
  });
});
