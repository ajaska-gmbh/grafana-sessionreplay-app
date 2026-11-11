import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { css } from '@emotion/css';
import { dateTimeFormat, GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import {
  Alert,
  Badge,
  Column,
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
import { DayPicker } from '../components/AgentDay/DayPicker';
import { testIds } from '../components/testIds';
import { PLUGIN_BASE_URL } from '../constants';
import { useSettings } from '../hooks/useSettings';
import { agentDayPath, dayOf, dayQueryRange, groupAgents, matchesAgent, type Agent } from '../lib/agents';
import { fetchActiveSessionIds, fetchAppNames, fetchSessions } from '../lib/sessionQueries';
import { LIVE_WINDOW_MS } from '../lib/sessionStore';

type Row = Agent & { id: string; live: boolean };

interface Loaded {
  key: string;
  agents: Agent[];
  active: Set<string>;
  truncated: boolean;
  failure?: string;
}

/** Every agent with a recorded session on the day: click one to watch the agent's day. */
function AgentsPage() {
  const styles = useStyles2(getStyles);
  const { lokiUid } = useSettings();
  const [params, setParams] = useSearchParams();
  const day = useMemo(() => dayOf(params.get('day')), [params]);
  const apps = useMemo(() => (params.get('apps') ?? '').split(',').filter(Boolean), [params]);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [appOptions, setAppOptions] = useState<Array<ComboboxOption<string>>>([]);
  const [loaded, setLoaded] = useState<Loaded>();

  const remember = (name: string, value: string | undefined) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) {
          next.set(name, value);
        } else {
          next.delete(name);
        }
        return next;
      },
      { replace: true }
    );

  const key = JSON.stringify({ lokiUid, apps, day: day.key });
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const range = dayQueryRange(day, now);
    fetchAppNames(lokiUid, range.from, range.to)
      .then((names) => !cancelled && setAppOptions(names.map((name) => ({ label: name, value: name }))))
      .catch(() => undefined);
    Promise.all([
      fetchSessions(lokiUid, apps, range.from, range.to),
      day.endMs > now
        ? fetchActiveSessionIds(lokiUid, apps, now, LIVE_WINDOW_MS).catch(() => new Set<string>())
        : Promise.resolve(new Set<string>()),
    ])
      .then(([found, active]) => {
        if (!cancelled) {
          setLoaded({ key, agents: groupAgents(found.sessions, day), active, truncated: found.truncated });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const failure = (error as { data?: { message?: string } })?.data?.message ?? String(error);
          setLoaded({ key, agents: [], active: new Set(), truncated: false, failure });
        }
      });
    return () => {
      cancelled = true;
    };
    // `key` stands for lokiUid, apps and the day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loading = loaded?.key !== key;
  const rows = useMemo<Row[]>(() => {
    if (!loaded || loading) {
      return [];
    }
    return loaded.agents
      .filter((agent) => matchesAgent(agent, search))
      .map((agent) => ({
        ...agent,
        id: agent.key,
        live: agent.sessions.some((session) => loaded.active.has(session.sessionId)),
      }))
      .sort((a, b) => Number(b.live) - Number(a.live) || b.lastStartedMs - a.lastStartedMs);
  }, [loaded, loading, search]);

  const columns = useMemo<Array<Column<Row>>>(
    () => [
      {
        id: 'userName',
        header: 'Agent',
        sortType: 'string',
        cell: ({ row }) => (
          <Stack gap={1} alignItems="center">
            <Tooltip content={`${row.original.userEmail ?? '–'} · user_id ${row.original.userId}`}>
              <span>{row.original.userName || row.original.userEmail || `User ${row.original.userId}`}</span>
            </Tooltip>
            {row.original.live && <Badge text="Live" color="red" icon="circle-mono" />}
          </Stack>
        ),
      },
      { id: 'appName', header: 'App', sortType: 'string' },
      {
        id: 'firstMs',
        header: 'First activity',
        sortType: 'number',
        cell: ({ row }) => dateTimeFormat(row.original.firstMs, { format: 'HH:mm' }),
      },
      {
        id: 'lastStartedMs',
        header: 'Last page load',
        sortType: 'number',
        cell: ({ row }) => dateTimeFormat(row.original.lastStartedMs, { format: 'HH:mm' }),
      },
      {
        id: 'sessions',
        header: 'Sessions',
        sortType: (a, b) => a.original.sessions.length - b.original.sessions.length,
        cell: ({ row }) => row.original.sessions.length,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Stack gap={1}>
            <LinkButton
              size="sm"
              icon="play"
              variant="secondary"
              href={`${PLUGIN_BASE_URL}/${agentDayPath(row.original.appName, row.original.userId, day.key)}`}
            >
              Watch the day
            </LinkButton>
            {row.original.live && (
              <LinkButton
                size="sm"
                icon="circle-mono"
                variant="destructive"
                tooltip="Follow the agent live, with sound"
                href={`${PLUGIN_BASE_URL}/${agentDayPath(row.original.appName, row.original.userId, day.key, { live: true })}`}
              >
                Live
              </LinkButton>
            )}
          </Stack>
        ),
      },
    ],
    [day.key]
  );

  return (
    <PluginPage>
      <div data-testid={testIds.agents.container} className={styles.page}>
        <Stack gap={1} wrap="wrap" alignItems="center">
          <div className={styles.search}>
            <FilterInput
              placeholder="Search agent, email or user id…"
              value={search}
              onChange={(value) => {
                setSearch(value);
                remember('q', value.trim() || undefined);
              }}
              escapeRegex={false}
            />
          </div>
          <MultiCombobox
            width={40}
            placeholder="All apps"
            options={appOptions}
            value={apps}
            onChange={(selected) => remember('apps', selected.map((option) => option.value).join(',') || undefined)}
          />
          <DayPicker
            day={day}
            onChange={(next) => remember('day', next.key === dayOf(undefined).key ? undefined : next.key)}
          />
        </Stack>
        {!loading && loaded?.truncated && (
          <Alert severity="warning" title="Not all agents may be listed">
            The day holds more recordings than one query returns. Filter by app.
          </Alert>
        )}
        {!loading && loaded?.failure && (
          <Alert severity="error" title="Could not load the agents">
            {loaded.failure}
          </Alert>
        )}
        {loading ? (
          <LoadingPlaceholder text="Loading agents…" />
        ) : (
          <InteractiveTable columns={columns} data={rows} getRowId={(row) => row.id} pageSize={100} />
        )}
        {!loading && !loaded?.failure && rows.length === 0 && (
          <div className={styles.empty}>No agent has a recorded session on this day.</div>
        )}
      </div>
    </PluginPage>
  );
}

export default AgentsPage;

const getStyles = (theme: GrafanaTheme2) => ({
  page: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(2) }),
  search: css({ flex: 1, minWidth: 240 }),
  empty: css({ color: theme.colors.text.secondary }),
});
