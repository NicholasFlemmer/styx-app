import { copy, fill } from '../copy';
import type { ProjectId, SessionId, WorktreeId } from '../ids';
import { AGENT_LABEL, type Agent } from '../model/common';
import type { Worktree } from '../model/project';
import type { Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { formatAge } from './format';

/**
 * Lanes that know about each other (owner addition, ADR-0025): what one lane is doing, said in a line, for the
 * other agents' prompts and tools, the Spawn modal and the Repo rows.
 */

/**
 * The lane's landing verb (ADR-0025 phase C), by the project's merging mode: `Land` in auto, `Merge into {base}`
 * in review. `null` when there is nothing to land — main itself, a lane on no branch, a conflicted lane, one
 * already merged, or one an agent is mid-merge on. Shared by the Repo row and the workspace's Land button
 * (owner request, discrepancy #111: landing must not live only on the Repo tab).
 */
export const landLabelOf = (
  w: Pick<Worktree, 'branch' | 'isMain' | 'conflict' | 'mergedAt' | 'resolution'>,
  integration: 'auto' | 'review',
  base: string,
): string | null => {
  if (w.isMain || w.branch === null || w.conflict !== null || w.mergedAt !== null) return null;
  if (w.resolution !== null && (w.resolution.state === 'resolving' || w.resolution.state === 'checking'))
    return null;
  return integration === 'auto' ? copy.repo.actions.land : fill(copy.repo.actions.mergeIntoBase, { base });
};

/** A task line is one line, at most this long, so a pasted essay does not become the whole prompt. */
export const TASK_MAX = 140;

/** The lane's task: the first line of what the user asked, else the agent's latest `report_status` note. */
export const taskOf = (session: Pick<Session, 'firstMessage' | 'note'>): string => {
  const first =
    session.firstMessage
      ?.split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  const text = first !== '' ? first : (session.note ?? '').trim();
  return text.length > TASK_MAX ? `${text.slice(0, TASK_MAX - 1).trimEnd()}…` : text;
};

export interface ActiveLane {
  sessionId: SessionId;
  worktreeId: WorktreeId;
  agent: string;
  branch: string;
  task: string;
  /** Files changed against the base as the last hunk scan counted them. */
  files: number;
  state: Session['state'];
}

/**
 * The live lanes of a project: an agent session that is not done, on a worktree that is not main. `except` drops
 * the caller's own lane. Spawn order, like the chat tabs.
 */
export const activeLanes = (
  model: ReadModel,
  projectId: ProjectId,
  except: WorktreeId | null = null,
): ActiveLane[] => {
  const out: ActiveLane[] = [];
  for (const s of rows(model.sessions)) {
    if (s.projectId !== projectId || s.archivedAt !== null || s.state === 'done' || s.purpose) continue;
    const w = model.worktrees.byId[s.worktreeId];
    if (w === undefined || w.isMain || w.archivedAt !== null || w.branch === null || w.id === except)
      continue;
    out.push({
      sessionId: s.id,
      worktreeId: w.id,
      agent: AGENT_LABEL[s.agent],
      branch: w.branch,
      task: taskOf(s),
      files: w.changes.files,
      state: s.state,
    });
  }
  return out.sort((a, b) => {
    const sa = model.sessions.byId[a.sessionId]?.startedAt ?? 0;
    const sb = model.sessions.byId[b.sessionId]?.startedAt ?? 0;
    return sa - sb;
  });
};

/** Whose move a lane is, for the project nav (ADR-0027 §1), in the order the nav lists them. */
export type NavLaneStatus = 'your-turn' | 'working' | 'idle' | 'paused' | 'ready' | 'landed';
const NAV_RANK: Record<NavLaneStatus, number> = {
  'your-turn': 0,
  working: 1,
  idle: 2,
  paused: 3,
  ready: 4,
  landed: 5,
};

export interface NavLane {
  sessionId: SessionId;
  worktreeId: WorktreeId;
  agent: Agent;
  /** The task line; the agent's name with "no task yet" when the session has none. */
  task: string;
  status: NavLaneStatus;
  statusLabel: string;
}

const navStatusOf = (s: Session, w: Worktree | undefined): NavLaneStatus => {
  switch (s.state) {
    case 'needs-you':
      return 'your-turn';
    case 'working':
      return 'working';
    case 'idle':
      return 'idle';
    case 'paused':
      return 'paused';
    case 'done':
      return w !== undefined && w.mergedAt !== null ? 'landed' : 'ready';
  }
};

/**
 * The project nav's work list (ADR-0027 §1): every chat session of the project that is not archived, by whose
 * move it is (your turn, working, waiting, paused, ready to land, landed), most recently active first within
 * each. Background tasks (`purpose`) are not work the person started, so they stay on the Tasks rail.
 */
export const navLanes = (model: ReadModel, projectId: ProjectId, now: number): NavLane[] => {
  const out: { lane: NavLane; at: number }[] = [];
  for (const s of rows(model.sessions)) {
    if (s.projectId !== projectId || s.archivedAt !== null || s.purpose) continue;
    const w = model.worktrees.byId[s.worktreeId];
    const status = navStatusOf(s, w);
    const task = taskOf(s);
    const at = s.lastActivityAt ?? s.startedAt;
    const age = formatAge(status === 'landed' ? (w?.mergedAt ?? at) : at, now);
    out.push({
      lane: {
        sessionId: s.id,
        worktreeId: s.worktreeId,
        agent: s.agent,
        task: task === '' ? fill(copy.lanes.nav.untitled, { agent: AGENT_LABEL[s.agent] }) : task,
        status,
        statusLabel: fill(copy.lanes.nav.status[status], { age }),
      },
      at,
    });
  }
  return out
    .sort((a, b) => NAV_RANK[a.lane.status] - NAV_RANK[b.lane.status] || b.at - a.at)
    .map((x) => x.lane);
};

/** "3 lanes" / "1 lane". */
export const navLanesLabel = (n: number): string =>
  n === 1 ? copy.lanes.nav.countOne : fill(copy.lanes.nav.count, { n });

/** "Claude on agent/claude-1 · 7 files · refuse a wrong Locate binary pick" */
export const laneLine = (lane: Pick<ActiveLane, 'agent' | 'branch' | 'files' | 'task'>): string =>
  fill(copy.lanes.line, {
    agent: lane.agent,
    branch: lane.branch,
    files: lane.files,
    task: lane.task === '' ? copy.lanes.noTask : lane.task,
  });

/** "2 lanes active" / "1 lane active". */
export const activeLanesLabel = (n: number): string =>
  n === 1 ? copy.lanes.activeOne : fill(copy.lanes.active, { n });

/** What the Repo row says about a lane's overlaps: the other branches, and the files behind them (title). */
export const laneOverlapSummary = (
  model: ReadModel,
  worktree: Pick<Worktree, 'overlaps'>,
): { branches: string[]; files: string[] } | null => {
  const branches: string[] = [];
  const files = new Set<string>();
  for (const o of worktree.overlaps) {
    const other = model.worktrees.byId[o.worktreeId];
    if (other === undefined || other.archivedAt !== null || other.branch === null) continue;
    branches.push(other.branch);
    for (const f of o.files) files.add(f);
  }
  return branches.length === 0 ? null : { branches, files: [...files].sort() };
};

// --- Hotspots -----------------------------------------------------------------

/**
 * Files one lane should own at a time when nothing is configured: the places the research names as collision
 * hotspots (registries, config, lockfiles, migrations) plus this repo's own append-only documents. Globs, matched
 * against the repo-relative path with `**` spanning directories.
 */
export const DEFAULT_HOTSPOTS: readonly string[] = [
  'package.json',
  '**/package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '**/migrations/**',
  '**/copy.ts',
  '**/routes.*',
  '**/router.*',
  '**/registry.*',
  'docs/handoff-discrepancies.md',
];

/** A glob (`*`, `**`, `?`) as a regular expression over a `/`-separated path. */
export const globToRegExp = (glob: string): RegExp => {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans zero or more directories; a trailing `**` spans the rest.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c !== undefined) out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
};

/** True when the path matches one of the globs (the project's own list, or the defaults when it is empty). */
export const isHotspot = (file: string, hotspots: readonly string[]): boolean => {
  const globs = hotspots.length === 0 ? DEFAULT_HOTSPOTS : hotspots;
  const path = file.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(g).test(path));
};
