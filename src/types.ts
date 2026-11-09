export interface AppSettings {
  lokiUid?: string;
  tempoUid?: string;
  /**
   * Faro event attributes the session search looks up exactly, server-side
   * (e.g. `lead_id`, `crm_lead_id`): a search for a value finds every session
   * with an event carrying it. None: only the session list is searched.
   */
  searchFields?: string[];
  /** The call recorder's read API (one for every environment), for the call audio. None: no call audio. */
  recorderUrl?: string;
  /**
   * The replay payload stream is split into this many session buckets
   * (label session_bucket, set by the Alloy Faro pipeline) for sessions from
   * payloadBucketsSince on (ISO time, set an hour after the pipeline started
   * labelling, for agent clocks running ahead). None: read the whole stream.
   */
  payloadBuckets?: number;
  payloadBucketsSince?: string;
}

/** Kept encrypted by Grafana; the browser only learns whether they are set. */
export interface AppSecureSettings {
  recorderToken?: string;
}

/** One raw Loki log line with its nanosecond timestamp. */
export interface LokiLine {
  tsNs: string;
  line: string;
}
