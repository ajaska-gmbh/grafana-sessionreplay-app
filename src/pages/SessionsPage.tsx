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
  Icon,
  InlineSwitch,
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
  fetchFrustrationCounts,
  fetchMatchingSessionIds,
  fetchOutcomes,
  fetchSessions,
} from '../lib/sessionQueries';
import { searchParam, searchValue } from '../lib/sessionSearch';
import { FUNNEL_STEPS, STEP_LABELS } from '../lib/insights';
import { LIVE_WINDOW_MS } from '../lib/sessionStore';
import { matchesSearch, sessionRange, type SessionSummary } from '../lib/sessions';
import { testIds } from '../components/testIds';
import { errorText } from '../lib/errors';

const LOOKBACKS: Array<ComboboxOption<number>> = [
  { label: 'Last hour', value: 3600_000 },
  { label: 'Last 6 hours', value: 6 * 3600_000 },
  { label: 'Last 24 hours', value: 24 * 3600_000 },
  { label: 'Last 3 days', value: 3 * 24 * 3600_000 },
  { label: 'Last 7 days', value: 7 * 24 * 3600_000 },
  { label: 'Last 14 days', value: 14 * 24 * 3600_000 },
];

type Row = SessionSummary & {
  id: string;
  live: boolean;
  matched: boolean;
  frustration: number;
  outcome?: string;
  /** For sorting: the outcome's place in the funnel. */
  outcomeRank: number;
};

type Device = 'phone' | 'desktop';
const DEVICES: Array<ComboboxOption<Device>> = [
  { label: 'Phones and tablets', value: 'phone' },
  { label: 'Desktop', value: 'desktop' },
];
/** "Stopped at": the furthest step reached, so "Checkout" lists who reached the checkout and went no further. */
const OUTCOMES: Array<ComboboxOption<string>> = FUNNEL_STEPS.map((step) => ({
  label: `Stopped at: ${STEP_LABELS[step]}`,
  value: step,
}));

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
  frustration: Map<string, number>;
  outcomes: Map<string, string>;
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
  const [outcome, setOutcomeState] = useState<string | undefined>(() => params.get('outcome') ?? undefined);
  const [device, setDeviceState] = useState<Device | undefined>(
    () => DEVICES.find((option) => option.value === params.get('device'))?.value
  );
  const [problemsOnly, setProblemsOnlyState] = useState(() => params.get('problems') === '1');
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
  const setOutcome = (value: string | undefined) => {
    setOutcomeState(value);
    remember('outcome', value);
  };
  const setDevice = (value: Device | undefined) => {
    setDeviceState(value);
    remember('device', value);
  };
  const setProblemsOnly = (value: boolean) => {
    setProblemsOnlyState(value);
    remember('problems', value ? '1' : undefined);
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
  const frustration = useMemo(() => result?.frustration ?? new Map<string, number>(), [result]);
  const outcomes = useMemo(() => result?.outcomes ?? new Map<string, string>(), [result]);
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
      // Optional: apps without the shop's insights have neither; a failure leaves the columns empty.
      fetchFrustrationCounts(lokiUid, apps, now - lookback, now).catch(() => new Map<string, number>()),
      fetchOutcomes(lokiUid, apps, now - lookback, now).catch(() => new Map<string, string>()),
    ])
      .then(([found, errorCounts, active, frustrationCounts, outcomeSteps]) => {
        if (!cancelled) {
          setResult({
            key,
            nowMs: now,
            sessions: found.sessions,
            truncated: found.truncated,
            errors: errorCounts,
            frustration: frustrationCounts,
            outcomes: outcomeSteps,
            active,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const failureText = errorText(error);
          setResult({
            key,
            nowMs: now,
            sessions: [],
            errors: new Map(),
            frustration: new Map(),
            outcomes: new Map(),
            active: new Set(),
            failure: failureText,
          });
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
            const failureText = errorText(error);
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
      .filter((session) => !device || session.mobile === (device === 'phone'))
      .map((session) => {
        const reached = outcomes.get(session.sessionId);
        return {
          ...session,
          id: session.sessionId,
          errors: errors.get(session.sessionId) ?? 0,
          frustration: frustration.get(session.sessionId) ?? 0,
          outcome: reached,
          outcomeRank: reached ? FUNNEL_STEPS.indexOf(reached as never) : -1,
          live: active.has(session.sessionId),
          matched: matchedIds.has(session.sessionId),
        };
      })
      .filter((row) => !outcome || row.outcome === outcome)
      .filter((row) => !problemsOnly || row.frustration > 0 || (row.errors ?? 0) > 0)
      .sort((a, b) => Number(b.matched) - Number(a.matched) || b.startedMs - a.startedMs);
  }, [
    sessions,
    currentMatches,
    environment,
    search,
    matchedIds,
    errors,
    active,
    frustration,
    outcomes,
    outcome,
    device,
    problemsOnly,
  ]);
  const hasInsights = frustration.size > 0 || outcomes.size > 0;

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
        cell: ({ row }) => (
          <Stack gap={0.5} alignItems="center">
            {row.original.mobile && (
              <Tooltip content="Phone or tablet">
                <span aria-label="Phone or tablet" role="img">
                  <Icon name="mobile-android" />
                </span>
              </Tooltip>
            )}
            {[row.original.browser, row.original.os].filter(Boolean).join(' · ') || '–'}
          </Stack>
        ),
      },
      {
        id: 'outcomeRank',
        header: 'Funnel',
        sortType: 'number',
        cell: ({ row }) =>
          row.original.outcome ? (
            <Tooltip content={`Furthest step: ${row.original.outcome}`}>
              <span className={styles.outcome} data-outcome={row.original.outcome}>
                <span className={styles.outcomeDot} />
                {STEP_LABELS[row.original.outcome] ?? row.original.outcome}
              </span>
            </Tooltip>
          ) : (
            ''
          ),
      },
      {
        id: 'frustration',
        header: 'Frustration',
        sortType: 'number',
        cell: ({ row }) =>
          row.original.frustration ? (
            <Tooltip content="Dead, rage and error taps and form errors: open the replay's Insights tab">
              <span>
                <Badge text={String(row.original.frustration)} color="orange" icon="exclamation-circle" />
              </span>
            </Tooltip>
          ) : (
            ''
          ),
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
    [nowMs, lookup, styles]
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
          {(hasInsights || outcome || problemsOnly) && (
            <>
              <Combobox
                width={28}
                placeholder="Any funnel step"
                isClearable
                options={OUTCOMES}
                value={outcome ?? null}
                onChange={(selected) => setOutcome(selected?.value)}
                data-testid={testIds.sessions.outcome}
              />
              <InlineSwitch
                showLabel
                label="With problems only"
                value={problemsOnly}
                onChange={(event) => setProblemsOnly(event.currentTarget.checked)}
                data-testid={testIds.sessions.problems}
              />
            </>
          )}
          <Combobox
            width={24}
            placeholder="All devices"
            isClearable
            options={DEVICES}
            value={device ?? null}
            onChange={(selected) => setDevice(selected?.value)}
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
  outcome: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    '--outcome': theme.colors.text.disabled,
    '&[data-outcome="add_to_cart"], &[data-outcome="initiate_checkout"], &[data-outcome="add_payment_info"]': {
      '--outcome': theme.colors.warning.main,
    },
    '&[data-outcome="checkout_blocked"]': { '--outcome': theme.colors.error.main },
    '&[data-outcome="purchase"]': { '--outcome': theme.colors.success.main },
  }),
  outcomeDot: css({ width: 8, height: 8, borderRadius: '50%', background: 'var(--outcome)' }),
});
