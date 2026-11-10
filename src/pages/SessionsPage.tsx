import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { useSettings } from '../hooks/useSettings';
import { replayUrl } from '../lib/format';
import {
  fetchActiveSessionIds,
  fetchAppNames,
  fetchErrorCounts,
  fetchMatchingSessionIds,
  fetchSessions,
} from '../lib/sessionQueries';
import { searchParam, searchValue } from '../lib/sessionSearch';
import { LIVE_WINDOW_MS } from '../lib/sessionStore';
import { matchesSearch, sessionRange, type SessionSummary } from '../lib/sessions';
import { testIds } from '../components/testIds';

const LOOKBACKS: Array<ComboboxOption<number>> = [
  { label: 'Last hour', value: 3600_000 },
  { label: 'Last 6 hours', value: 6 * 3600_000 },
  { label: 'Last 24 hours', value: 24 * 3600_000 },
  { label: 'Last 3 days', value: 3 * 24 * 3600_000 },
  { label: 'Last 7 days', value: 7 * 24 * 3600_000 },
  { label: 'Last 14 days', value: 14 * 24 * 3600_000 },
];

type Row = SessionSummary & { id: string; live: boolean; matched: boolean };

/** How long typing has to pause before the search fields are looked up. */
const SEARCH_DEBOUNCE_MS = 400;
/** Matching sessions fetched one by one when the list (its marker limit) did not include them. */
const MAX_EXTRA_MATCHES = 25;
const DEFAULT_LOOKBACK = 24 * 3600_000;

/** Sessions the search fields matched: for which value, and which sessions. */
interface Matches {
  key: string;
  ids: Set<string>;
  extra: SessionSummary[];
  failure?: string;
}

function lookbackParam(value: string | null): number {
  const parsed = Number(value);
  return LOOKBACKS.some((option) => option.value === parsed) ? parsed : DEFAULT_LOOKBACK;
}

function appsParam(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

interface QueryResult {
  key: string;
  nowMs: number;
  sessions: SessionSummary[];
  truncated?: boolean;
  errors: Map<string, number>;
  active: Set<string>;
  failure?: string;
}

function SessionsPage() {
  const styles = useStyles2(getStyles);
  const { lokiUid, searchFields } = useSettings();
  // Search, apps and range are in the URL, so a link (e.g. from the CRM) can open a search.
  const [params, setParams] = useSearchParams();
  const [lookback, setLookbackState] = useState<number>(() => lookbackParam(params.get('lookback')));
  const [apps, setAppsState] = useState<string[]>(() => appsParam(params.get('apps')));
  const [appOptions, setAppOptions] = useState<Array<ComboboxOption<string>>>([]);
  const [environment, setEnvironment] = useState<string | undefined>();
  const [search, setSearchState] = useState(() => searchParam(params.get('q')));
  const [result, setResult] = useState<QueryResult>();
  const [matches, setMatches] = useState<Matches>();

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
  const setSearch = (value: string) => {
    setSearchState(value);
    remember('q', value.trim() || undefined);
  };
  const setApps = (value: string[]) => {
    setAppsState(value);
    remember('apps', value.join(',') || undefined);
  };
  const setLookback = (value: number) => {
    setLookbackState(value);
    remember('lookback', value === DEFAULT_LOOKBACK ? undefined : String(value));
  };

  const lookup = searchValue(search);
  const matchKey = JSON.stringify({ lokiUid, apps, lookback, lookup, searchFields });

  const queryKey = JSON.stringify({ lokiUid, apps, lookback });
  const loading = result?.key !== queryKey;
  const sessions = useMemo(() => result?.sessions ?? [], [result]);
  const errors = useMemo(() => result?.errors ?? new Map<string, number>(), [result]);
  const active = useMemo(() => result?.active ?? new Set<string>(), [result]);
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
      fetchActiveSessionIds(lokiUid, apps, now, LIVE_WINDOW_MS).catch(() => new Set<string>()),
    ])
      .then(([found, errorCounts, active]) => {
        if (!cancelled) {
          setResult({
            key,
            nowMs: now,
            sessions: found.sessions,
            truncated: found.truncated,
            errors: errorCounts,
            active,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const failureText = (error as { data?: { message?: string } })?.data?.message ?? String(error);
          setResult({ key, nowMs: now, sessions: [], errors: new Map(), active: new Set(), failure: failureText });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [lokiUid, apps, lookback]);

  // The search fields, looked up on the server once typing pauses.
  useEffect(() => {
    if (!lookup || searchFields.length === 0) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const now = Date.now();
      fetchMatchingSessionIds(lokiUid, searchFields, lookup, apps, now - lookback, now)
        .then(async (ids) => {
          const listed = new Set(sessions.map((session) => session.sessionId));
          const missing = [...ids].filter((id) => !listed.has(id)).slice(0, MAX_EXTRA_MATCHES);
          const extra = await Promise.all(
            missing.map((id) =>
              fetchSessions(lokiUid, apps, now - lookback, now, 100, id).then((found) => found.sessions)
            )
          );
          if (!cancelled) {
            setMatches({ key: matchKey, ids, extra: extra.flat() });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            const failureText = (error as { data?: { message?: string } })?.data?.message ?? String(error);
            setMatches({ key: matchKey, ids: new Set(), extra: [], failure: failureText });
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lokiUid, apps, lookback, lookup, searchFields, matchKey, sessions]);

  const currentMatches = matches?.key === matchKey ? matches : undefined;
  const matchedIds = useMemo(() => currentMatches?.ids ?? new Set<string>(), [currentMatches]);

  const environments = useMemo(
    () => [...new Set(sessions.map((session) => session.environment).filter(Boolean))].sort(),
    [sessions]
  );

  const rows = useMemo<Row[]>(() => {
    const listed = new Set(sessions.map((session) => session.sessionId));
    const all = [...sessions, ...(currentMatches?.extra ?? []).filter((session) => !listed.has(session.sessionId))];
    return all
      .filter((session) => !environment || session.environment === environment)
      .filter((session) => matchedIds.has(session.sessionId) || matchesSearch(session, search))
      .map((session) => ({
        ...session,
        id: session.sessionId,
        errors: errors.get(session.sessionId) ?? 0,
        live: active.has(session.sessionId),
        matched: matchedIds.has(session.sessionId),
      }))
      .sort((a, b) => Number(b.matched) - Number(a.matched) || b.startedMs - a.startedMs);
  }, [sessions, currentMatches, environment, search, matchedIds, errors, active]);

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
        cell: ({ row }) => (
          <Stack gap={1} alignItems="center">
            <code>{row.original.sessionId}</code>
            {row.original.matched && (
              <Tooltip content="An event of this session carries the searched value (e.g. the lead)">
                <span>
                  <Badge text="Match" color="green" icon="search" />
                </span>
              </Tooltip>
            )}
          </Stack>
        ),
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
          <Stack gap={1}>
            <LinkButton
              size="sm"
              icon="play"
              variant="secondary"
              href={replayUrl(row.original.appName, row.original.sessionId, {
                ...sessionRange(row.original, nowMs),
                q: row.original.matched ? lookup : undefined,
              })}
            >
              Replay
            </LinkButton>
            {row.original.live && (
              <LinkButton
                size="sm"
                icon="circle-mono"
                variant="destructive"
                tooltip="Recording right now: follow it live"
                href={replayUrl(row.original.appName, row.original.sessionId, {
                  ...sessionRange(row.original, nowMs),
                  live: true,
                })}
              >
                Live
              </LinkButton>
            )}
          </Stack>
        ),
      },
    ],
    [nowMs, lookup]
  );

  return (
    <PluginPage>
      <div data-testid={testIds.sessions.container} className={styles.page}>
        <Stack gap={1} wrap="wrap" alignItems="center">
          <div className={styles.search}>
            <FilterInput
              placeholder={
                searchFields.length > 0
                  ? `Search session, user, page, browser, or ${searchFields.join(' / ')}…`
                  : 'Search session, user, page, browser…'
              }
              value={search}
              onChange={setSearch}
              // The text is searched as typed: a lead id, user or email, never a regex. With the
              // default (true) a typed `cc90db97-dce5-…` would arrive as `cc90db97\-dce5\-…`.
              escapeRegex={false}
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

        {!loading && result?.truncated && (
          <Alert severity="warning" title="Not all sessions are listed">
            The range holds more recordings than one query returns; only the newest are shown. Pick a shorter range or
            filter by app.
          </Alert>
        )}
        {currentMatches?.failure && (
          <Alert severity="warning" title={`Could not search ${searchFields.join(' / ')}`}>
            {currentMatches.failure}
          </Alert>
        )}
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
