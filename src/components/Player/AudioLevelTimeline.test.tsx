jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AudioLevelSegment } from '../../lib/audioLevels';
import { testIds } from '../testIds';
import { AudioLevelTimeline, channelPaths, describeSegment } from './AudioLevelTimeline';

function segment(startOffsetMs: number, patch: Partial<AudioLevelSegment> = {}): AudioLevelSegment {
  return {
    startMs: startOffsetMs,
    endMs: startOffsetMs + 1000,
    startOffsetMs,
    endOffsetMs: startOffsetMs + 1000,
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

    // 0..1000 ms of 10 s is 0..100 of the 1000 units; avg 0.2 of a 28-unit row.
    expect(agent.avg).toBe('M0.00,28V22.40H100.00V28Z');
    expect(agent.idleAvg).toBe('M100.00,28V22.40H200.00V28Z');
    expect(customer.avg).toBe('M0.00,28V25.20H100.00V28Z');
    expect(customer.idleAvg).toBe('');
  });

  it('marks silence per channel, windows without data, and a background tab', () => {
    const segments = [
      segment(0, { agentAvg: 0.001, customerAvg: 0.3 }),
      segment(1000, { samples: 0, agentAvg: undefined, customerAvg: undefined }),
      segment(2000, { hiddenRatio: 0.5 }),
    ];

    const agent = channelPaths(segments, 'agent', 10_000);
    const customer = channelPaths(segments, 'customer', 10_000);

    expect(agent.silent).toBe('M0.00,29H100.00v3H0.00Z');
    expect(customer.silent).toBe('');
    expect(agent.noData).toBe('M100.00,29H200.00v3H100.00Z');
    expect(agent.hidden).toBe('M200.00,0H300.00V28H200.00Z');
  });

  it('describes a window for the hover readout', () => {
    expect(describeSegment(segment(0, { hiddenRatio: 0.25 }))).toBe(
      'in call · agent mic 0.200 (max 0.400) · customer audio 0.100 (max 0.300) · tab hidden 25%'
    );
    expect(describeSegment(segment(0, { phase: 'idle' }))).toBe('between calls · agent mic 0.200 (max 0.400)');
    expect(describeSegment(segment(0, { samples: 0 }))).toBe('in call · no level data');
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
    render(<AudioLevelTimeline segments={[segment(0), segment(5000)]} totalMs={10_000} offsetMs={0} onSeek={onSeek} />);

    const agent = screen.getByTestId(testIds.player.audioAgent);
    expect(screen.getByTestId(testIds.player.audioCustomer)).toBeInTheDocument();
    svgBox(agent);
    fireEvent.click(agent, { clientX: 250 });

    expect(onSeek).toHaveBeenCalledWith(5000);
  });

  it('reads out the window under the pointer', () => {
    render(<AudioLevelTimeline segments={[segment(5000)]} totalMs={10_000} offsetMs={0} onSeek={jest.fn()} />);
    const agent = screen.getByTestId(testIds.player.audioAgent);
    svgBox(agent);

    fireEvent.mouseMove(agent, { clientX: 260 });

    expect(screen.getByText(/0:05 · in call · agent mic 0.200/)).toBeInTheDocument();
  });

  it('has no customer row between calls only, and nothing at all without levels', () => {
    const { rerender } = render(
      <AudioLevelTimeline segments={[segment(0, { phase: 'idle' })]} totalMs={10_000} offsetMs={0} onSeek={jest.fn()} />
    );
    expect(screen.getByTestId(testIds.player.audioAgent)).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.player.audioCustomer)).toBeNull();

    rerender(<AudioLevelTimeline segments={[]} totalMs={10_000} offsetMs={0} onSeek={jest.fn()} />);
    expect(screen.queryByTestId(testIds.player.audioLevels)).toBeNull();
  });
});
