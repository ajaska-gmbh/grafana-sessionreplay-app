jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn(), getAppEvents: () => ({ publish: jest.fn() }) }));

import { LIVE_SOUND_DELAY_MS, liveStartAt } from './SessionReplay';

describe('live with sound', () => {
  it("starts LIVE_SOUND_DELAY_MS before now, on the agent's computer's clock", () => {
    // The computer runs 2 s behind the server: its "now" is 2 s earlier.
    expect(liveStartAt(2000, 1_800_000_100_000)).toBe(1_800_000_100_000 - 2000 - LIVE_SOUND_DELAY_MS);
    expect(LIVE_SOUND_DELAY_MS).toBeGreaterThanOrEqual(12_000);
  });
});
