export interface AppSettings {
  lokiUid?: string;
  tempoUid?: string;
}

/** One raw Loki log line with its nanosecond timestamp. */
export interface LokiLine {
  tsNs: string;
  line: string;
}
