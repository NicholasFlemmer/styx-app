import type { ProjectId } from '../ids';
import { copy } from '../copy';
import { AGENT_LABEL, PROVIDER_LABEL } from '../model/common';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { liveSessions, projectBranch } from './common';
import { formatAge } from './format';
import { navLanes, type NavLane } from './lanes';
import { fill } from '../copy';

export interface HomeActivityRow {
  id: string;
  /** "2m" · "1h" · "1d" */
  t: string;
  who: string;
  what: string;
  at: number;
}

/** Home → Activity feed, newest first. */
export const homeActivity = (model: ReadModel, now: number): HomeActivityRow[] =>
  [...model.activity]
    .sort((a, b) => b.at - a.at)
    .map((r) => ({ id: r.id, t: formatAge(r.at, now), who: r.who, what: r.what, at: r.at }));

export interface HomeProjectRow {
  projectId: ProjectId;
  name: string;
  initials: string;
  path: string;
  branch: string;
  /** Any live needs-you session → accent status square. */
  needs: boolean;
  /** "Claude, Codex, Gemini" (non-done sessions, spawn order) or "—". */
  agents: string;
  /** "Vercel, Supabase, AWS, GitHub" (provider labels, deduped) or "—". */
  targets: string;
  /** "2m" · "1h" · "2d" · "—" */
  last: string;
  /** The project's lanes that have not landed, most urgent first (ADR-0027): what the row shows instead of names. */
  lanes: NavLane[];
}

const joinOrDash = (parts: readonly string[]): string =>
  parts.length === 0 ? copy.general.none : parts.join(', ');

/** Home → project table rows, in rail order. */
export const homeProjectRows = (model: ReadModel, now: number): HomeProjectRow[] => {
  const sessions = liveSessions(model);
  const targets = rows(model.targets);
  return rows(model.projects)
    .filter((p) => p.removedAt === null)
    .sort((a, b) => a.railOrder - b.railOrder)
    .map((p) => {
      const own = sessions.filter((s) => s.projectId === p.id);
      const agents = own
        .filter((s) => s.state !== 'done')
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((s) => AGENT_LABEL[s.agent]);
      const providers = [
        ...new Set(targets.filter((t) => t.projectId === p.id).map((t) => PROVIDER_LABEL[t.provider])),
      ];
      return {
        projectId: p.id,
        name: p.name,
        initials: p.initials,
        path: p.path,
        branch: projectBranch(model, p.id),
        needs: own.some((s) => s.state === 'needs-you'),
        agents: joinOrDash(agents),
        targets: joinOrDash(providers),
        last: formatAge(p.lastActivityAt, now),
        lanes: navLanes(model, p.id, now).filter((l) => l.status !== 'landed' && l.status !== 'finished'),
      };
    });
};

/** "Good morning, Nic" from the local hour and the account's first name; "All projects" with no name. */
export const homeGreeting = (hour: number, name: string | null): string => {
  const first = name?.trim().split(/\s+/)[0] ?? '';
  if (first === '') return copy.home.title;
  const g =
    hour < 12
      ? copy.home.greeting.morning
      : hour < 18
        ? copy.home.greeting.afternoon
        : copy.home.greeting.evening;
  return fill(copy.home.greetingNamed, { greeting: g, name: first });
};

/** "2 things need you. 3 agents are working." */
export const homeSummary = (needs: number, working: number): string => {
  const s = copy.home.summary;
  const a = needs === 0 ? s.nothingNeeds : needs === 1 ? s.needsOne : fill(s.needs, { n: needs });
  const b = working === 0 ? s.quiet : working === 1 ? s.workingOne : fill(s.working, { n: working });
  return `${a} ${b}`;
};
