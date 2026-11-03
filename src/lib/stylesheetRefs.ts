import type { eventWithTime } from '@grafana/rrweb-types';

/**
 * Reader for stylesheet references in session replay events — format
 * `ajaska-css/v1`, written by the Predictive Power Dialer
 * (predictive-power-dialer resources/js/replayStylesheets.ts).
 *
 * The writer sends a stylesheet text (rrweb `_cssText`, or `textContent` of a
 * text node with `isStyle: true`) of at least STYLESHEET_REF_MIN_LENGTH code
 * units in full the first time within a Faro session, and afterwards as
 * `ajaska-css/v1:<cyrb53 hex>:<length>`. The full text always precedes its
 * references in time and in the same session, and the session is loaded from
 * its start (live mode included), so references are resolved once, in place,
 * when their events are added, before the player sees them.
 *
 * KEEP IN SYNC with the writer: hash, format and minimum length must be
 * identical; both test suites pin the same vectors.
 *
 * Fallback: a reference that cannot be resolved (its text was not loaded, the
 * memory cap was hit, or an unknown format version) becomes an empty
 * stylesheet, so the replay renders without it, and is counted for the UI.
 * Recordings without references pass through untouched.
 */

export const STYLESHEET_REF_VERSION = 'ajaska-css/v1';
export const STYLESHEET_REF_MIN_LENGTH = 2048;
/**
 * Total length (UTF-16 code units, ~2 bytes each) of the distinct full texts
 * remembered per session: 16 Mi units = 32 MiB, about 23 distinct CRM
 * stylesheets of 0.7 MB. First come, first kept; texts beyond it are counted
 * in `droppedTexts` and references to them stay unresolved.
 */
export const STYLESHEET_TEXTS_MAX_LENGTH = 16 * 1024 * 1024;

const ANY_REF = /^ajaska-css\/v\d+:[0-9a-f]+:\d+$/;

/** cyrb53 (public domain, bryc), identical to the writer's. */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function stylesheetRef(text: string): string {
  return `${STYLESHEET_REF_VERSION}:${cyrb53(text).toString(16)}:${text.length}`;
}

export function isStylesheetRef(value: string): boolean {
  return value.length < 64 && value.startsWith('ajaska-css/') && ANY_REF.test(value);
}

interface Candidate {
  text: string;
  ref?: string;
}

/**
 * Remembers the full stylesheet texts of one session and resolves references
 * to them. Texts are only hashed when a reference of their length needs them,
 * so recordings without references cost no hashing at all.
 */
export class StylesheetResolver {
  /** References that could not be resolved, counted once each. */
  unresolved = 0;
  /** Distinct full texts not remembered because of the size cap. */
  droppedTexts = 0;

  private readonly byLength = new Map<number, Candidate[]>();
  private readonly resolved = new Map<string, string>();
  private readonly missing = new Set<string>();
  private rememberedLength = 0;
  private readonly maxLength: number;
  private readonly dropped = new Set<string>();

  constructor(maxLength = STYLESHEET_TEXTS_MAX_LENGTH) {
    this.maxLength = maxLength;
  }

  /**
   * Resolve the references in newly loaded events, in place. Call once per
   * batch, in loading order; every event only once.
   */
  addEvents(events: eventWithTime[]): void {
    const refs: Array<{ owner: Record<string, unknown>; key: string; ref: string }> = [];
    for (const event of events) {
      this.walk(event.data, (owner, key, value) => {
        if (isStylesheetRef(value)) {
          refs.push({ owner, key, ref: value });
        } else if (value.length >= STYLESHEET_REF_MIN_LENGTH) {
          this.remember(value);
        }
      });
    }
    for (const { owner, key, ref } of refs) {
      const text = this.lookup(ref);
      if (text === undefined && !this.missing.has(ref)) {
        this.missing.add(ref);
        this.unresolved++;
      }
      owner[key] = text ?? '';
    }
  }

  private remember(text: string): void {
    const candidates = this.byLength.get(text.length) ?? [];
    if (candidates.some((candidate) => candidate.text === text)) {
      return;
    }
    if (this.rememberedLength + text.length > this.maxLength) {
      // Counted once per distinct text (texts recur in old-format recordings).
      if (!this.dropped.has(text)) {
        this.dropped.add(text);
        this.droppedTexts = this.dropped.size;
      }
      return;
    }
    candidates.push({ text });
    this.byLength.set(text.length, candidates);
    this.rememberedLength += text.length;
  }

  private lookup(ref: string): string | undefined {
    const known = this.resolved.get(ref);
    if (known !== undefined || !ref.startsWith(`${STYLESHEET_REF_VERSION}:`)) {
      return known;
    }
    const length = Number(ref.slice(ref.lastIndexOf(':') + 1));
    for (const candidate of this.byLength.get(length) ?? []) {
      candidate.ref ??= stylesheetRef(candidate.text);
      if (candidate.ref === ref) {
        this.resolved.set(ref, candidate.text);
        return candidate.text;
      }
    }
    return undefined;
  }

  /** Visits the stylesheet strings the format covers. */
  private walk(value: unknown, visit: (owner: Record<string, unknown>, key: string, value: string) => void): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.walk(item, visit);
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key in object) {
      const child = object[key];
      if (typeof child === 'string') {
        if (key === '_cssText' || (key === 'textContent' && object.isStyle === true)) {
          visit(object, key, child);
        }
      } else if (child !== null && typeof child === 'object') {
        this.walk(child, visit);
      }
    }
  }
}
