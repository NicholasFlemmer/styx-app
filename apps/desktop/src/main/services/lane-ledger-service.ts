import {
  AGENT_LABEL,
  copy,
  fill,
  isHotspot,
  taskOf,
  type Session,
  type Worktree,
  type WorktreeOverlap,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';
import type { GitService } from './git';
import { logger } from './logger';

export interface LaneLedgerDeps {
  repos: Repos;
  git: GitService;
  publisher: Publisher;
  clock: Clock;
  /** A Styx line for the agent: in the chat now, to the CLI now or with its next turn (`SessionService.tell`). */
  tell: (sessionId: string, text: string) => void;
  /** The project's base branch (`ProjectSettings.baseBranch`). */
  baseOf: (projectId: string) => string;
  /** The project's hotspot globs ([] = `DEFAULT_HOTSPOTS`). */
  hotspotsOf: (projectId: string) => readonly string[];
}

export interface LaneEntry {
  worktree: Worktree;
  session: Session;
}

export interface BaseCommit {
  sha: string;
  subject: string;
  when: number;
  files: string[];
  /** The Styx lane the commit came from, when its subject is a merge of one (`Merge branch 'agent/…'`). */
  lane: { agent: string; branch: string; task: string } | null;
}

export interface LanePeer {
  sessionId: string;
  agent: string;
  branch: string | null;
  task: string;
}

export interface ProjectActivity {
  base: string;
  behind: number;
  baseCommits: BaseCommit[];
  lanes: (LanePeer & { state: string; files: string[] })[];
  overlaps: { file: string; with: LanePeer[] }[];
}

/** A lane's file list is asked for often (every rescan, every `list_sessions`); this long it is not recomputed. */
const FILES_TTL_MS = 5_000;
/** Files named in the spawn prompt per lane, and in one overlap line, before "+n more". */
const PROMPT_FILES_MAX = 12;
const WARN_FILES_MAX = 3;

/**
 * Lanes that know about each other (owner addition, docs/research/lanes-that-know-each-other.md, ADR-0025). The
 * ledger derives, from git and the rows that already exist, what every live lane is doing — its task, the files it
 * changed against the base — and what the base gained since a lane was cut. From that it answers the broker
 * (`list_sessions`, `project_activity`), writes the spawn prompt's "other lanes" block, keeps `Worktree.overlaps`
 * current for the Repo rows, and warns both agents — once per file pair — the moment two lanes have changed the
 * same file. Advisory throughout: it never blocks a write; the research it follows found a warning at write time is
 * what turns a 41 % cross-agent conflict rate into a conversation.
 */
export class LaneLedgerService {
  private readonly files = new Map<string, { at: number; files: string[] }>();
  /** `<worktree>|<other worktree>|<file>` pairs already told to the first lane's agent. */
  private readonly warned = new Set<string>();
  /** One overlap refresh per project at a time; later requests queue behind it. */
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(private readonly deps: LaneLedgerDeps) {}

  /** The live lanes of a project: a session that is not done, on a lane that is not main; hidden tasks excluded. */
  liveLanes(projectId: string): LaneEntry[] {
    const out: LaneEntry[] = [];
    for (const session of this.deps.repos.sessions.byProject(projectId)) {
      if (session.archivedAt !== null || session.state === 'done' || session.purpose) continue;
      const worktree = this.deps.repos.worktrees.get(session.worktreeId);
      if (!worktree || worktree.isMain || worktree.archivedAt !== null || worktree.branch === null) continue;
      out.push({ worktree, session });
    }
    return out;
  }

  /**
   * The files a lane changed against the base: committed (`base...HEAD`, the merge-base form so the base moving
   * on does not count) plus whatever `git status` lists as changed or untracked. Cached briefly per lane.
   */
  async filesOf(worktree: Worktree): Promise<string[]> {
    const now = this.deps.clock.now();
    const hit = this.files.get(worktree.id);
    if (hit !== undefined && now - hit.at < FILES_TTL_MS) return hit.files;
    const { git } = this.deps;
    const base = this.deps.baseOf(worktree.projectId);
    const committed =
      worktree.branch === null ? [] : await git.diffNames(worktree.path, base, 'HEAD').catch(() => []);
    const status = await git.status(worktree.path).catch(() => null);
    const uncommitted = status?.changed.map((c) => c.path) ?? [];
    const files = [...new Set([...committed, ...uncommitted])].sort();
    this.files.set(worktree.id, { at: now, files });
    return files;
  }

  invalidate(worktreeId: string): void {
    this.files.delete(worktreeId);
  }

  /** A lane's tree changed (hunk rescan, a sync): its file list is stale and the project's overlaps may have moved. */
  laneChanged(worktreeId: string): Promise<void> {
    const worktree = this.deps.repos.worktrees.get(worktreeId);
    if (!worktree) return Promise.resolve();
    this.invalidate(worktree.id);
    return this.refreshProject(worktree.projectId);
  }

  /** Recomputes every live lane's overlaps, persists what changed, and warns the agents about new ones. */
  refreshProject(projectId: string): Promise<void> {
    const next = (this.refreshing.get(projectId) ?? Promise.resolve())
      .then(() => this.doRefresh(projectId))
      .catch((e: unknown) =>
        logger.warn('lane ledger: refresh failed', { projectId, error: (e as Error).message }),
      )
      .finally(() => {
        if (this.refreshing.get(projectId) === next) this.refreshing.delete(projectId);
      });
    this.refreshing.set(projectId, next);
    return next;
  }

  private async doRefresh(projectId: string): Promise<void> {
    const { repos, publisher } = this.deps;
    const lanes = this.liveLanes(projectId);
    const files = new Map<string, Set<string>>();
    for (const lane of lanes) files.set(lane.worktree.id, new Set(await this.filesOf(lane.worktree)));
    const hotspots = this.deps.hotspotsOf(projectId);
    const changed: string[] = [];
    for (const a of lanes) {
      const mine = files.get(a.worktree.id) ?? new Set<string>();
      const overlaps: WorktreeOverlap[] = [];
      for (const b of lanes) {
        if (b.worktree.id === a.worktree.id) continue;
        const theirs = files.get(b.worktree.id);
        const shared = [...mine].filter((f) => theirs?.has(f) === true).sort();
        if (shared.length === 0) continue;
        overlaps.push({ worktreeId: b.worktree.id, files: shared });
        this.warn(a, b, shared, hotspots);
      }
      overlaps.sort((x, y) => x.worktreeId.localeCompare(y.worktreeId));
      // The row may have moved on (a rescan just wrote its counters): re-read before writing the overlaps back.
      const current = repos.worktrees.get(a.worktree.id);
      if (current === null || JSON.stringify(overlaps) === JSON.stringify(current.overlaps)) continue;
      repos.worktrees.upsert({ ...current, overlaps });
      changed.push(current.id);
    }
    if (changed.length > 0) publisher.upsert('worktrees', changed);
  }

  /** Tells lane `a`'s agent about `b`, once per file; the files new since the last warning go into one line. */
  private warn(a: LaneEntry, b: LaneEntry, shared: readonly string[], hotspots: readonly string[]): void {
    const fresh = shared.filter((f) => !this.warned.has(`${a.worktree.id}|${b.worktree.id}|${f}`));
    if (fresh.length === 0) return;
    for (const f of fresh) this.warned.add(`${a.worktree.id}|${b.worktree.id}|${f}`);
    const hot = fresh.filter((f) => isHotspot(f, hotspots));
    const plain = fresh.filter((f) => !hot.includes(f));
    const vars = {
      agent: AGENT_LABEL[b.session.agent],
      branch: b.worktree.branch ?? '',
      task: taskOf(b.session) || copy.lanes.noTask,
    };
    if (plain.length > 0)
      this.deps.tell(
        a.session.id,
        fill(copy.lanes.overlap, { ...vars, files: listOf(plain, WARN_FILES_MAX) }),
      );
    if (hot.length > 0)
      this.deps.tell(
        a.session.id,
        fill(copy.lanes.overlapHotspot, { ...vars, files: listOf(hot, WARN_FILES_MAX) }),
      );
  }

  /** The base commits a lane has not merged, newest first, each attributed to the Styx lane it came from if any. */
  async baseSince(worktree: Worktree): Promise<BaseCommit[]> {
    const project = this.deps.repos.projects.get(worktree.projectId);
    if (!project || worktree.branch === null) return [];
    const base = this.deps.baseOf(project.id);
    const commits = await this.deps.git.logRange(project.path, worktree.branch, base).catch(() => []);
    return commits.map((c) => ({ ...c, lane: this.laneOfCommit(project.id, c.subject) }));
  }

  /** `Merge branch 'agent/claude-2'` / `Merge pull request #7 from acme/agent/claude-2` → that lane's owner. */
  private laneOfCommit(projectId: string, subject: string): BaseCommit['lane'] {
    const m = /^Merge (?:branch '([^']+)'|pull request #\d+ from [^/\s]+\/(\S+))/.exec(subject);
    const branch = m?.[1] ?? m?.[2] ?? null;
    if (branch === null) return null;
    const worktree = this.deps.repos.worktrees.byProject(projectId).find((w) => w.branch === branch);
    const owner =
      worktree?.owner.kind === 'session' ? this.deps.repos.sessions.get(worktree.owner.sessionId) : null;
    if (!owner) return null;
    return { agent: AGENT_LABEL[owner.agent], branch, task: taskOf(owner) };
  }

  /** The `project_activity` answer for a session: what the project did beyond its worktree. */
  async activity(sessionId: string): Promise<ProjectActivity> {
    const { repos } = this.deps;
    const session = repos.sessions.get(sessionId);
    if (!session) return { base: '', behind: 0, baseCommits: [], lanes: [], overlaps: [] };
    const worktree = repos.worktrees.get(session.worktreeId);
    const mine = new Set(worktree ? await this.filesOf(worktree) : []);
    const lanes: ProjectActivity['lanes'] = [];
    const byFile = new Map<string, LanePeer[]>();
    for (const l of this.liveLanes(session.projectId)) {
      if (l.session.id === session.id) continue;
      const files = await this.filesOf(l.worktree);
      const peer: LanePeer = {
        sessionId: l.session.id,
        agent: l.session.agent,
        branch: l.worktree.branch,
        task: taskOf(l.session),
      };
      lanes.push({ ...peer, state: l.session.state, files });
      for (const f of files) {
        if (!mine.has(f)) continue;
        const list = byFile.get(f) ?? [];
        list.push(peer);
        byFile.set(f, list);
      }
    }
    return {
      base: this.deps.baseOf(session.projectId),
      behind: worktree?.behindBase ?? 0,
      baseCommits: worktree ? await this.baseSince(worktree) : [],
      lanes,
      overlaps: [...byFile.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([file, with_]) => ({ file, with: with_ })),
    };
  }

  /** The spawn prompt's "other lanes right now" block for a session; empty when it is alone in the project. */
  async promptBlock(sessionId: string): Promise<string> {
    const session = this.deps.repos.sessions.get(sessionId);
    if (!session) return '';
    const others = this.liveLanes(session.projectId).filter((l) => l.session.id !== sessionId);
    if (others.length === 0) return '';
    const lines: string[] = [];
    for (const l of others) {
      const files = await this.filesOf(l.worktree);
      lines.push(
        fill(copy.agentPrompt.laneLine, {
          agent: AGENT_LABEL[l.session.agent],
          branch: l.worktree.branch ?? '',
          task: taskOf(l.session) || copy.lanes.noTask,
          files: files.length === 0 ? copy.lanes.noFiles : listOf(files, PROMPT_FILES_MAX),
        }),
      );
    }
    return fill(copy.agentPrompt.lanesNow, {
      lanes: lines.join('\n'),
      base: this.deps.baseOf(session.projectId),
    });
  }
}

/** `a.ts, b.ts, c.ts (+4 more)` */
const listOf = (files: readonly string[], max: number): string =>
  files.slice(0, max).join(', ') +
  (files.length > max ? ` (${fill(copy.lanes.more, { n: files.length - max })})` : '');
