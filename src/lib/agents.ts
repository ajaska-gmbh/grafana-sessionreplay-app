import { MAX_SESSION_MS } from '../constants';
import type { SessionSummary } from './sessions';

/**
 * Agents and their day. An agent is a user of one app (a dialer instance):
 * user ids are the app's own, so the same person on two dialers is two agents.
 * Everything here works on the sessions the recording-start markers give
 * (summariseSessions); what an agent did when is the replay index's business
 * (see agentDay).
 */

export interface Agent {
  /** `<appName>/<userId>`, unique. */
  key: string;
  appName: string;
  environment: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  /** The agent's sessions that may reach into the day, newest first. */
  sessions: SessionSummary[];
  /** First recording start in the day (epoch ms); a session begun before the day counts from the day's start. */
  firstMs: number;
  /** Latest recording (re)start (epoch ms). */
  lastStartedMs: number;
}

/** A local calendar day, from midnight to midnight, as `YYYY-MM-DD` (the browser's time zone). */
export interface Day {
  key: string;
  startMs: number;
  endMs: number;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The day `key` names (today when missing or invalid), in the browser's time zone. */
export function dayOf(key: string | null | undefined, nowMs = Date.now()): Day {
  const match = key ? DAY_KEY.exec(key) : null;
  const start = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : (() => {
        const now = new Date(nowMs);
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      })();
  if (Number.isNaN(start.getTime())) {
    return dayOf(undefined, nowMs);
  }
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

/** The day before or after (handles DST: always the next calendar day). */
export function shiftDay(day: Day, by: number): Day {
  const start = new Date(day.startMs);
  const shifted = new Date(start.getFullYear(), start.getMonth(), start.getDate() + by);
  const pad = (n: number) => String(n).padStart(2, '0');
  return dayOf(`${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`);
}

/**
 * Where to look for the day's sessions: Faro sessions last up to
 * MAX_SESSION_MS, so one recorded into the day may have started that long
 * before it (its markers are only written on page loads).
 */
export function dayQueryRange(day: Day, nowMs = Date.now()): { from: number; to: number } {
  return { from: day.startMs - MAX_SESSION_MS, to: Math.min(day.endMs, nowMs) };
}

/** Whether a session may have been recorded within the day: begun in it, or begun before and not yet over. */
export function mayReachInto(session: SessionSummary, day: Day): boolean {
  return session.startedMs < day.endMs && session.lastStartedMs + MAX_SESSION_MS > day.startMs;
}

export function agentKey(appName: string, userId: string): string {
  return `${appName}/${userId}`;
}

/** The day's agents: sessions with a user, grouped by app and user id, newest activity first. */
export function groupAgents(sessions: SessionSummary[], day: Day): Agent[] {
  const agents = new Map<string, Agent>();
  for (const session of sessions) {
    if (!session.userId || !mayReachInto(session, day)) {
      continue;
    }
    const key = agentKey(session.appName, session.userId);
    const agent = agents.get(key);
    const firstMs = Math.max(session.startedMs, day.startMs);
    if (!agent) {
      agents.set(key, {
        key,
        appName: session.appName,
        environment: session.environment,
        userId: session.userId,
        userName: session.userName,
        userEmail: session.userEmail,
        sessions: [session],
        firstMs,
        lastStartedMs: session.lastStartedMs,
      });
      continue;
    }
    agent.sessions.push(session);
    agent.firstMs = Math.min(agent.firstMs, firstMs);
    if (session.lastStartedMs > agent.lastStartedMs) {
      agent.lastStartedMs = session.lastStartedMs;
      // The newest session's names are the current ones.
      agent.userName = session.userName ?? agent.userName;
      agent.userEmail = session.userEmail ?? agent.userEmail;
    }
  }
  for (const agent of agents.values()) {
    agent.sessions.sort((a, b) => b.startedMs - a.startedMs);
  }
  return [...agents.values()].sort((a, b) => b.lastStartedMs - a.lastStartedMs);
}

/** Search over agents: name, email or user id, case-insensitive. */
export function matchesAgent(agent: Agent, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [agent.userName, agent.userEmail, agent.userId, agent.appName].some((value) =>
    value?.toLowerCase().includes(needle)
  );
}

/** The agents page link to an agent's day. */
export function agentDayPath(
  appName: string,
  userId: string,
  day?: string,
  options: { at?: number; live?: boolean; q?: string } = {}
): string {
  const params = new URLSearchParams();
  if (day) {
    params.set('day', day);
  }
  if (options.at !== undefined) {
    params.set('at', String(Math.round(options.at)));
  }
  if (options.live) {
    params.set('live', '1');
  }
  if (options.q) {
    params.set('q', options.q);
  }
  const query = params.toString();
  return `agents/${encodeURIComponent(appName)}/${encodeURIComponent(userId)}${query ? `?${query}` : ''}`;
}
