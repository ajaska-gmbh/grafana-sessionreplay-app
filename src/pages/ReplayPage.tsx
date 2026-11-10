import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { LinkButton, useStyles2 } from '@grafana/ui';
import { useParams, useSearchParams } from 'react-router-dom';
import { SessionReplay } from '../components/SessionReplay/SessionReplay';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useSettings } from '../hooks/useSettings';
import { searchParam } from '../lib/sessionSearch';

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Full-screen viewer: /a/<plugin>/app/<app_name>/session/<session_id>?t=<ms>&from=&to= */
function ReplayPage() {
  const styles = useStyles2(getStyles);
  const { appName = '', sessionId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { lokiUid, tempoUid, searchFields, recorder, payloadBuckets } = useSettings();
  const from = numberParam(searchParams.get('from'));
  const to = numberParam(searchParams.get('to'));

  return (
    <PluginPage
      pageNav={{ text: `Session ${sessionId}`, subTitle: appName }}
      actions={
        <LinkButton variant="secondary" icon="arrow-left" href={`${PLUGIN_BASE_URL}/${ROUTES.Sessions}`}>
          All sessions
        </LinkButton>
      }
    >
      <div className={styles.page}>
        <SessionReplay
          key={`${appName}|${sessionId}|${from}|${to}`}
          appName={appName}
          sessionId={sessionId}
          from={from}
          to={to}
          t={numberParam(searchParams.get('t'))}
          track={numberParam(searchParams.get('track'))}
          live={searchParams.get('live') === '1'}
          highlight={searchParam(searchParams.get('q')) || undefined}
          searchFields={searchFields}
          recorder={recorder}
          payloadBuckets={payloadBuckets}
          lokiUid={lokiUid}
          tempoUid={tempoUid}
        />
      </div>
    </PluginPage>
  );
}

export default ReplayPage;

const getStyles = (theme: GrafanaTheme2) => ({
  page: css({ height: 'calc(100vh - 220px)', minHeight: 560 }),
});
