jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { JourneyEvent } from '../../lib/journey';
import { sessionInsights } from '../../lib/insights';
import { PlayerClock } from '../../lib/playerClock';
import { testIds } from '../testIds';
import { LEAD_MS } from './InsightsPanel';
import { UserJourney } from './UserJourney';

const START = 1_000_000;
const ev = (
  id: string,
  offset: number,
  extra: Partial<JourneyEvent> & { name?: string; attrs?: Record<string, string> }
) =>
  ({
    id,
    timeMs: START + offset,
    category: extra.category ?? 'custom',
    title: extra.title ?? id,
    detail: extra.detail,
    attributes: {
      event_name: extra.name ?? '',
      session_attr_insights: '1',
      session_attr_steps: 'page_view,add_to_cart,initiate_checkout',
      browser_mobile: 'true',
      ...extra.attrs,
    },
  }) as JourneyEvent;

const journey: JourneyEvent[] = [
  ev('dead', 2000, {
    category: 'frustration',
    name: 'dead_click',
    title: 'Dead tap on “Buy now” (button)',
    detail: 'Looks clickable',
    attrs: { event_data_interactive: '1' },
  }),
  ev('form', 5000, { category: 'frustration', name: 'form_invalid', title: 'Form error: Email' }),
  ev('exit', 9000, { category: 'navigation', name: 'page_exit', title: 'Left /checkout' }),
  ev('view', 100, { category: 'navigation', name: 'session_start', title: 'session_start' }),
];

describe('Insights tab', () => {
  beforeEach(() => {
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  });
  afterEach(() => jest.restoreAllMocks());

  it('opens on the problems with the funnel, jumps just before a moment and filters by kind', () => {
    const onJump = jest.fn();
    const clock = new PlayerClock();
    render(
      <UserJourney
        events={journey}
        insights={sessionInsights(journey)}
        recordingStartMs={START}
        clock={clock}
        tempoUid="tempo"
        onJump={onJump}
      />
    );

    const panel = screen.getByTestId(testIds.insights.container);
    expect(screen.getAllByTestId(testIds.insights.step).map((step) => step.textContent)).toEqual([
      'Viewed',
      'Added to cart',
      'Checkout',
      'Payment info',
      'Purchase',
    ]);
    expect(within(panel).getByText('Phone or tablet')).toBeInTheDocument();
    const rows = screen.getAllByTestId(testIds.insights.row);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Dead tap on “Buy now” (button)'),
      expect.stringContaining('Form error: Email'),
      expect.stringContaining('Left /checkout'),
    ]);
    expect(rows[0]).toHaveTextContent('0:02.000');

    fireEvent.click(within(rows[0]).getByText('Dead tap on “Buy now” (button)'));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: 'dead', timeMs: START + 2000 - LEAD_MS }));
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Watch this moment' }));
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'form' }));

    // The playhead past the first problem marks it.
    act(() => clock.update({ startTimeMs: START, offsetMs: 3000 }));
    expect(screen.getAllByTestId(testIds.insights.row)[1].className).not.toBe(
      screen.getAllByTestId(testIds.insights.row)[0].className
    );

    const [deadChip] = screen.getAllByTestId(testIds.insights.chip);
    expect(deadChip).toHaveTextContent('Dead taps1');
    fireEvent.click(deadChip);
    expect(deadChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId(testIds.insights.row)).toHaveLength(1);
    fireEvent.click(deadChip);
    expect(screen.getAllByTestId(testIds.insights.row)).toHaveLength(3);

    // The journey is a tab away, with the frustration filter.
    fireEvent.click(screen.getByText('Journey'));
    expect(screen.queryByTestId(testIds.insights.container)).not.toBeInTheDocument();
    expect(screen.getByText('Frustration')).toBeInTheDocument();
  });

  it('opens on the journey when nothing went wrong, and says so in the Insights tab', () => {
    const quiet = [journey[3]];
    render(<UserJourney events={quiet} insights={sessionInsights(quiet)} tempoUid="tempo" onJump={jest.fn()} />);
    expect(screen.queryByTestId(testIds.insights.container)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Insights'));
    expect(screen.getByText(/No problems found/)).toBeInTheDocument();
    expect(screen.getAllByTestId(testIds.insights.step).length).toBeGreaterThan(0);
  });

  it('says when taps were found in the recording, and shows a blocked pay press in the funnel', () => {
    const recorded = ev('rec', 1000, {
      category: 'frustration',
      name: 'dead_click',
      title: 'Dead click on “x”',
      attrs: { source: 'recording', session_attr_insights: '', browser_mobile: 'false', session_attr_steps: '' },
    });
    const blocked = ev('blocked', 3000, {
      name: 'checkout_blocked',
      attrs: { session_attr_insights: '', browser_mobile: 'false', session_attr_steps: '' },
    });
    render(
      <UserJourney
        events={[blocked]}
        insights={sessionInsights([blocked], [recorded])}
        tempoUid="tempo"
        onJump={jest.fn()}
      />
    );
    expect(screen.getByText('Desktop')).toBeInTheDocument();
    expect(screen.getByText('taps from the recording')).toBeInTheDocument();
    expect(
      screen.getByText('Pay blocked', { selector: '[data-testid="data-testid insights-step"]' })
    ).toBeInTheDocument();
    // No time without a recording start.
    expect(screen.getAllByTestId(testIds.insights.row)[0]).toHaveTextContent(/^Dead click/);
  });
});
