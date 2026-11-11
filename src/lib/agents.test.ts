import { agentDayPath, dayOf, dayQueryRange, groupAgents, matchesAgent, mayReachInto, shiftDay } from './agents';
import type { SessionSummary } from './sessions';

const HOUR = 3600_000;
const day = dayOf('2026-11-11');
const session = (
  sessionId: string,
  userId: string | undefined,
  startedMs: number,
  patch: Partial<SessionSummary> = {}
): SessionSummary => ({
  sessionId,
  appName: 'ppd-leads-frontend',
  environment: 'production',
  userId,
  userName: `Agent ${userId}`,
  startedMs,
  lastStartedMs: startedMs,
  recordings: 1,
  ...patch,
});

describe('agents', () => {
  it('names a local calendar day and its neighbours', () => {
    expect(day.key).toBe('2026-11-11');
    expect(day.endMs - day.startMs).toBe(24 * HOUR);
    expect(new Date(day.startMs).getHours()).toBe(0);
    expect(shiftDay(day, -1).key).toBe('2026-11-10');
    expect(shiftDay(day, 1).key).toBe('2026-11-12');
    expect(dayOf('nonsense', day.startMs + HOUR).key).toBe('2026-11-11');
  });

  it("looks for the day's sessions from 4 h before it (a session begun before midnight), up to now", () => {
    expect(dayQueryRange(day, day.startMs + 10 * HOUR)).toEqual({
      from: day.startMs - 4 * HOUR,
      to: day.startMs + 10 * HOUR,
    });
    expect(mayReachInto(session('a', '1', day.startMs - HOUR), day)).toBe(true);
    expect(mayReachInto(session('b', '1', day.startMs - 5 * HOUR), day)).toBe(false);
    expect(mayReachInto(session('c', '1', day.endMs + HOUR), day)).toBe(false);
  });

  it('groups sessions by app and user, newest activity first, sessions newest first', () => {
    const agents = groupAgents(
      [
        session('a1', '7', day.startMs + 8 * HOUR),
        session('a2', '7', day.startMs + 12 * HOUR, { userName: 'Renamed' }),
        session('b1', '9', day.startMs + 9 * HOUR),
        session('c1', '7', day.startMs + 10 * HOUR, { appName: 'ppd-sales-frontend' }),
        session('anon', undefined, day.startMs + 11 * HOUR),
        session('old', '9', day.startMs - 6 * HOUR),
      ],
      day
    );

    expect(agents.map((agent) => agent.key)).toEqual([
      'ppd-leads-frontend/7',
      'ppd-sales-frontend/7',
      'ppd-leads-frontend/9',
    ]);
    expect(agents[0].sessions.map((s) => s.sessionId)).toEqual(['a2', 'a1']);
    expect(agents[0].userName).toBe('Renamed');
    expect(agents[0].firstMs).toBe(day.startMs + 8 * HOUR);
    expect(agents[2].sessions.map((s) => s.sessionId)).toEqual(['b1']);
  });

  it('counts a session begun before the day from the day start', () => {
    const [agent] = groupAgents([session('night', '7', day.startMs - HOUR)], day);
    expect(agent.firstMs).toBe(day.startMs);
  });

  it('searches name, email, id and app', () => {
    const [agent] = groupAgents([session('a', '7', day.startMs + HOUR, { userEmail: 'Jane@Example.com' })], day);
    expect(matchesAgent(agent, 'jane@')).toBe(true);
    expect(matchesAgent(agent, ' 7 ')).toBe(true);
    expect(matchesAgent(agent, 'leads')).toBe(true);
    expect(matchesAgent(agent, 'nobody')).toBe(false);
  });

  it("links to an agent's day", () => {
    expect(agentDayPath('ppd-leads-frontend', '7', '2026-11-11', { at: 1.6, live: true, q: 'x y' })).toBe(
      'agents/ppd-leads-frontend/7?day=2026-11-11&at=2&live=1&q=x+y'
    );
  });
});
