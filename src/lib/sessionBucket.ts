/**
 * The replay payload stream is split into buckets by session: the Alloy Faro
 * pipeline labels every payload line `session_bucket="<adler32(session_id) %
 * count, zero padded to 3 digits>"` (kubernetes-configs
 * monitoring-new/alloy-faro-values.yaml, vectors in monitoring-new/README.md).
 * A replay reading its own bucket scans about 1/count of all sessions'
 * payload instead of all of it.
 */

/** Where the payload streams carry a session bucket (app config). */
export interface PayloadBuckets {
  count: number;
  /** Sessions whose load range starts at or after this (epoch ms) are read through their bucket. */
  sinceMs: number;
}

const ADLER_MOD = 65521;

/** Adler-32 of the UTF-8 bytes of `value`, as Go's hash/adler32 (sprig `adler32sum`). */
export function adler32(value: string): number {
  let a = 1;
  let b = 0;
  for (const byte of new TextEncoder().encode(value)) {
    a = (a + byte) % ADLER_MOD;
    b = (b + a) % ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** The session's bucket label value, e.g. "212". */
export function sessionBucket(sessionId: string, count: number): string {
  return String(adler32(sessionId) % count).padStart(3, '0');
}

/** Valid settings or none: a count of 2–1000 buckets and a parsable start time. */
export function payloadBucketsOf(count: unknown, since: unknown): PayloadBuckets | undefined {
  const sinceMs = typeof since === 'string' ? Date.parse(since) : NaN;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 2 || count > 1000 || !Number.isFinite(sinceMs)) {
    return undefined;
  }
  return { count, sinceMs };
}
