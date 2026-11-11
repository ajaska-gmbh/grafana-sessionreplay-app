import { liveStartIndex } from './playerEvents';

const e = (type: number, timestamp: number) => ({ type, timestamp, data: {} }) as never;

describe('liveStartIndex', () => {
  it('starts at the meta event before the last full snapshot', () => {
    const events = [e(4, 1), e(2, 2), e(3, 3), e(4, 10), e(2, 11), e(3, 12)];

    expect(liveStartIndex(events)).toBe(3);
  });

  it('with sound, starts at the newest snapshot at or before where live starts', () => {
    const events = [e(4, 1), e(2, 2), e(3, 3), e(4, 10), e(2, 11), e(3, 12)];

    // A snapshot after the start would leave the stage blank until playback reaches it.
    expect(liveStartIndex(events, 8)).toBe(0);
    expect(liveStartIndex(events, 11)).toBe(3);
    // None at or before it: the first snapshot.
    expect(liveStartIndex(events, 0)).toBe(0);
    expect(liveStartIndex([e(3, 5), e(4, 6), e(2, 7)], 1)).toBe(1);
  });

  it('starts at the snapshot when no meta precedes it, and at 0 without snapshot', () => {
    expect(liveStartIndex([e(3, 1), e(2, 2), e(3, 3)])).toBe(1);
    expect(liveStartIndex([e(3, 1), e(3, 2)])).toBe(0);
  });
});
