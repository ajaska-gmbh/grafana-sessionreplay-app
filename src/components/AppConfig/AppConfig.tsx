import React, { useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { AppPluginMeta, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { DataSourcePicker, getBackendSrv } from '@grafana/runtime';
import { Button, Field, FieldSet, Stack } from '@grafana/ui';
import { DEFAULT_LOKI_UID, DEFAULT_TEMPO_UID } from '../../constants';
import type { AppSettings } from '../../types';
import { testIds } from '../testIds';

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppSettings>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const { enabled, pinned, jsonData } = plugin.meta;
  const [lokiUid, setLokiUid] = useState(jsonData?.lokiUid || DEFAULT_LOKI_UID);
  const [tempoUid, setTempoUid] = useState(jsonData?.tempoUid || DEFAULT_TEMPO_UID);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void updatePluginAndReload(plugin.meta.id, { enabled, pinned, jsonData: { lokiUid, tempoUid } });
      }}
    >
      <FieldSet label="Data sources">
        <Stack direction="column" gap={2}>
          <Field
            label="Loki"
            description='Holds the Faro logs ({source="faro"}) and the session replay payloads ({source="faro_replay"}).'
          >
            <div data-testid={testIds.appConfig.lokiUid}>
              <DataSourcePicker
                width={60}
                type="loki"
                current={lokiUid}
                onChange={(ds) => setLokiUid(ds.uid)}
                noDefault
              />
            </div>
          </Field>
          <Field label="Tempo" description="Used for the trace links in the user journey.">
            <div data-testid={testIds.appConfig.tempoUid}>
              <DataSourcePicker
                width={60}
                type="tempo"
                current={tempoUid}
                onChange={(ds) => setTempoUid(ds.uid)}
                noDefault
              />
            </div>
          </Field>
          <div>
            <Button type="submit" data-testid={testIds.appConfig.submit}>
              Save settings
            </Button>
          </div>
        </Stack>
      </FieldSet>
    </form>
  );
};

export default AppConfig;

const updatePluginAndReload = async (pluginId: string, data: Partial<PluginMeta<AppSettings>>) => {
  try {
    await lastValueFrom(getBackendSrv().fetch({ url: `/api/plugins/${pluginId}/settings`, method: 'POST', data }));
    // Plugin settings are only read on load.
    window.location.reload();
  } catch (e) {
    console.error('Error while updating the plugin', e);
  }
};
