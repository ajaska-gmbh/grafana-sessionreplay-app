import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { PLUGIN_ID } from '../constants';
import { trackOf, type AudioSegment, type AudioSources, type CallAudioTrack } from './callAudio';

/**
 * The call recorder's read API, through the app's `recorder` plugin route
 * (plugin.json), which adds the read token on Grafana's side. The only code
 * that knows the recorder's URLs and answers.
 */
const BASE = `api/plugin-proxy/${PLUGIN_ID}/recorder/v1`;

/** The recorder's listings span at most this long. */
const MAX_LIST_MS = 48 * 3600_000;

interface ListedSegment {
  key: string;
  source: string;
  track: string;
  start_ms: number;
  duration_ms: number;
  gaps?: Array<{ start_ms: number; end_ms: number }>;
}

async function list(path: string, params: Record<string, string | number>): Promise<AudioSegment[]> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const response = await lastValueFrom(
    getBackendSrv().fetch<{ segments?: ListedSegment[] }>({ url: `${BASE}/${path}?${query}`, showErrorAlert: false })
  );
  const segments: AudioSegment[] = [];
  for (const s of response.data.segments ?? []) {
    const track = trackOf(s.source, s.track);
    if (track && Number.isFinite(s.start_ms) && s.duration_ms > 0) {
      segments.push({
        key: s.key,
        track,
        startMs: s.start_ms,
        durationMs: s.duration_ms,
        gaps: (s.gaps ?? []).map((gap) => ({ startMs: gap.start_ms, endMs: gap.end_ms })),
      });
    }
  }
  return segments;
}

export type CallAudioSegments = Record<CallAudioTrack, AudioSegment[]>;

export function noSegments(): CallAudioSegments {
  return { mic: [], heard: [], agent: [], customer: [] };
}

/** Every segment of the session's audio between fromMs and toMs, by track, sorted. */
export async function listSessionAudio(
  sources: AudioSources,
  fromMs: number,
  toMs: number
): Promise<CallAudioSegments> {
  const result = noSegments();
  const lists: Array<Promise<AudioSegment[]>> = [];
  for (let from = fromMs; from < toMs; from += MAX_LIST_MS) {
    const to = Math.min(toMs, from + MAX_LIST_MS);
    if (sources.browser) {
      lists.push(list('browser/segments', { env: sources.browser.env, agent_id: sources.browser.agentId, from, to }));
    }
    for (const leg of sources.legSids) {
      lists.push(list('carrier/segments', { leg_sid: leg, from, to }));
    }
  }
  const seen = new Set<string>();
  for (const segment of (await Promise.all(lists)).flat()) {
    if (!seen.has(segment.key)) {
      seen.add(segment.key);
      result[segment.track].push(segment);
    }
  }
  for (const track of Object.values(result)) {
    track.sort((a, b) => a.startMs - b.startMs);
  }
  return result;
}

/** One segment's audio (Ogg Opus). */
export async function fetchSegmentAudio(key: string): Promise<ArrayBuffer> {
  const response = await lastValueFrom(
    getBackendSrv().fetch<ArrayBuffer>({
      url: `${BASE}/audio?${new URLSearchParams({ key })}`,
      responseType: 'arraybuffer',
      showErrorAlert: false,
    })
  );
  return response.data;
}
