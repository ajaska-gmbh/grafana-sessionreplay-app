import { usePluginContext } from '@grafana/data';
import { DEFAULT_LOKI_UID, DEFAULT_TEMPO_UID } from '../constants';
import type { AppSettings } from '../types';

/** Datasource uids from the app config, defaulting to `loki` / `tempo`. */
export function useSettings(): Required<AppSettings> {
  const context = usePluginContext();
  const jsonData = (context?.meta.jsonData ?? {}) as AppSettings;
  return {
    lokiUid: jsonData.lokiUid || DEFAULT_LOKI_UID,
    tempoUid: jsonData.tempoUid || DEFAULT_TEMPO_UID,
  };
}
