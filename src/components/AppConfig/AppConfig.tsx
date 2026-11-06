import React, { useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { AppPluginMeta, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { DataSourcePicker, getBackendSrv } from '@grafana/runtime';
import { Button, Field, FieldSet, Input, SecretInput, Stack, TagsInput } from '@grafana/ui';
import { DEFAULT_LOKI_UID, DEFAULT_TEMPO_UID } from '../../constants';
import { validSearchFields } from '../../lib/sessionSearch';
import type { AppSecureSettings, AppSettings } from '../../types';
import { testIds } from '../testIds';

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppSettings>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const { enabled, pinned, jsonData, secureJsonFields } = plugin.meta;
  const [lokiUid, setLokiUid] = useState(jsonData?.lokiUid || DEFAULT_LOKI_UID);
  const [tempoUid, setTempoUid] = useState(jsonData?.tempoUid || DEFAULT_TEMPO_UID);
  const [searchFields, setSearchFields] = useState<string[]>(validSearchFields(jsonData?.searchFields));
  const [recorderUrl, setRecorderUrl] = useState(jsonData?.recorderUrl ?? '');
  // The token is never sent back to the browser: only whether one is set.
  const [recorderToken, setRecorderToken] = useState('');
  const [tokenSet, setTokenSet] = useState(Boolean(secureJsonFields?.recorderToken));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const secureJsonData: AppSecureSettings | undefined = recorderToken
          ? { recorderToken }
          : !tokenSet && secureJsonFields?.recorderToken
            ? { recorderToken: '' }
            : undefined;
        void updatePluginAndReload(plugin.meta.id, {
          enabled,
          pinned,
          jsonData: {
            lokiUid,
            tempoUid,
            searchFields: validSearchFields(searchFields),
            recorderUrl: recorderUrl.trim() || undefined,
          },
          secureJsonData,
        });
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
        </Stack>
      </FieldSet>
      <FieldSet label="Search">
        <Field
          label="Search fields"
          description="Faro event attributes a search looks up exactly in every session's events, e.g. lead_id and crm_lead_id (the dialer's call.bridged events). Letters, digits and underscores."
        >
          <TagsInput tags={searchFields} onChange={(tags) => setSearchFields(validSearchFields(tags))} width={60} />
        </Field>
      </FieldSet>
      <FieldSet label="Call audio">
        <Stack direction="column" gap={2}>
          <Field
            label="Call recorder URL"
            description="The call recorder's internal read API, the same for every dialer environment, e.g. http://call-recorder.call-recorder.svc:8081. Empty: no call audio."
          >
            <Input
              width={60}
              value={recorderUrl}
              placeholder="http://call-recorder.call-recorder.svc:8081"
              onChange={(event) => setRecorderUrl(event.currentTarget.value)}
            />
          </Field>
          <Field label="Read token" description="The recorder's RECORDER_READ_TOKEN; kept encrypted by Grafana.">
            <SecretInput
              width={60}
              isConfigured={tokenSet}
              value={recorderToken}
              onChange={(event) => setRecorderToken(event.currentTarget.value)}
              onReset={() => {
                setTokenSet(false);
                setRecorderToken('');
              }}
            />
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

const updatePluginAndReload = async (
  pluginId: string,
  data: Partial<PluginMeta<AppSettings>> & { secureJsonData?: AppSecureSettings }
) => {
  try {
    await lastValueFrom(getBackendSrv().fetch({ url: `/api/plugins/${pluginId}/settings`, method: 'POST', data }));
    // Plugin settings are only read on load.
    window.location.reload();
  } catch (e) {
    console.error('Error while updating the plugin', e);
  }
};
