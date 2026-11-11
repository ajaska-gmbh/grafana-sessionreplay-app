import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { css } from '@emotion/css';
import { dateTimeFormat, GrafanaTheme2 } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, Button, LinkButton, LoadingPlaceholder, Stack, useStyles2 } from '@grafana/ui';
import { DayPicker } from '../components/AgentDay/DayPicker';
import { DayTimeline } from '../components/AgentDay/DayTimeline';
import { SessionReplay } from '../components/SessionReplay/SessionReplay';
import { testIds } from '../components/testIds';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { useAgentDay } from '../hooks/useAgentDay';
import { useSettings } from '../hooks/useSettings';
import { after, dayExtent, playAt, type DaySpan } from '../lib/agentDay';
import { agentDayPath, dayOf } from '../lib/agents';
import { replayUrl } from '../lib/format';
import { PlayerClock, useClockEffect } from '../lib/playerClock';
import { searchParam } from '../lib/sessionSearch';
import { sessionRange } from '../lib/sessions';

/** Moving on this close before a span's end: its last events are usually a page going away. */
const END_MARGIN_MS = 500;

/** The time, refreshed every minute: session ranges for today grow with it. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** What plays: a session of the day, from where, and whether to start at once. */
interface Playing {
  span: DaySpan;
  atMs: number;
  /** The session's Loki range, fixed when it starts playing: a changing range reloads the session. */
  range: { from: number; to: number };
  autoPlay: boolean;
  live: boolean;
  /** A new value remounts the player (a seek on the day's timeline). */
  nonce: number;
}

/**
 * `/agents/<app>/<user_id>?day=YYYY-MM-DD&at=<ms>&live=1&q=`: the agent's day as
 * one timeline. One session plays at a time (the replay as everywhere else);
 * at its end the day moves on to the next, over the time the agent was not
 * in the app.
 */
function AgentDayPage() {
  const styles = useStyles2(getStyles);
  const { appName = '', userId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const day = useMemo(() => dayOf(params.get('day')), [params]);
  const highlight = searchParam(params.get('q')) || undefined;
  const { lokiUid, tempoUid, searchFields, recorder, payloadBuckets } = useSettings();
  const data = useAgentDay({ lokiUid, appName, userId, day, payloadBuckets });
  const [clock] = useState(() => new PlayerClock());
  const now = useMinute();
  const nonce = useRef(0);

  // What plays belongs to one agent and day: another one starts afresh
  // (React's "adjust state when an input changes").
  const scope = `${appName}/${userId}/${day.key}`;
  const [playingState, setPlayingState] = useState<{ scope: string; playing?: Playing }>({ scope });
  if (playingState.scope !== scope) {
    setPlayingState({ scope });
  }
  const playing = playingState.scope === scope ? playingState.playing : undefined;

  const extent = useMemo(() => dayExtent(data.spans, day), [data.spans, day]);
  const newest = data.spans.length > 0 ? data.spans[data.spans.length - 1] : undefined;
  const liveSession = data.spans
    .slice()
    .reverse()
    .find((span) => data.active.has(span.session.sessionId));
  const agent = newest?.session;

  /** Play `span` from `atMs`. The shared clock is cleared, so nothing reads the previous session's time. */
  const play = useCallback(
    (span: DaySpan, atMs: number, options: { autoPlay?: boolean; live?: boolean } = {}) => {
      clock.update({ startTimeMs: undefined, offsetMs: 0, totalMs: 0, playing: false });
      setPlayingState({
        scope,
        playing: {
          span,
          atMs,
          range: sessionRange(span.session, Date.now()),
          autoPlay: options.autoPlay ?? true,
          live: Boolean(options.live),
          nonce: ++nonce.current,
        },
      });
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete('live');
          next.set('at', String(Math.round(atMs)));
          if (options.live) {
            next.set('live', '1');
          }
          return next;
        },
        { replace: true }
      );
    },
    [clock, scope, setParams]
  );
  /** Play from a time of the day: the session there, or the next one after a gap. */
  const go = useCallback(
    (atMs: number) => {
      const target = playAt(data.spans, atMs);
      if (target) {
        play(target.span, target.atMs);
      }
    },
    [data.spans, play]
  );

  // Where the day starts, once there is something to play: the link's time,
  // live, the searched lead's first call, or the day's start. Later refreshes
  // of the day (today) do not move it.
  const hasSpans = data.spans.length > 0;
  const initial = useMemo((): Playing | undefined => {
    if (!hasSpans) {
      return undefined;
    }
    const range = (span: DaySpan) => sessionRange(span.session, now);
    if (params.get('live') === '1' && liveSession) {
      return {
        span: liveSession,
        atMs: liveSession.endMs,
        range: range(liveSession),
        autoPlay: true,
        live: true,
        nonce: 0,
      };
    }
    const at = Number(params.get('at'));
    const matched = highlight
      ? data.calls.find((call) => call.leadId === highlight || call.crmLeadId === highlight)
      : undefined;
    const target = playAt(data.spans, Number.isFinite(at) && at > 0 ? at : (matched?.atMs ?? data.spans[0].startMs));
    return target ? { ...target, range: range(target.span), autoPlay: false, live: false, nonce: 0 } : undefined;
    // Decided once per agent and day, when the first spans arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSpans, scope]);
  const current = playing ?? initial;

  // At the end of a session (its last tab, or the span), on to the next one,
  // or the session still running then. Only once the clock is this session's
  // (play() clears it) and after it was playing.
  const wasPlaying = useRef(false);
  /** The playback already moved on from (session and nonce): a late frame of it must not move on twice. */
  const advancedFrom = useRef<string | undefined>(undefined);
  useClockEffect(clock, (state) => {
    if (!current || current.live || state.startTimeMs === undefined) {
      wasPlaying.current = false;
      return;
    }
    const wallMs = state.startTimeMs + state.offsetMs;
    const ended =
      (state.playing && wallMs >= current.span.endMs - END_MARGIN_MS) ||
      (wasPlaying.current && !state.playing && state.totalMs > 0 && state.offsetMs >= state.totalMs - END_MARGIN_MS);
    wasPlaying.current = state.playing;
    const from = `${current.span.session.sessionId}|${current.nonce}`;
    if (ended && wallMs >= current.span.startMs && advancedFrom.current !== from) {
      const next = after(data.spans, current.span);
      if (next) {
        advancedFrom.current = from;
        wasPlaying.current = false;
        play(next.span, next.atMs);
      }
    }
  });

  const name = agent?.userName || agent?.userEmail || `User ${userId}`;

  return (
    <PluginPage
      pageNav={{ text: name, subTitle: `${appName} · ${dateTimeFormat(day.startMs, { format: 'dddd, YYYY-MM-DD' })}` }}
      actions={
        <LinkButton variant="secondary" icon="arrow-left" href={`${PLUGIN_BASE_URL}/${ROUTES.Agents}?day=${day.key}`}>
          All agents
        </LinkButton>
      }
    >
      <div className={styles.page} data-testid={testIds.agentDay.container}>
        <Stack gap={2} alignItems="center" wrap="wrap">
          <DayPicker
            day={day}
            onChange={(next) => {
              setParams(new URLSearchParams(next.key === dayOf(undefined).key ? {} : { day: next.key }));
            }}
          />
          {liveSession && (
            <Button
              size="sm"
              variant="destructive"
              icon="circle-mono"
              onClick={() => play(liveSession, liveSession.endMs, { live: true })}
              disabled={current?.live}
            >
              {current?.live ? 'Following live' : 'Go live'}
            </Button>
          )}
          {current && (
            <span className={styles.note}>
              Session {current.span.session.sessionId} ·{' '}
              <a
                href={`${PLUGIN_BASE_URL}/${replayUrl(appName, current.span.session.sessionId, sessionRange(current.span.session, now))}`}
              >
                open on its own
              </a>
            </span>
          )}
        </Stack>

        {data.error && (
          <Alert severity="error" title="Could not load the agent's day">
            {data.error}
          </Alert>
        )}
        {data.loading ? (
          <LoadingPlaceholder text="Loading the agent's day…" />
        ) : !extent ? (
          <div className={styles.note}>No recorded session of this agent on this day.</div>
        ) : (
          <>
            <DayTimeline
              spans={data.spans}
              calls={data.calls}
              extent={extent}
              clockOffsetMs={data.clockOffsetMs}
              currentSessionId={current?.span.session.sessionId}
              clock={clock}
              highlight={highlight}
              onSeek={(atMs) => go(atMs)}
            />
            {current && (
              <div className={styles.player}>
                <SessionReplay
                  key={`${current.span.session.sessionId}|${current.nonce}|${current.live ? 'live' : 'replay'}`}
                  appName={appName}
                  sessionId={current.span.session.sessionId}
                  from={current.range.from}
                  to={current.range.to}
                  atMs={current.live ? undefined : current.atMs}
                  autoPlay={current.autoPlay}
                  live={current.live}
                  clock={clock}
                  onExitLive={() => play(current.span, current.span.endMs, { autoPlay: false })}
                  highlight={highlight}
                  searchFields={searchFields}
                  recorder={recorder}
                  payloadBuckets={payloadBuckets}
                  lokiUid={lokiUid}
                  tempoUid={tempoUid}
                />
              </div>
            )}
            <div className={styles.sessions}>
              <div className={styles.note}>Sessions of the day, newest first:</div>
              {data.spans
                .slice()
                .reverse()
                .map((span) => (
                  <Stack key={span.session.sessionId} gap={1} alignItems="center">
                    <Button
                      size="sm"
                      variant={span.session.sessionId === current?.span.session.sessionId ? 'primary' : 'secondary'}
                      fill="text"
                      onClick={() => play(span, span.startMs)}
                    >
                      {dateTimeFormat(span.startMs + data.clockOffsetMs, { format: 'HH:mm' })} –{' '}
                      {dateTimeFormat(span.endMs + data.clockOffsetMs, { format: 'HH:mm' })}
                    </Button>
                    <span className={styles.note}>
                      {data.calls.filter((call) => call.sessionId === span.session.sessionId).length} calls
                    </span>
                    {data.active.has(span.session.sessionId) && <Badge text="Live" color="red" />}
                  </Stack>
                ))}
            </div>
          </>
        )}
      </div>
    </PluginPage>
  );
}

export default AgentDayPage;

/** Link to an agent's day from elsewhere (e.g. a session). */
export function agentDayHref(appName: string, userId: string, day?: string): string {
  return `${PLUGIN_BASE_URL}/${agentDayPath(appName, userId, day)}`;
}

const getStyles = (theme: GrafanaTheme2) => ({
  page: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(2) }),
  player: css({ height: 'calc(100vh - 330px)', minHeight: 560 }),
  note: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  sessions: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.5) }),
});
