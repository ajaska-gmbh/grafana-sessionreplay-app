import React, { Suspense, lazy } from 'react';
import { AppPlugin } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/AppConfig/AppConfig';
import type { SessionReplayProps } from './components/SessionReplay/SessionReplay';
import { useSettings } from './hooks/useSettings';
import type { AppSettings } from './types';

const App = lazy(() => import('./components/App/App'));
const LazyAppConfig = lazy(() => import('./components/AppConfig/AppConfig'));
const LazySessionReplay = lazy(() =>
  import('./components/SessionReplay/SessionReplay').then((module) => ({ default: module.SessionReplay }))
);

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

export type ReplayPlayerV1Props = Pick<
  SessionReplayProps,
  'appName' | 'sessionId' | 'from' | 'to' | 't' | 'height' | 'live'
>;

/** Embeddable player + user journey, like grafana-sessionreplay-app/replay-player/v1. */
function ReplayPlayerV1(props: ReplayPlayerV1Props) {
  const { lokiUid, tempoUid } = useSettings();
  return (
    <Suspense fallback={<LoadingPlaceholder text="Loading recording…" />}>
      <LazySessionReplay
        key={`${props.appName}|${props.sessionId}|${props.from}|${props.to}`}
        {...props}
        height={props.height ?? 560}
        lokiUid={lokiUid}
        tempoUid={tempoUid}
      />
    </Suspense>
  );
}

export const plugin = new AppPlugin<AppSettings>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: AppConfig,
    id: 'configuration',
  })
  .exposeComponent({
    id: 'ajaska-sessionreplay-app/replay-player/v1',
    title: 'Session replay player',
    description: 'Replay player with the user journey for one Faro session.',
    component: ReplayPlayerV1,
  });
