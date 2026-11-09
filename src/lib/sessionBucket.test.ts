import { adler32, payloadBucketsOf, sessionBucket } from './sessionBucket';

describe('session bucket', () => {
  it('computes Adler-32 as Go and sprig do', () => {
    // Known values: Wikipedia's example and the empty string.
    expect(adler32('Wikipedia')).toBe(0x11e60398);
    expect(adler32('')).toBe(1);
  });

  it("matches the Alloy pipeline's vectors (kubernetes-configs monitoring-new/README.md)", () => {
    expect(['XNtXWqeUtk', 'jGdZf2bkP5', 'a', 'Z9', '0000000000'].map((id) => sessionBucket(id, 256))).toEqual([
      '212',
      '090',
      '098',
      '148',
      '225',
    ]);
  });

  it('takes only valid settings', () => {
    expect(payloadBucketsOf(256, '2026-11-09T12:00:00Z')).toEqual({ count: 256, sinceMs: Date.UTC(2026, 10, 9, 12) });
    expect(payloadBucketsOf(undefined, '2026-11-09T12:00:00Z')).toBeUndefined();
    expect(payloadBucketsOf(256, 'soon')).toBeUndefined();
    expect(payloadBucketsOf(1, '2026-11-09T12:00:00Z')).toBeUndefined();
    expect(payloadBucketsOf(25.5, '2026-11-09T12:00:00Z')).toBeUndefined();
  });
});
