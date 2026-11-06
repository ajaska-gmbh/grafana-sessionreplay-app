jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CallAudio } from '../../hooks/useCallAudio';
import { PlayerClock } from '../../lib/playerClock';
import { noSegments } from '../../lib/recorderClient';
import { testIds } from '../testIds';
import { CallAudioTimeline } from './CallAudioTimeline';

function audio(patch: Partial<CallAudio> = {}): CallAudio {
  return {
    available: true,
    loading: false,
    segments: noSegments(),
    micMissing: [],
    connectionLost: [],
    audible: new Set(['mic', 'heard']),
    toggle: jest.fn(),
    volume: 1,
    setVolume: jest.fn(),
    stereo: false,
    setStereo: jest.fn(),
    ...patch,
  };
}

function clockAt(startTimeMs: number, totalMs: number) {
  const clock = new PlayerClock();
  clock.update({ startTimeMs, totalMs });
  return clock;
}

const seg = (track: 'mic' | 'heard', startMs: number, durationMs: number) => ({
  key: `${track}${startMs}`,
  track,
  startMs,
  durationMs,
});

describe('call audio timeline', () => {
  it('shows a row for each track that has audio, and toggles listening', () => {
    const segments = { ...noSegments(), mic: [seg('mic', 1000, 10_000)] };
    const callAudio = audio({ segments });
    render(<CallAudioTimeline audio={callAudio} clock={clockAt(1000, 60_000)} onSeek={jest.fn()} />);

    expect(screen.getByTestId(testIds.player.callAudioRow('mic'))).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.player.callAudioRow('heard'))).toBeNull();

    fireEvent.click(screen.getByLabelText('Mute Agent mic'));
    expect(callAudio.toggle).toHaveBeenCalledWith('mic');
  });

  it("marks where the agent's microphone was not recorded", () => {
    const segments = { ...noSegments(), mic: [seg('mic', 0, 4000)], heard: [seg('heard', 0, 10_000)] };
    render(
      <CallAudioTimeline
        audio={audio({ segments, micMissing: [{ startMs: 4000, endMs: 9000 }] })}
        clock={clockAt(0, 10_000)}
        onSeek={jest.fn()}
      />
    );

    const notRecorded = screen.getByTitle(/microphone was not recorded/);
    expect(notRecorded).toHaveStyle({ left: '40%', width: '50%' });
    expect(screen.getByTestId(testIds.player.callAudioRow('heard'))).toBeInTheDocument();
  });

  it('jumps where a row is clicked', () => {
    const onSeek = jest.fn();
    render(
      <CallAudioTimeline
        audio={audio({ segments: { ...noSegments(), mic: [seg('mic', 0, 10_000)] } })}
        clock={clockAt(0, 10_000)}
        onSeek={onSeek}
      />
    );
    const strip = screen.getByTestId(testIds.player.callAudioRow('mic')).lastElementChild as HTMLElement;
    jest.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 200 } as DOMRect);

    fireEvent.click(strip, { clientX: 50 });

    expect(onSeek).toHaveBeenCalledWith(2500);
  });
});
