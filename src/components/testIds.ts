export const testIds = {
  appConfig: {
    lokiUid: 'data-testid ac-loki-uid',
    tempoUid: 'data-testid ac-tempo-uid',
    submit: 'data-testid ac-submit-form',
  },
  sessions: {
    container: 'data-testid sessions-container',
    search: 'data-testid sessions-search',
    row: 'data-testid sessions-row',
  },
  replay: {
    container: 'data-testid replay-container',
  },
  player: {
    container: 'data-testid player-container',
    timeline: 'data-testid player-timeline',
    clock: 'data-testid player-clock',
    play: 'data-testid player-play',
    wallClock: 'data-testid player-wall-clock',
    goTo: 'data-testid player-go-to',
    waiting: 'data-testid player-waiting',
    unloaded: 'data-testid player-unloaded',
    audioLevels: 'data-testid player-audio-levels',
    audioAgent: 'data-testid player-audio-agent',
    audioCustomer: 'data-testid player-audio-customer',
    audioPlayhead: 'data-testid player-audio-playhead',
    callAudio: 'data-testid player-call-audio',
    callAudioRow: (track: string) => `data-testid player-call-audio-${track}`,
  },
  journey: {
    container: 'data-testid journey-container',
    row: 'data-testid journey-row',
  },
};
