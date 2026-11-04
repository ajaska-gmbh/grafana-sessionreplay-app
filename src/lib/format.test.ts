jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { formatWallClock, wallClockOffset } from './format';

// The tests run in UTC (jest.config.js), so local time is UTC here.
const START = Date.UTC(2026, 10, 4, 12, 33, 40, 500);
const TEN_MINUTES = 10 * 60 * 1000;

describe('wall-clock time', () => {
  it('formats a time of day to the second', () => {
    expect(formatWallClock(START)).toBe('12:33:40');
    expect(formatWallClock(Date.UTC(2026, 10, 4, 3, 4, 5))).toBe('03:04:05');
  });

  it('finds a typed time of day in the recording', () => {
    expect(wallClockOffset('12:35', START, TEN_MINUTES)).toBe(79_500);
    expect(wallClockOffset('12:35:10', START, TEN_MINUTES)).toBe(89_500);
    expect(wallClockOffset(' 12.35.10 ', START, TEN_MINUTES)).toBe(89_500);
    // Typed to the second, the recording's first second counts as its start.
    expect(wallClockOffset('12:33:40', START, TEN_MINUTES)).toBe(0);
  });

  it('works across midnight', () => {
    const late = Date.UTC(2026, 10, 4, 23, 58, 0);

    expect(wallClockOffset('00:01', late, TEN_MINUTES)).toBe(3 * 60 * 1000);
  });

  it('refuses what is no time or not in the recording', () => {
    expect(wallClockOffset('12:20', START, TEN_MINUTES)).toBeUndefined();
    expect(wallClockOffset('12:44', START, TEN_MINUTES)).toBeUndefined();
    expect(wallClockOffset('25:00', START, TEN_MINUTES)).toBeUndefined();
    expect(wallClockOffset('12:61', START, TEN_MINUTES)).toBeUndefined();
    expect(wallClockOffset('noon', START, TEN_MINUTES)).toBeUndefined();
    expect(wallClockOffset('', START, TEN_MINUTES)).toBeUndefined();
  });
});
