import { act, render } from '@testing-library/react';
import React from 'react';
import { PlayerClock, useClockEffect, useClockValue } from './playerClock';

describe('player clock', () => {
  it('tells its listeners only about real changes', () => {
    const clock = new PlayerClock();
    const listener = jest.fn();
    clock.subscribe(listener);

    clock.update({ offsetMs: 100 });
    clock.update({ offsetMs: 100 });
    clock.update({ playing: true, offsetMs: 100 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(clock.get()).toMatchObject({ offsetMs: 100, playing: true });
  });

  it('knows the wall clock at the playhead once the start is known', () => {
    const clock = new PlayerClock();
    expect(clock.wallMs()).toBeUndefined();
    clock.update({ startTimeMs: 1_000_000, offsetMs: 2500 });
    expect(clock.wallMs()).toBe(1_002_500);
  });

  it('re-renders a component only when what it selects changes', () => {
    const clock = new PlayerClock();
    const renders = jest.fn();
    function Second() {
      const second = useClockValue(clock, (s) => Math.floor(s.offsetMs / 1000));
      renders(second);
      return <span>{second}</span>;
    }
    const view = render(<Second />);

    // One update per animation frame, each rendered on its own.
    for (let ms = 0; ms <= 2000; ms += 16) {
      act(() => clock.update({ offsetMs: ms }));
    }

    expect(renders.mock.calls.map(([s]) => s)).toEqual([0, 1, 2]);
    expect(view.container.textContent).toBe('2');
  });

  it('follows every change without rendering, for DOM that tracks the playhead', () => {
    const clock = new PlayerClock();
    const seen: number[] = [];
    function Follower() {
      useClockEffect(clock, (s) => seen.push(s.offsetMs));
      return null;
    }
    render(<Follower />);

    act(() => {
      clock.update({ offsetMs: 10 });
      clock.update({ offsetMs: 20 });
    });

    expect(seen).toEqual([0, 10, 20]);
  });
});
