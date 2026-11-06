/**
 * Merges `added` into `sorted` (both sorted by `compare`) into a new array in
 * O(n + k): a page of newly loaded items costs its own size plus one pass, not
 * a sort of everything loaded so far. Equal items keep `sorted`'s first.
 */
export function mergeSorted<T>(sorted: readonly T[], added: readonly T[], compare: (a: T, b: T) => number): T[] {
  if (added.length === 0) {
    return sorted.slice();
  }
  const result = new Array<T>(sorted.length + added.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < sorted.length && j < added.length) {
    result[k++] = compare(added[j], sorted[i]) < 0 ? added[j++] : sorted[i++];
  }
  while (i < sorted.length) {
    result[k++] = sorted[i++];
  }
  while (j < added.length) {
    result[k++] = added[j++];
  }
  return result;
}
