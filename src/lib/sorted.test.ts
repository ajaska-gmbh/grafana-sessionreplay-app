import { mergeSorted } from './sorted';

describe('mergeSorted', () => {
  it('gives what sorting both together gives, keeping equal items stable', () => {
    const byValue = (a: { v: number }, b: { v: number }) => a.v - b.v;
    for (let round = 0; round < 50; round++) {
      const sorted = Array.from({ length: (round * 7) % 30 }, (_, i) => ({ v: Math.floor(i / 2), from: 'old' })).sort(
        byValue
      );
      const added = Array.from({ length: (round * 3) % 20 }, (_, i) => ({ v: (i * 5 + round) % 15, from: 'new' })).sort(
        byValue
      );

      const merged = mergeSorted(sorted, added, byValue);

      expect(merged).toEqual([...sorted, ...added].sort(byValue));
    }
  });

  it('returns a new array, so a merge is seen as a change', () => {
    const sorted = [1, 2, 3];
    expect(mergeSorted(sorted, [], (a, b) => a - b)).not.toBe(sorted);
  });
});
