import { usePluginContext } from '@grafana/data';
import { DEFAULT_LOKI_UID, DEFAULT_TEMPO_UID } from '../constants';
import { payloadBucketsOf, type PayloadBuckets } from '../lib/sessionBucket';
import { validSearchFields } from '../lib/sessionSearch';
import type { AppSettings } from '../types';

export interface Settings {
  lokiUid: string;
  tempoUid: string;
  searchFields: string[];
  /** Whether the call recorder is configured (its URL and read token). */
  recorder: boolean;
  /** Where the payload stream is split by session (see AppSettings.payloadBuckets). */
  payloadBuckets?: PayloadBuckets;
}

/** The app config: datasource uids (default `loki` / `tempo`), search fields, recorder. */
export function useSettings(): Settings {
  const context = usePluginContext();
  const jsonData = (context?.meta.jsonData ?? {}) as AppSettings;
  const secure = (context?.meta.secureJsonFields ?? {}) as Record<string, boolean>;
  return {
    lokiUid: jsonData.lokiUid || DEFAULT_LOKI_UID,
    tempoUid: jsonData.tempoUid || DEFAULT_TEMPO_UID,
    searchFields: validSearchFields(jsonData.searchFields),
    recorder: Boolean(jsonData.recorderUrl) && Boolean(secure.recorderToken),
    payloadBuckets: payloadBucketsOf(jsonData.payloadBuckets, jsonData.payloadBucketsSince),
  };
}
