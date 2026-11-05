jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PlayerClock } from '../../lib/playerClock';
import type { AudioLevelSegment } from '../../lib/audioLevels';
import { testIds } from '../testIds';
import { AudioLevelTimeline, channelPaths, COLUMNS, describeSegment } from './AudioLevelTimeline';

/** A bar path back as [from, to, height] in timeline ms and level, merging adjacent equal columns. */
function bars(path: string, totalMs = 10_000): Array<[number, number, number]> {
  const unitMs = totalMs / 1000;
  const result: Array<[number, number, number]> = [];
  for (const [, x1, top, x2] of path.matchAll(/M([\d.]+),28V([\d.]+)H([\d.]+)V28Z/g)) {
    const from = Math.round(Number(x1) * unitMs);
    const to = Math.round(Number(x2) * unitMs);
    const level = Math.round(((28 - Number(top)) / 28) * 1000) / 1000;
    const last = result[result.length - 1];
    if (last && last[1] === from && last[2] === level) {
      last[1] = to;
    } else {
      result.push([from, to, level]);
    }
  }
  return result;
}

function segment(startOffsetMs: number, patch: Partial<AudioLevelSegment> = {}): AudioLevelSegment {
  return {
    startMs: startOffsetMs,
    endMs: startOffsetMs + 1000,
    startOffsetMs,
    endOffsetMs: startOffsetMs + 1000,
    rawStartOffsetMs: startOffsetMs,
    rawEndOffsetMs: startOffsetMs + 1000,
    phase: 'call',
    samples: 20,
    agentAvg: 0.2,
    agentMax: 0.4,
    customerAvg: 0.1,
    customerMax: 0.3,
    ...patch,
  };
}

describe('audio level paths', () => {
  it('draws calls and idle time apart, and only calls for the customer', () => {
    // The idle window even carries customer values: they must not be drawn.
    const segments = [segment(0), segment(1000, { phase: 'idle' })];

    const agent = channelPaths(segments, 'agent', 10_000);
    const customer = channelPaths(segments, 'customer', 10_000);

    expect(bars(agent.avg)).toEqual([[0, 1000, 0.2]]);
    expect(bars(agent.max)).toEqual([[0, 1000, 0.4]]);
    expect(bars(agent.idleAvg)).toEqual([[1000, 2000, 0.2]]);
    expect(bars(customer.avg)).toEqual([[0, 1000, 0.1]]);
    expect(customer.idleAvg).toBe('');
  });

  it('draws waiting with the line open in the agent row only, apart from calls with a customer', () => {
    // A waiting window even carries "customer" values: the empty conference, not a customer.
    const segments = [segment(0), segment(1000, { phase: 'waiting' })];

    const agent = channelPaths(segments, 'agent', 10_000);
    const customer = channelPaths(segments, 'customer', 10_000);

    expect(bars(agent.avg)).toEqual([[0, 1000, 0.2]]);
    expect(bars(agent.waitAvg)).toEqual([[1000, 2000, 0.2]]);
    expect(bars(customer.avg)).toEqual([[0, 1000, 0.1]]);
    expect(customer.waitAvg).toBe('');
  });

  it('places each 50 ms reading on its own where the window carries them', () => {
    const readings = [0.1, 0.5, 0, 0.3];
    const segments = [segment(0, { agentLevels: readings, customerLevels: [0.2, 0.2, 0.2, 0.2] })];

    const agent = channelPaths(segments, 'agent', 10_000);

    // Four readings over 1 s: 250 ms each. A silent one draws nothing.
    expect(bars(agent.avg)).toEqual([
      [0, 250, 0.1],
      [250, 500, 0.5],
      [750, 1000, 0.3],
    ]);
    expect(bars(channelPaths(segments, 'customer', 10_000).avg)).toEqual([[0, 1000, 0.2]]);
  });

  it('pools readings of long sessions into a bounded number of columns: average and peak', () => {
    const hourMs = 3_600_000;
    const segments = Array.from({ length: 3600 }, (_, second) =>
      segment(second * 1000, { agentLevels: Array.from({ length: 20 }, (__, i) => (i === 0 ? 0.9 : 0.1)) })
    );

    const agent = channelPaths(segments, 'agent', hourMs);

    expect(agent.avg.match(/M/g)).toHaveLength(COLUMNS);
    // 1.8 s per column: the peak keeps the 0.9 readings, the average mixes them in.
    expect(bars(agent.max, hourMs)[0][2]).toBe(0.9);
    expect(bars(agent.avg, hourMs)[0][2]).toBeCloseTo(0.14, 1);
  });

  it('leaves out the readings of a window clipped at the recording start', () => {
    const segments = [
      {
        ...segment(0, { agentLevels: [0.9, 0.9, 0.2, 0.2] }),
        rawStartOffsetMs: -500,
        rawEndOffsetMs: 500,
        endOffsetMs: 500,
      },
    ];

    expect(bars(channelPaths(segments, 'agent', 10_000).avg)).toEqual([[0, 500, 0.2]]);
  });

  it('marks silence per channel, windows without data, and a background tab', () => {
    const segments = [
      segment(0, { agentAvg: 0.001, customerAvg: 0.3 }),
      segment(1000, { samples: 0, agentAvg: undefined, customerAvg: undefined }),
      segment(2000, { hiddenRatio: 0.5 }),
    ];

    const agent = channelPaths(segments, 'agent', 10_000);
    const customer = channelPaths(segments, 'customer', 10_000);

    expect(agent.silent).toBe('M0.00,29H100.00v4H0.00Z');
    expect(customer.silent).toBe('');
    expect(agent.noData).toBe('M100.00,29H200.00v4H100.00Z');
    expect(agent.hidden).toBe('M200.00,0H300.00V28H200.00Z');
  });

  it('describes a window for the hover readout', () => {
    expect(describeSegment(segment(0, { hiddenRatio: 0.25 }))).toBe(
      'customer on the line · agent mic 0.200 (max 0.400) · customer audio 0.100 (max 0.300) · tab hidden 25%'
    );
    expect(describeSegment(segment(0, { phase: 'idle' }))).toBe('between calls · agent mic 0.200 (max 0.400)');
    expect(describeSegment(segment(0, { samples: 0 }))).toBe('customer on the line · no level data');
    expect(describeSegment(segment(0, { agentLevels: [0.1, 0.5], customerLevels: [0, 0.07] }), 600)).toBe(
      'customer on the line · agent mic 0.200 (max 0.400, here 0.500) · customer audio 0.100 (max 0.300, here 0.070)'
    );
  });
});

describe('AudioLevelTimeline', () => {
  function svgBox(element: Element) {
    jest
      .spyOn(element, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 500, top: 0, height: 32 } as DOMRect);
  }

  it('shows the agent and the customer on separate rows, and jumps where clicked', () => {
    const onSeek = jest.fn();
    render(
      <AudioLevelTimeline
        segments={[segment(0), segment(5000)]}
        totalMs={10_000}
        clock={new PlayerClock()}
        onSeek={onSeek}
      />
    );

    const agent = screen.getByTestId(testIds.player.audioAgent);
    expect(screen.getByTestId(testIds.player.audioCustomer)).toBeInTheDocument();
    svgBox(agent);
    fireEvent.click(agent, { clientX: 250 });

    expect(onSeek).toHaveBeenCalledWith(5000);
  });

  it('moves the playhead as an overlay with the clock, without redrawing the rows', () => {
    const segments = [segment(0), segment(5000)];
    const clock = new PlayerClock();
    render(<AudioLevelTimeline segments={segments} totalMs={10_000} clock={clock} onSeek={jest.fn()} />);
    const agentPath = screen.getByTestId(testIds.player.audioAgent).querySelector('path:nth-of-type(3)');

    act(() => clock.update({ offsetMs: 2500 }));

    expect(screen.getByTestId(testIds.player.audioPlayhead)).toHaveStyle({ left: '25%' });
    expect(screen.getByTestId(testIds.player.audioAgent).querySelector('line')).toBeNull();
    // Same element, same shape: the row was not rebuilt.
    expect(screen.getByTestId(testIds.player.audioAgent).querySelector('path:nth-of-type(3)')).toBe(agentPath);
  });

  it('reads out the window under the pointer', () => {
    render(
      <AudioLevelTimeline segments={[segment(5000)]} totalMs={10_000} clock={new PlayerClock()} onSeek={jest.fn()} />
    );
    const agent = screen.getByTestId(testIds.player.audioAgent);
    svgBox(agent);

    fireEvent.mouseMove(agent, { clientX: 260 });

    expect(screen.getByText(/0:05 · customer on the line · agent mic 0.200/)).toBeInTheDocument();
  });

  it('has no customer row when no customer was on the line, and says so', () => {
    render(
      <AudioLevelTimeline
        segments={[segment(0, { phase: 'waiting' }), segment(1000, { phase: 'idle' })]}
        totalMs={10_000}
        clock={new PlayerClock()}
        onSeek={jest.fn()}
      />
    );

    expect(screen.getByTestId(testIds.player.audioAgent)).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.player.audioCustomer)).toBeNull();
    expect(screen.getByText(/no customer on the line in this recording/)).toBeInTheDocument();
  });

  it('names each row in its own header', () => {
    render(
      <AudioLevelTimeline segments={[segment(0)]} totalMs={10_000} clock={new PlayerClock()} onSeek={jest.fn()} />
    );

    expect(screen.getByText('Agent mic')).toBeInTheDocument();
    expect(screen.getByText('Customer')).toBeInTheDocument();
    expect(screen.getByText(/while a customer is on the line/)).toBeInTheDocument();
  });

  it('reads out the time of day under the pointer, with the offset', () => {
    // 12:33:40 UTC; the tests run in UTC (jest.config.js).
    const startTimeMs = Date.UTC(2026, 10, 4, 12, 33, 40);
    render(
      <AudioLevelTimeline
        segments={[segment(5000)]}
        totalMs={10_000}
        clock={new PlayerClock()}
        startTimeMs={startTimeMs}
        onSeek={jest.fn()}
      />
    );
    const agent = screen.getByTestId(testIds.player.audioAgent);
    svgBox(agent);

    fireEvent.mouseMove(agent, { clientX: 260 });

    expect(screen.getByText(/^12:33:45 \(0:05\) · customer on the line/)).toBeInTheDocument();
  });

  it('has no customer row between calls only, and nothing at all without levels', () => {
    const { rerender } = render(
      <AudioLevelTimeline
        segments={[segment(0, { phase: 'idle' })]}
        totalMs={10_000}
        clock={new PlayerClock()}
        onSeek={jest.fn()}
      />
    );
    expect(screen.getByTestId(testIds.player.audioAgent)).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.player.audioCustomer)).toBeNull();

    rerender(<AudioLevelTimeline segments={[]} totalMs={10_000} clock={new PlayerClock()} onSeek={jest.fn()} />);
    expect(screen.queryByTestId(testIds.player.audioLevels)).toBeNull();
  });
});
