import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { dateTimeFormat, GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import {
  Alert,
  Badge,
  Column,
  Combobox,
  ComboboxOption,
  FilterInput,
  InteractiveTable,
  LinkButton,
  LoadingPlaceholder,
  MultiCombobox,
  Stack,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { MAX_SESSION_MS } from '../constants';
import { useSettings } from '../hooks/useSettings';
import { replayUrl } from '../lib/format';
import { fetchAppNames, fetchErrorCounts, fetchSessions } from '../lib/sessionQueries';
import { matchesSearch, type SessionSummary } from '../lib/sessions';
import { testIds } from '../components/testIds';

const LOOKBACKS: Array<ComboboxOption<number>> = [
  { label: 'Last hour', value: 3600_000 },
  { label: 'Last 6 hours', value: 6 * 3600_000 },
  { label: 'Last 24 hours', value: 24 * 3600_000 },
  { label: 'Last 3 days', value: 3 * 24 * 3600_000 },
  { label: 'Last 7 days', value: 7 * 24 * 3600_000 },
  { label: 'Last 14 days', value: 14 * 24 * 3600_000 },
];

type Row = SessionSummary & { id: string };

interface QueryResult {
  key: string;
  nowMs: number;
  sessions: SessionSummary[];
  errors: Map<string, number>;
  failure?: string;
}

/** Time range a replay link opens with: the whole session, at most 4h after its last page load. */
export function sessionRange(session: SessionSummary, nowMs: number) {
  return { from: session.startedMs - 60_000, to: Math.min(nowMs, session.lastStartedMs + MAX_SESSION_MS) };
}

function SessionsPage() {
  const styles = useStyles2(getStyles);
  const { lokiUid } = useSettings();
  const [lookback, setLookback] = useState<number>(24 * 3600_000);
  const [apps, setApps] = useState<string[]>([]);
  const [appOptions, setAppOptions] = useState<Array<ComboboxOption<string>>>([]);
  const [environment, setEnvironment] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<QueryResult>();

  const queryKey = JSON.stringify({ lokiUid, apps, lookback });
  const loading = result?.key !== queryKey;
  const sessions = useMemo(() => result?.sessions ?? [], [result]);
  const errors = useMemo(() => result?.errors ?? new Map<string, number>(), [result]);
  const nowMs = result?.nowMs ?? 0;
  const failure = loading ? undefined : result?.failure;

  useEffect(() => {
    const now = Date.now();
    fetchAppNames(lokiUid, now - lookback, now)
      .then((names) => setAppOptions(names.map((name) => ({ label: name, value: name }))))
      .catch(() => setAppOptions([]));
  }, [lokiUid, lookback]);

  useEffect(() => {
    let cancelled = false;
    const key = JSON.stringify({ lokiUid, apps, lookback });
    const now = Date.now();

    Promise.all([
      fetchSessions(lokiUid, apps, now - lookback, now),
      fetchErrorCounts(lokiUid, apps, now - lookback, now).catch(() => new Map<string, number>()),
    ])
      .then(([found, errorCounts]) => {
        if (!cancelled) {
          setResult({ key, nowMs: now, sessions: found, errors: errorCounts });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const failureText = (error as { data?: { message?: string } })?.data?.message ?? String(error);
          setResult({ key, nowMs: now, sessions: [], errors: new Map(), failure: failureText });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [lokiUid, apps, lookback]);

  const environments = useMemo(
    () => [...new Set(sessions.map((session) => session.environment).filter(Boolean))].sort(),
    [sessions]
  );

  const rows = useMemo<Row[]>(
    () =>
      sessions
        .filter((session) => !environment || session.environment === environment)
        .filter((session) => matchesSearch(session, search))
        .map((session) => ({ ...session, id: session.sessionId, errors: errors.get(session.sessionId) ?? 0 })),
    [sessions, environment, search, errors]
  );

  const columns = useMemo<Array<Column<Row>>>(
    () => [
      {
        id: 'startedMs',
        header: 'Started',
        sortType: 'number',
        cell: ({ row }) => dateTimeFormat(row.original.startedMs, { format: 'YYYY-MM-DD HH:mm:ss' }),
      },
      {
        id: 'sessionId',
        header: 'Session ID',
        sortType: 'string',
        cell: ({ row }) => <code>{row.original.sessionId}</code>,
      },
      {
        id: 'userEmail',
        header: 'User',
        sortType: 'string',
        cell: ({ row }) => (
          <Tooltip content={`user_id ${row.original.userId ?? '–'}`}>
            <span>{row.original.userName || row.original.userEmail || row.original.userId || '–'}</span>
          </Tooltip>
        ),
      },
      { id: 'appName', header: 'App', sortType: 'string' },
      { id: 'environment', header: 'Environment', sortType: 'string' },
      {
        id: 'browser',
        header: 'Browser',
        sortType: 'string',
        cell: ({ row }) => [row.original.browser, row.original.os].filter(Boolean).join(' · ') || '–',
      },
      { id: 'recordings', header: 'Page loads', sortType: 'number' },
      {
        id: 'errors',
        header: 'Errors',
        sortType: 'number',
        cell: ({ row }) =>
          row.original.errors ? (
            <Badge text={String(row.original.errors)} color="red" icon="exclamation-triangle" />
          ) : (
            '0'
          ),
      },
      {
        id: 'replay',
        header: 'Session replay',
        cell: ({ row }) => (
          <LinkButton
            size="sm"
            icon="play"
            variant="secondary"
            href={replayUrl(row.original.appName, row.original.sessionId, sessionRange(row.original, nowMs))}
          >
            Replay
          </LinkButton>
        ),
      },
    ],
    [nowMs]
  );

  return (
    <PluginPage>
      <div data-testid={testIds.sessions.container} className={styles.page}>
        <Stack gap={1} wrap="wrap" alignItems="center">
          <div className={styles.search}>
            <FilterInput
              placeholder="Search session, user, page, browser…"
              value={search}
              onChange={setSearch}
              data-testid={testIds.sessions.search}
            />
          </div>
          <MultiCombobox
            width={40}
            placeholder="All apps"
            options={appOptions}
            value={apps}
            onChange={(selected) => setApps(selected.map((option) => option.value))}
          />
          <Combobox
            width={22}
            placeholder="All environments"
            isClearable
            options={environments.map((value) => ({ label: value, value }))}
            value={environment ?? null}
            onChange={(selected) => setEnvironment(selected?.value)}
          />
          <Combobox
            width={20}
            options={LOOKBACKS}
            value={lookback}
            onChange={(selected) => setLookback(selected.value)}
          />
        </Stack>

        {failure && (
          <Alert severity="error" title="Could not load sessions">
            {failure}
          </Alert>
        )}
        {loading ? (
          <LoadingPlaceholder text="Loading sessions…" />
        ) : (
          <InteractiveTable columns={columns} data={rows} getRowId={(row) => row.sessionId} pageSize={50} />
        )}
        {!loading && !failure && rows.length === 0 && (
          <div className={styles.empty}>No recorded sessions in this range.</div>
        )}
      </div>
    </PluginPage>
  );
}

export default SessionsPage;

const getStyles = (theme: GrafanaTheme2) => ({
  page: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(2) }),
  search: css({ flex: 1, minWidth: 280 }),
  empty: css({ color: theme.colors.text.secondary }),
});
