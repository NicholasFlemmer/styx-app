import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  copy,
  fill,
  idFrom,
  newId,
  parseProjectFile,
  PROJECT_FILE_PATH,
  projectSettingsFromFile,
  serializeProjectFile,
  type Policy,
  type Project,
  type ProjectFileV1,
  type ProjectId,
  type ProjectPolicyDiff,
  type ProjectPolicySummary,
  projectSettingsSchema,
  type ProjectSettings,
  type Repo,
  type Target,
  type Worktree,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { TargetInfo } from '../providers';
import type { GitHubRepoApi } from '../providers/github';
import { projectSettingsFor } from '../store/projection';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import { agentHistoryDirs, agentHistoryFs, type AgentHistoryDir } from './agent-history';
import type { AuditService } from './audit-service';
import type { GitService } from './git';
import type { RecentFolder } from './ide-import-service';
import { auditContext } from './labels';
import { logger, redact } from './logger';

export interface ProjectServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  git: GitService;
  platform: NodeJS.Platform;
  home?: string;
  /** `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` for the agent-history part of `scan`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `resources/templates/<name>` for `project.create` templates. */
  templatesDir: string | null;
  audit?: AuditService;
  activity?: ActivityService;
  /** GitHub repo creation / template discovery through a connected GitHub target. */
  github?: GitHubRepoApi | null;
  /** Recent project folders from detected IDEs (IdeImportService), most recent first; git or not. */
  ideRecents?: () => RecentFolder[] | Promise<RecentFolder[]>;
  /** Walker budget override (tests). */
  scanBudget?: Partial<WalkBudget>;
}

/** Built-in template names shipped in `resources/templates` (spec §4.12). */
export const BUILTIN_TEMPLATES = ['node', 'python', 'go', 'rust', 'static'] as const;

export interface ScannedRepo {
  path: string;
  remote: string | null;
  branch: string | null;
  /** False for a plain folder (IDE recents and agent history surface those; the walker looks for `.git`). */
  hasGit: boolean;
  /** Where the folder came from, first listed wins: the walker, an editor's recents, Claude Code's or Codex's history. */
  source: ScanSource;
  lastModifiedAt: number | null;
  suggested: boolean;
}

export type ScanSource = 'scan' | 'ide-recent' | 'claude' | 'codex';

/** "Stale" for the onboarding default (spec §4.9): no commit activity in a year. */
export const STALE_MS = 365 * 24 * 3_600_000;
/** Never descended into anywhere: build output, dependency trees, dot-dirs (checked separately) and the trash. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.styx',
  'dist',
  'out',
  'build',
  'target',
  'vendor',
  'Library',
  '.Trash',
]);
/** Skipped directly under `$HOME`: system folders where repos never live but walks get expensive. */
export const HOME_SKIP_DIRS: ReadonlySet<string> = new Set([
  'Library',
  'Applications',
  'Movies',
  'Music',
  'Pictures',
  'Public',
]);
/** Folders under `$HOME` walked at depth 3 (the classic code roots plus where downloads and desktops collect repos). */
export const HOME_CODE_ROOTS = ['code', 'work', 'dev', 'src'] as const;
export const HOME_EXTRA_ROOTS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Projects',
  'Repos',
  'GitHub',
  'Sites',
] as const;
export const HOME_DEPTH = 2;
export const ROOT_DEPTH = 3;

export interface WalkRoot {
  path: string;
  /** How many levels below `path` are inspected (`path` itself is never a candidate). */
  depth: number;
  /** Names skipped directly under this root (on top of SKIP_DIRS / dot-dirs). */
  skip?: ReadonlySet<string>;
}
export interface WalkBudget {
  /** Total directories visited across all roots before the walk stops. */
  maxDirs: number;
  /** Wall-clock cap for the whole walk. */
  maxMs: number;
}
export const DEFAULT_WALK_BUDGET: WalkBudget = { maxDirs: 20_000, maxMs: 4_000 };
export interface WalkResult {
  repos: string[];
  visited: number;
  /** The budget ran out; results are whatever was found by then. */
  truncated: boolean;
}

/**
 * Finds git repositories (a `.git` directory, or a `.git` file for worktrees) under the given roots. Repos are not
 * descended into; symlinks and other filesystems (mounted volumes) are not followed; dot-dirs, SKIP_DIRS and each
 * root's own skip list are ignored. One shared budget (dirs + ms) covers every root; roots are walked in order and
 * a directory reached by an earlier root is not walked again, so list the deeper roots first.
 */
export async function walkForRepos(
  roots: readonly WalkRoot[],
  budget: Partial<WalkBudget> = {},
  nowMs: () => number = () => performance.now(),
): Promise<WalkResult> {
  const { maxDirs, maxMs } = { ...DEFAULT_WALK_BUDGET, ...budget };
  const start = nowMs();
  const repos = new Set<string>();
  const seen = new Set<string>();
  const state = { visited: 0, truncated: false };

  const walk = async (dir: string, depth: number, root: WalkRoot, dev: number | null): Promise<void> => {
    if (state.truncated) return;
    if (seen.has(dir)) return;
    seen.add(dir);
    if (state.visited >= maxDirs || nowMs() - start > maxMs) {
      state.truncated = true;
      return;
    }
    state.visited += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && entries.some((e) => e.name === '.git')) {
      repos.add(dir);
      return;
    }
    if (depth >= root.depth) return;
    for (const e of entries) {
      if (state.truncated) return;
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (depth === 0 && root.skip?.has(e.name)) continue;
      const p = join(dir, e.name);
      if (dev !== null) {
        try {
          if ((await stat(p)).dev !== dev) continue;
        } catch {
          continue;
        }
      }
      await walk(p, depth + 1, root, dev);
    }
  };

  for (const root of roots) {
    if (state.truncated) break;
    let dev: number | null = null;
    try {
      const st = await stat(root.path);
      if (!st.isDirectory()) continue;
      dev = st.dev;
    } catch {
      continue;
    }
    await walk(root.path, 0, root, dev);
  }
  return { repos: [...repos], visited: state.visited, truncated: state.truncated };
}

/** The roots `project.scan` walks on this machine (deeper, specific roots first; `$HOME` itself last at depth 2). */
export const scanRoots = (home: string, platform: NodeJS.Platform): WalkRoot[] => [
  ...HOME_CODE_ROOTS.map((d) => ({ path: join(home, d), depth: ROOT_DEPTH })),
  ...HOME_EXTRA_ROOTS.map((d) => ({ path: join(home, d), depth: ROOT_DEPTH })),
  ...(platform === 'win32' ? [{ path: 'C:\\dev', depth: ROOT_DEPTH }] : []),
  { path: home, depth: HOME_DEPTH, skip: HOME_SKIP_DIRS },
];

export const initialsOf = (name: string): string => {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1];
  const s = second ? `${first[0] ?? ''}${second[0] ?? ''}` : first.slice(0, 2);
  return (s || 'PR').toUpperCase();
};

/**
 * What may become `origin`: an https / ssh URL, a local path (a bare repo on disk), or the `owner/name` shorthand,
 * which means github.com. Anything else is not a remote and is not tried.
 */
export const remoteUrlOf = (raw: string): string | null => {
  const text = raw.trim();
  if (text === '' || /\s/.test(text)) return null;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return `https://github.com/${text}.git`;
  if (/^(https?|ssh|git|file):\/\/\S+$/i.test(text)) return text;
  if (/^[\w.-]+@[\w.-]+:\S+$/.test(text)) return text;
  if (text.startsWith('/')) return text;
  // A local repo on Windows (`C:\code\shop.git`, `D:/repos/x`).
  if (/^[A-Za-z]:[\\/]\S+$/.test(text)) return text;
  return null;
};

/** The web page for a github.com remote (`.git` and the ssh form both resolve), null for anything else. */
export const githubHtmlUrl = (url: string): string | null => {
  const https = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  if (https?.[1] !== undefined) return `https://github.com/${https[1]}`;
  const ssh = /^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(url);
  if (ssh?.[1] !== undefined) return `https://github.com/${ssh[1]}`;
  return null;
};

/**
 * Every project setting `setSetting` may write, straight from the schema: a hand-kept list silently dropped keys
 * added later (`permissionMode` and `effort` never reached project.json; the row showed the default after every
 * change), so the schema is the list.
 */
const PROJECT_KEYS = Object.keys(projectSettingsSchema.shape) as (keyof ProjectSettings)[];

/**
 * Machine-local acceptance record, stored in `ui_state` under `project-policy-accepted:<projectId>` (H-1 trust gate).
 * The summary is the grant-relevant part of `.styx/project.json`: `policies.extra` (file order) and, per target
 * keyed by `(provider, env, name)`, its `policy` and `config` (config steers where a credential points).
 */
export interface AcceptedProjectPolicy {
  hash: string;
  summary: ProjectPolicySummary;
}

export const PROJECT_POLICY_BANNER_PREFIX = 'project-policy:';
const acceptedKey = (projectId: string): string => `project-policy-accepted:${projectId}`;
export const targetKey = (t: { provider: string; env: string; name: string }): string =>
  `${t.provider}/${t.env}/${t.name}`;

export const policySummaryOf = (file: ProjectFileV1): ProjectPolicySummary => ({
  rules: (file.policies?.extra ?? []).map((p) => ({
    id: p.id,
    rule: p.rule,
    ruleText: p.ruleText,
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
  })),
  targets: (file.targets ?? [])
    .map((t) => ({ key: targetKey(t), policy: t.policy ?? null, config: t.config ?? {} }))
    .sort((a, b) => a.key.localeCompare(b.key)),
});

export const policyHashOf = (summary: ProjectPolicySummary): string =>
  createHash('sha256').update(JSON.stringify(summary)).digest('hex');

/** A file that sets no grant policy and no target config has nothing to trust: it is never gated. */
export const hasPolicyContent = (s: ProjectPolicySummary): boolean =>
  s.rules.length > 0 || s.targets.some((t) => t.policy !== null || Object.keys(t.config).length > 0);

/** What accepting changes, for the `policy-changed` audit row and the Settings review row. */
export const policyDiff = (
  before: ProjectPolicySummary | null,
  after: ProjectPolicySummary,
): ProjectPolicyDiff => {
  const prevRules = new Map((before?.rules ?? []).map((r) => [r.id, JSON.stringify(r)]));
  const nextRules = new Map(after.rules.map((r) => [r.id, JSON.stringify(r)]));
  const rules = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  for (const [id, json] of nextRules) {
    const prev = prevRules.get(id);
    if (prev === undefined) rules.added.push(id);
    else if (prev !== json) rules.changed.push(id);
  }
  for (const id of prevRules.keys()) if (!nextRules.has(id)) rules.removed.push(id);
  const prevTargets = new Map((before?.targets ?? []).map((t) => [t.key, t]));
  const nextTargets = new Map(after.targets.map((t) => [t.key, t]));
  const targets: ProjectPolicyDiff['targets'] = [];
  const configChanged: string[] = [];
  for (const key of new Set([...prevTargets.keys(), ...nextTargets.keys()])) {
    const from = prevTargets.get(key)?.policy ?? null;
    const to = nextTargets.get(key)?.policy ?? null;
    if (from !== to) targets.push({ target: key, from, to });
    if (
      JSON.stringify(prevTargets.get(key)?.config ?? {}) !==
      JSON.stringify(nextTargets.get(key)?.config ?? {})
    )
      configChanged.push(key);
  }
  return { rules, targets, configChanged };
};

/**
 * Untrusted file rules are advisory: `auto-approve` becomes `ask` (same id, so the audit still cites it) and
 * `idle-expiry` is dropped (it could only lengthen grant lifetimes). `ask` rules only tighten and pass through.
 */
export const advisoryRules = (rules: readonly Policy[]): Policy[] =>
  rules.flatMap((r) => {
    if (r.rule.kind === 'auto-approve')
      return [
        {
          ...r,
          rule: { kind: 'ask' as const, match: r.rule.match, scopes: r.rule.scopes, requireMfa: false },
        },
      ];
    if (r.rule.kind === 'idle-expiry') return [];
    return [r];
  });

interface CachedProjectFile {
  mtime: number;
  file: ProjectFileV1 | null;
  hash: string;
  summary: ProjectPolicySummary;
  /** Engine rows when the file's policy hash is accepted on this machine. */
  trustedRules: Policy[];
  /** Engine rows otherwise (auto-approve → ask, idle-expiry dropped). */
  untrustedRules: Policy[];
}

/** Projects, repos and the `.styx/project.json` reconcile (plan §4, §5). Never writes secrets to the file. */
export class ProjectService {
  private readonly fileCache = new Map<string, CachedProjectFile>();

  constructor(private readonly deps: ProjectServiceDeps) {}

  /**
   * `.styx/project.json` `policies.extra` as core `Policy` rows for the policy engine's `projectRules` (evaluated after
   * app rules). Read synchronously and cached by file mtime so a grant request never awaits disk. Until the file's
   * policy hash is accepted on this machine (`project.policy.accept`) the rules are advisory only: a fresh clone can
   * never auto-approve a grant by committing a rule (security audit H-1).
   */
  projectRules(projectId: string): Policy[] {
    const cached = this.cachedFile(projectId);
    if (!cached) return [];
    return this.isAccepted(projectId, cached.summary, cached.hash)
      ? cached.trustedRules
      : cached.untrustedRules;
  }

  /** Whether the file's current grant policy is in force on this machine (no policy content counts as trusted). */
  projectPolicyTrusted(projectId: string): boolean {
    const cached = this.cachedFile(projectId);
    return cached ? this.isAccepted(projectId, cached.summary, cached.hash) : true;
  }

  acceptedPolicy(projectId: string): AcceptedProjectPolicy | null {
    return this.deps.repos.uiState.get<AcceptedProjectPolicy>(acceptedKey(projectId)) ?? null;
  }

  private isAccepted(projectId: string, summary: ProjectPolicySummary, hash: string): boolean {
    if (!hasPolicyContent(summary)) return true;
    return this.acceptedPolicy(projectId)?.hash === hash;
  }

  private cachedFile(projectId: string): CachedProjectFile | null {
    const project = this.deps.repos.projects.get(projectId);
    if (!project) return null;
    const file = join(project.path, PROJECT_FILE_PATH);
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      this.fileCache.delete(projectId);
      return null;
    }
    const cached = this.fileCache.get(projectId);
    if (cached && cached.mtime === mtime) return cached;
    let parsedFile: ProjectFileV1 | null = null;
    try {
      const parsed = parseProjectFile(readFileSync(file, 'utf8'));
      if (parsed.ok) parsedFile = parsed.file;
    } catch (e) {
      logger.warn('project.json rules unreadable', { project: project.name, error: (e as Error).message });
    }
    const summary = parsedFile ? policySummaryOf(parsedFile) : { rules: [], targets: [] };
    const trustedRules = parsedFile ? projectFileRules(parsedFile, this.deps.clock.now()) : [];
    const entry: CachedProjectFile = {
      mtime,
      file: parsedFile,
      hash: policyHashOf(summary),
      summary,
      trustedRules,
      untrustedRules: advisoryRules(trustedRules),
    };
    this.fileCache.set(projectId, entry);
    return entry;
  }

  private get home(): string {
    return this.deps.home ?? homedir();
  }

  require(id: string): Project {
    return this.deps.repos.projects.get(id) ?? fail('not-found', `project ${id} not found`);
  }

  // --- scan ------------------------------------------------------------------

  /**
   * Repos on this machine (walker roots), every existing folder the detected IDEs opened recently and every
   * directory Claude Code or Codex has worked in (their own session history; docs/handoff-discrepancies #93) —
   * git or not — known projects and worktrees dropped; git repos first, then most recently active first.
   */
  async scan(includeIdeRecents: boolean, includeAgentHistory = true): Promise<ScannedRepo[]> {
    const started = performance.now();
    const walk = await walkForRepos(scanRoots(this.home, this.deps.platform), this.deps.scanBudget ?? {});
    if (walk.truncated) {
      logger.warn('project.scan: walk budget exhausted, results are partial', {
        visited: walk.visited,
        ms: Math.round(performance.now() - started),
        found: walk.repos.length,
      });
    }
    let ideRecents: RecentFolder[] = [];
    if (includeIdeRecents && this.deps.ideRecents) {
      try {
        ideRecents = (await this.deps.ideRecents()).filter((r) => isDirectory(r.path));
      } catch (e) {
        logger.warn('project.scan: IDE recents unreadable', { error: (e as Error).message });
      }
    }
    let agentDirs: AgentHistoryDir[] = [];
    if (includeAgentHistory) {
      try {
        agentDirs = (
          await agentHistoryDirs({
            home: this.home,
            env: this.deps.env ?? process.env,
            now: this.deps.clock.now(),
            ...agentHistoryFs(),
          })
        ).filter((d) => !isTransientPath(d.path, this.home));
      } catch (e) {
        logger.warn('project.scan: agent history unreadable', { error: (e as Error).message });
      }
    }
    // Known projects and their worktrees (Styx's own agent worktrees are where the CLIs run most) are not candidates.
    const known = new Set([
      ...this.deps.repos.projects.all().map((p) => p.path),
      ...this.deps.repos.worktrees.all().map((w) => w.path),
    ]);
    const activityAt = new Map<string, number>();
    const bump = (path: string, at: number | null) => {
      if (at !== null) activityAt.set(path, Math.max(activityAt.get(path) ?? -Infinity, at));
    };
    for (const r of ideRecents) bump(r.path, r.openedAt);
    for (const d of agentDirs) bump(d.path, d.lastActivityAt);
    const candidates = mergeCandidates(
      walk.repos,
      ideRecents.map((r) => r.path),
      agentDirs,
      known,
    ).map((c) => ({ ...c, activityAt: activityAt.get(c.path) ?? null }));
    const described = await this.describeRepos(candidates);
    return described.sort(byLastActivity);
  }

  /**
   * Remote / branch / activity for candidate folders (known projects are dropped); `suggested` per spec §4.9.
   * `activityAt` is what the source knows (the IDE's last open, the agent's last session) and only ever moves the
   * activity later: a git repo's activity is the newer of its `.git` mtime and that; a folder without git is listed
   * as-is (`hasGit: false`, meta `no git`) with `activityAt`, else the folder's mtime, and is suggested when that is
   * within the staleness window.
   */
  async describeRepos(
    candidates: readonly { path: string; source: ScanSource; activityAt?: number | null }[],
  ): Promise<ScannedRepo[]> {
    const known = new Set(this.deps.repos.projects.all().map((p) => p.path));
    const out: ScannedRepo[] = [];
    const now = this.deps.clock.now();
    for (const c of candidates) {
      if (known.has(c.path)) continue;
      let remote: string | null = null;
      let branch: string | null = null;
      let lastModifiedAt: number | null = null;
      // Same test as the walker (a `.git` entry): no git process per candidate; an unreadable repo is still listed.
      // A directory only an agent's history names may be a folder inside a repo (the CLI was started there), which
      // `project.add` would treat as a repo too, so that one gets the real git check.
      const hasGitEntry = existsSync(join(c.path, '.git'));
      const hasGit =
        hasGitEntry ||
        ((c.source === 'claude' || c.source === 'codex') &&
          (await this.deps.git.isRepo(c.path).catch(() => false)));
      const activityAt = c.activityAt ?? null;
      if (hasGit) {
        try {
          const rs = await this.deps.git.remotes(c.path);
          remote = rs.find((r) => r.name === 'origin')?.url ?? rs[0]?.url ?? null;
          branch = await this.deps.git.currentBranch(c.path);
          if (hasGitEntry) lastModifiedAt = Math.round((await stat(join(c.path, '.git'))).mtimeMs);
        } catch {
          /* unreadable repo: still listed */
        }
        if (activityAt !== null) lastModifiedAt = Math.max(lastModifiedAt ?? -Infinity, activityAt);
      } else {
        lastModifiedAt =
          activityAt ??
          (await stat(c.path)
            .then((s) => Math.round(s.mtimeMs))
            .catch(() => null));
      }
      out.push({
        path: c.path,
        remote,
        branch,
        hasGit,
        source: c.source,
        lastModifiedAt,
        suggested: hasGit ? isSuggested(remote, lastModifiedAt, now) : isRecent(lastModifiedAt, now),
      });
    }
    return out;
  }

  // --- add / clone / create ---------------------------------------------------

  /**
   * Any readable directory becomes a project (spec §4.9 "Add folder"; git is not an admission rule). A git repo gets
   * its remotes / default branch / main worktree; a plain folder gets a repo row with `defaultBranch: null` and one
   * main worktree pointing at the folder itself with `branch: null` — agents run in it directly until `gitInit`.
   */
  async add(rawPath: string, name?: string): Promise<Project> {
    const { repos, git, clock, publisher } = this.deps;
    const path = resolve(rawPath.replace(/^~(?=$|[\\/])/, this.home));
    const existing = repos.projects.byPath(path);
    if (existing) return existing.removedAt === null ? existing : this.restore(existing);
    if (!existsSync(path)) fail('not-found', `${path} does not exist`);
    if (!isDirectory(path))
      fail('invalid-input', `${path} is not a directory`, { reason: 'not-a-directory' });
    const now = clock.now();
    const projectName = name ?? basename(path);
    const project: Project = {
      id: newId<'ProjectId'>(),
      name: projectName,
      path,
      initials: initialsOf(projectName),
      railOrder: repos.projects.count(),
      hasProjectFile: existsSync(join(path, PROJECT_FILE_PATH)),
      createdAt: now,
      lastActivityAt: now,
      removedAt: null,
    };
    const hasGit = await git.isRepo(path);
    const gitInfo = hasGit ? await this.describeGit(path) : null;
    const repo: Repo = {
      id: newId<'RepoId'>(),
      projectId: project.id,
      defaultBranch: gitInfo?.defaultBranch ?? null,
      remotes: gitInfo?.remotes ?? [],
      ahead: gitInfo?.ahead ?? 0,
      behind: gitInfo?.behind ?? 0,
      fetchedAt: null,
      lineEndings: 'auto',
      longPaths: this.deps.platform === 'win32',
    };
    const main: Worktree = {
      id: newId<'WorktreeId'>(),
      repoId: repo.id,
      projectId: project.id,
      branch: gitInfo?.branch ?? null,
      path,
      isMain: true,
      owner: { kind: 'user' },
      baseCommit: gitInfo?.head ?? null,
      headCommit: gitInfo?.head ?? null,
      changes: { added: 0, removed: 0, files: 0 },
      pr: null,
      conflict: null,
      behindBase: 0,
      overlaps: [],
      resolution: null,
      landing: null,
      mergedAt: null,
      createdAt: now,
      archivedAt: null,
    };
    repos.transaction(() => {
      repos.projects.upsert(project);
      repos.repos.upsert(repo);
      repos.worktrees.upsert(main);
    });
    publisher.upsert('projects', [project.id]);
    publisher.upsert('repos', [repo.id]);
    publisher.upsert('worktrees', [main.id]);
    await this.reconcileProjectFile(project.id);
    return this.require(project.id);
  }

  /**
   * Adding a folder that was removed brings the same project back (owner request): its id, settings, targets, lanes
   * and every agent thread with it, since removing only hid them. Git facts are refreshed, as the folder may have
   * changed while it was gone.
   */
  private async restore(project: Project): Promise<Project> {
    const { repos, git, publisher } = this.deps;
    const back: Project = {
      ...project,
      removedAt: null,
      railOrder: repos.projects.count(),
      hasProjectFile: existsSync(join(project.path, PROJECT_FILE_PATH)),
    };
    repos.projects.upsert(back, repos.projects.settings(project.id));
    publisher.upsert('projects', [project.id]);
    const repo = repos.repos.byProject(project.id);
    const main = repos.worktrees.byProject(project.id).find((w) => w.isMain);
    if (repo && main && (await git.isRepo(project.path))) {
      const info = await this.describeGit(project.path);
      repos.repos.upsert({
        ...repo,
        defaultBranch: info.defaultBranch,
        remotes: info.remotes,
        ahead: info.ahead,
        behind: info.behind,
      });
      repos.worktrees.upsert({ ...main, branch: info.branch, headCommit: info.head });
      publisher.upsert('repos', [repo.id]);
      publisher.upsert('worktrees', [main.id]);
    }
    await this.reconcileProjectFile(project.id);
    return this.require(project.id);
  }

  /** What a git repo contributes to its repo row and main worktree. */
  private async describeGit(path: string): Promise<{
    defaultBranch: string;
    branch: string;
    head: string | null;
    remotes: Repo['remotes'];
    ahead: number;
    behind: number;
  }> {
    const { git } = this.deps;
    const remotes = await git.remotes(path);
    const defaultBranch = await git.defaultBranch(path);
    const branch = (await git.currentBranch(path)) ?? defaultBranch;
    const head = await git.headCommit(path);
    const status = await git.status(path).catch(() => null);
    return {
      defaultBranch,
      branch,
      head,
      remotes: remotes.map((r) => ({ name: r.name, url: r.url })),
      ahead: status?.ahead ?? 0,
      behind: status?.behind ?? 0,
    };
  }

  /**
   * `project.gitInit`: `git init -b main` plus an empty first commit (so `main` is a real ref: worktrees, diffs and
   * reviews work at once; nothing in the folder is committed) in a plain-folder project, then the repo row and main
   * worktree are reconciled onto `main`. Sessions already running in the folder are unaffected. No-op on a git repo.
   */
  async gitInit(projectId: string): Promise<void> {
    const { repos, git, publisher } = this.deps;
    const project = this.require(projectId);
    const repo = repos.repos.byProject(project.id) ?? fail('not-found', `${project.name} has no repo row`);
    const main = repos.worktrees.mainOf(project.id) ?? fail('internal', 'main worktree missing');
    if (!(await git.isRepo(project.path))) {
      await git.init(project.path);
      await git.commit(project.path, 'Initial commit', { allowEmpty: true });
    }
    const info = await this.describeGit(project.path);
    const nextRepo: Repo = {
      ...repo,
      defaultBranch: info.defaultBranch,
      remotes: info.remotes,
      ahead: info.ahead,
      behind: info.behind,
    };
    const nextMain: Worktree = {
      ...main,
      branch: info.branch,
      baseCommit: info.head,
      headCommit: info.head,
    };
    repos.transaction(() => {
      repos.repos.upsert(nextRepo);
      repos.worktrees.upsert(nextMain);
    });
    publisher.upsert('repos', [repo.id]);
    publisher.upsert('worktrees', [main.id]);
    this.deps.activity?.append({
      who: 'you',
      what: `${project.name} · git initialised on ${info.branch}`,
      projectId: project.id,
      sessionId: null,
    });
  }

  /** `git clone` into `into` (the full destination path), then add. Progress goes out as `project.cloneProgress`. */
  async clone(url: string, into: string): Promise<Project> {
    const target = resolve(into.replace(/^~(?=$|[\\/])/, this.home));
    const progress = (
      phase: 'cloning' | 'done' | 'error',
      message: string | null,
      projectId: ProjectId | null,
    ) =>
      this.deps.publisher.sendEvent('project.cloneProgress', {
        url,
        dest: target,
        phase,
        message,
        projectId,
      });
    progress('cloning', null, null);
    try {
      if (existsSync(target) && (await readdir(target)).length > 0)
        fail('invalid-input', `${target} already exists and is not empty`);
      await mkdir(dirname(target), { recursive: true });
      await this.deps.git.clone(url, target);
      const project = await this.add(target);
      progress('done', null, project.id);
      return project;
    } catch (e) {
      progress('error', (e as Error).message, null);
      throw e;
    }
  }

  async create(input: {
    name: string;
    location: string;
    gitInit: boolean;
    template: string | null;
    copyTargetsFrom: string | null;
    createGithubRepo?: boolean;
  }): Promise<Project & { githubError: string | null; gitError: string | null }> {
    const location = resolve(input.location.replace(/^~(?=$|[\\/])/, this.home));
    const dir = basename(location) === input.name ? location : join(location, input.name);
    // A folder holding only the README an earlier attempt wrote (before this step stopped failing) is ours to reuse.
    const leftover = existsSync(dir) ? (await readdir(dir)).filter((f) => f !== 'README.md') : [];
    if (leftover.length > 0 && !(await this.deps.git.isRepo(dir)))
      fail('invalid-input', `${dir} exists and is not empty`);
    // Git is never what stops a project being made (owner request): without it, or if it fails, the project is a
    // plain folder (agents work in it directly) and the reason comes back for the person; Initialise git in Repo
    // upgrades it later.
    const git = input.gitInit ? await this.deps.git.available() : { installed: false, version: null };
    let gitError: string | null = input.gitInit && !git.installed ? copy.newProject.gitMissing : null;
    await mkdir(dir, { recursive: true });
    if (input.template && this.deps.templatesDir) {
      const src = join(this.deps.templatesDir, input.template);
      if (existsSync(src)) await cp(src, dir, { recursive: true });
      else logger.warn('project.create: template not found', { template: input.template });
    }
    const readme = join(dir, 'README.md');
    if (!existsSync(readme)) await writeFile(readme, `# ${input.name}\n`);
    if (git.installed && !(await this.deps.git.isRepo(dir))) {
      try {
        await this.deps.git.init(dir);
        await this.deps.git.add(dir, ['.']);
        await this.deps.git.commit(dir, 'Initial commit');
      } catch (e) {
        gitError = (e as Error).message;
        logger.warn('project.create: git init failed; made as a plain folder', { error: gitError });
        await rm(join(dir, '.git'), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const project = await this.add(dir, input.name);
    if (input.copyTargetsFrom) this.copyTargets(input.copyTargetsFrom, project.id);
    // The project exists on disk and in Styx from here: a GitHub repo that could not be made is reported with
    // the project, not thrown over it (a second Create would then refuse the folder as "not empty"). Repo ›
    // Connect to GitHub does the same step later.
    let githubError: string | null = null;
    if (input.createGithubRepo && !(await this.deps.git.isRepo(dir)))
      githubError = copy.newProject.githubNeedsGit;
    else if (input.createGithubRepo) {
      try {
        await this.createGithubRepo(project.id, input.gitInit);
      } catch (e) {
        githubError = (e as Error).message;
        logger.warn('project.create: GitHub repo not created', { project: input.name, error: githubError });
      }
    }
    return { ...this.require(project.id), githubError, gitError };
  }

  // --- GitHub ------------------------------------------------------------------

  /** The project's connected GitHub target, else any connected GitHub target (spec §4.12 "Create GitHub repo · private"). */
  githubTarget(projectId: string | null): Target | null {
    const all = this.deps.repos.targets
      .all()
      .filter((t) => t.provider === 'github' && t.credentialRef !== null);
    return all.find((t) => t.projectId === projectId) ?? all[0] ?? null;
  }

  private targetInfo(t: Target): TargetInfo {
    return {
      id: t.id,
      provider: t.provider,
      name: t.name,
      env: t.env,
      config: t.config,
      credentialRef: t.credentialRef,
    };
  }

  /**
   * Creates a private repo through the GitHub target's token (`/user/repos`, or `/orgs/{owner}/repos` when the target's
   * `owner` is an org), adds it as `origin` and pushes the initial commit. Audited as `connected` with `{ repo }`.
   */
  async createGithubRepo(
    projectId: string,
    push: boolean,
    opts: { name?: string; isPrivate?: boolean; triggeredBy?: string } = {},
  ): Promise<{ fullName: string; htmlUrl: string; cloneUrl: string }> {
    const { repos, github, git, publisher } = this.deps;
    const project = this.require(projectId);
    const target = this.githubTarget(project.id);
    if (!target || !github) fail('provider-error', copy.connectRepo.noGithub);
    const owner = typeof target.config['owner'] === 'string' ? target.config['owner'] : null;
    const info = this.targetInfo(target);
    let created;
    try {
      created = await github.createRepo(info, {
        name: opts.name ?? project.name,
        owner,
        isPrivate: opts.isPrivate ?? true,
      });
    } catch (e) {
      fail('provider-error', (e as Error).message);
    }
    const existing = await git.remotes(project.path);
    if (!existing.some((r) => r.name === 'origin'))
      await git.addRemote(project.path, 'origin', created.cloneUrl);
    const repo = repos.repos.byProject(project.id);
    if (repo) {
      const remotes = repo.remotes.some((r) => r.name === 'origin')
        ? repo.remotes
        : [...repo.remotes, { name: 'origin', url: created.cloneUrl }];
      repos.repos.upsert({ ...repo, remotes });
      publisher.upsert('repos', [repo.id]);
    }
    if (push && (await git.headCommit(project.path))) {
      const branch = (await git.currentBranch(project.path)) ?? created.defaultBranch;
      try {
        await git.push(project.path, 'origin', branch, { token: await github.pushToken(info) });
      } catch (e) {
        logger.warn('project.create: initial push failed', {
          project: project.name,
          error: (e as Error).message,
        });
      }
    }
    if (this.deps.audit) {
      const row = this.deps.audit.append({
        actorKind: 'you',
        actorLabel: 'you',
        action: 'connected',
        ...auditContext(repos, { target, projectId: project.id }),
        triggeredBy: opts.triggeredBy ?? 'project.create',
        detail: { repo: created.fullName, url: created.htmlUrl },
      });
      publisher.upsert('auditEntries', [row.id]);
      const entry = repos.audit.get(row.id);
      if (entry && this.deps.activity) this.deps.activity.fromAudit(entry);
    }
    return { fullName: created.fullName, htmlUrl: created.htmlUrl, cloneUrl: created.cloneUrl };
  }

  /**
   * Gives a project with no remote one (owner report): a new repo on GitHub through the target, pushed, or an
   * existing repo's URL as `origin` (fetched so the base's ahead / behind read at once). Never replaces a remote
   * that is already there — that is a decision for the person and their git.
   */
  async connectRemote(
    projectId: string,
    input: { kind: 'create'; name: string; isPrivate: boolean } | { kind: 'existing'; url: string },
    opts: { replace?: boolean } = {},
  ): Promise<{ url: string; htmlUrl: string | null }> {
    const { repos, git, publisher } = this.deps;
    const project = this.require(projectId);
    if (!(await git.isRepo(project.path))) fail('invalid-input', copy.connectRepo.noGit);
    const origin = (await git.remotes(project.path)).find((r) => r.name === 'origin');
    if (origin !== undefined) {
      if (opts.replace !== true) fail('invalid-input', fill(copy.connectRepo.hasOrigin, { url: origin.url }));
      // Reconnect (owner request): the old origin goes, tracking refs and all, and the new one is set up fresh.
      if (input.kind === 'existing' && remoteUrlOf(input.url) === null)
        fail('invalid-input', copy.connectRepo.invalidUrl);
      await git.removeRemote(project.path, 'origin');
      logger.info('project: remote replaced', { project: project.name, previous: origin.url });
    }
    if (input.kind === 'create') {
      const created = await this.createGithubRepo(project.id, true, {
        name: input.name.trim(),
        isPrivate: input.isPrivate,
        triggeredBy: 'project.connectRemote',
      });
      return { url: created.cloneUrl, htmlUrl: created.htmlUrl };
    }
    const url = remoteUrlOf(input.url);
    if (url === null) fail('invalid-input', copy.connectRepo.invalidUrl);
    await git.addRemote(project.path, 'origin', url);
    await git.fetch(project.path).catch(() => undefined);
    const repo = repos.repos.byProject(project.id);
    if (repo) {
      const info = await this.describeGit(project.path);
      repos.repos.upsert({ ...repo, remotes: info.remotes, ahead: info.ahead, behind: info.behind });
      publisher.upsert('repos', [repo.id]);
    }
    this.deps.activity?.append({
      who: copy.repo.you,
      what: `${project.name} · ${fill(copy.connectRepo.activity, { remote: url })}`,
      projectId: project.id as ProjectId,
      sessionId: null,
    });
    logger.info('project: remote connected', { project: project.name, remote: url });
    return { url, htmlUrl: githubHtmlUrl(url) };
  }

  /** Built-in template names plus repos tagged `styx-template` in the GitHub target's org (empty when unavailable). */
  async templates(): Promise<{ builtins: string[]; org: { name: string; fullName: string }[] }> {
    let builtins: string[] = [...BUILTIN_TEMPLATES];
    if (this.deps.templatesDir && existsSync(this.deps.templatesDir)) {
      const dirs = (await readdir(this.deps.templatesDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (dirs.length > 0) builtins = dirs.sort();
    }
    const target = this.githubTarget(this.deps.repos.uiState.get<string>('projectId') ?? null);
    let org: { name: string; fullName: string }[] = [];
    if (target && this.deps.github) {
      const owner = typeof target.config['owner'] === 'string' ? target.config['owner'] : null;
      if (owner) {
        try {
          org = await this.deps.github.templateRepos(this.targetInfo(target), owner);
        } catch (e) {
          logger.warn('project.templates: GitHub search failed', { error: (e as Error).message });
        }
      }
    }
    return { builtins, org };
  }

  /** Copies target definitions (never credentials) from another project; they show as `unconnected` with a Connect action. */
  private copyTargets(fromProjectId: string, toProjectId: ProjectId): void {
    const { repos, publisher, clock } = this.deps;
    const ids: string[] = [];
    for (const t of repos.targets.byProject(fromProjectId)) {
      const copy: Target = {
        ...t,
        id: newId<'TargetId'>(),
        projectId: toProjectId,
        credentialRef: null,
        health: 'unconnected',
        healthCheckedAt: null,
        expiredAt: null,
        fromProjectFile: false,
        createdAt: clock.now(),
      };
      repos.targets.upsert(copy);
      ids.push(copy.id);
    }
    publisher.upsert('targets', ids);
  }

  // --- remove / reorder / select ---------------------------------------------

  /**
   * Removing a project hides it (`removedAt`) and keeps everything else, so adding the folder again brings its
   * threads back (owner request; `add` → `restore`). The caller stops its agents and closes its grants first.
   * Deleting the files as well is the one hard delete: with the folder gone there is nothing to come back to.
   */
  async remove(
    projectId: string,
    deleteFiles: boolean,
  ): Promise<{ sessionIds: string[]; worktreePaths: string[] }> {
    const { repos, publisher } = this.deps;
    const project = this.require(projectId);
    if (!deleteFiles) {
      repos.projects.upsert(
        { ...project, removedAt: this.deps.clock.now() },
        repos.projects.settings(project.id),
      );
      publisher.upsert('projects', [project.id]);
      this.repackRail();
      return { sessionIds: repos.sessions.byProject(project.id).map((s) => s.id), worktreePaths: [] };
    }
    const home = resolve(this.home);
    const inHome = project.path.startsWith(home + '/') || project.path.startsWith(home + '\\');
    if (!inHome || project.path === home)
      fail('fs-denied', 'refusing to delete a folder outside the home directory');
    const sessionIds = repos.sessions.byProject(project.id).map((s) => s.id);
    const worktrees = repos.worktrees.byProject(project.id);
    const repo = repos.repos.byProject(project.id);
    const targetIds = repos.targets.byProject(project.id).map((t) => t.id);
    const grantIds = targetIds.flatMap((id) => repos.grants.byTarget(id).map((g) => g.id));
    const askIds = sessionIds.flatMap((id) => repos.pendingAsks.bySession(id).map((a) => a.id));
    repos.projects.remove(project.id); // cascades: repos → worktrees, sessions → asks/transcripts, targets → grants
    publisher.remove('pendingAsks', askIds);
    publisher.remove('grants', grantIds);
    publisher.remove('targets', targetIds);
    publisher.remove('sessions', sessionIds);
    publisher.remove(
      'worktrees',
      worktrees.map((w) => w.id),
    );
    if (repo) publisher.remove('repos', [repo.id]);
    publisher.remove('projects', [project.id]);
    this.repackRail();
    await rm(project.path, { recursive: true, force: true });
    return { sessionIds, worktreePaths: worktrees.filter((w) => !w.isMain).map((w) => w.path) };
  }

  /** Rail order counts the projects on the rail, so a removed one leaves no gap. */
  private repackRail(): void {
    const { repos, publisher } = this.deps;
    const rest = repos.projects.all().filter((p) => p.removedAt === null);
    rest.forEach((p, i) => repos.projects.upsert({ ...p, railOrder: i }, repos.projects.settings(p.id)));
    publisher.upsert(
      'projects',
      rest.map((p) => p.id),
    );
  }

  reorder(ids: readonly string[]): void {
    const { repos, publisher } = this.deps;
    const all = repos.projects.all();
    const listed = ids.filter((id) => all.some((p) => p.id === id));
    const order = [...listed, ...all.filter((p) => !listed.includes(p.id)).map((p) => p.id)];
    order.forEach((id, i) => {
      const p = repos.projects.get(id);
      if (p) repos.projects.upsert({ ...p, railOrder: i });
    });
    publisher.upsert('projects', order);
  }

  select(projectId: string): void {
    const project = this.require(projectId);
    this.deps.repos.uiState.set('projectId', project.id);
    this.deps.repos.projects.upsert({ ...project, lastActivityAt: this.deps.clock.now() });
    this.deps.publisher.upsert('projects', [project.id]);
  }

  // --- settings & project file -------------------------------------------------

  /** Reads `.styx/project.json` (if any), stores the settings overrides on the project row and upserts file targets. */
  async reconcileProjectFile(projectId: string): Promise<{ ok: boolean; error: string | null }> {
    const { repos, publisher, clock } = this.deps;
    const project = this.require(projectId);
    const file = join(project.path, PROJECT_FILE_PATH);
    if (!existsSync(file)) {
      if (project.hasProjectFile) {
        repos.projects.setSettings(project.id, {}, null);
        publisher.upsert('projects', [project.id]);
        publisher.settingsSet(undefined, { [project.id]: projectSettingsFor(repos, project.id) });
      }
      this.clearPolicyBanner(project);
      return { ok: true, error: null };
    }
    const text = await readFile(file, 'utf8');
    const parsed = parseProjectFile(text);
    if (!parsed.ok) {
      logger.warn('project.json invalid', { project: project.name, error: parsed.error.message });
      return { ok: false, error: parsed.error.message };
    }
    const mtime = Math.round((await stat(file)).mtimeMs) || clock.now();
    repos.projects.setSettings(project.id, projectSettingsFromFile(parsed.file), mtime);
    // Repo-authored grant policy is advisory until accepted on this machine: an unaccepted `targets[].policy` never
    // lands on the row (the app value and `policySource: 'app'` stay), and the banner asks the user to review (H-1).
    const summary = policySummaryOf(parsed.file);
    const hash = policyHashOf(summary);
    const trusted = this.isAccepted(project.id, summary, hash);
    const targetIds: string[] = [];
    const existing = repos.targets.byProject(project.id);
    for (const ft of parsed.file.targets ?? []) {
      const match = existing.find(
        (t) => t.provider === ft.provider && t.env === ft.env && t.name === ft.name,
      );
      const filePolicy = trusted ? ft.policy : undefined;
      // `config` steers where a credential points (host, project, ref): an untrusted file never re-points a
      // connected target; unconnected rows take it so the Connect flow is pre-filled.
      const fileConfig = trusted || !match || match.credentialRef === null ? (ft.config ?? {}) : {};
      const target: Target = match
        ? {
            ...match,
            config: { ...match.config, ...fileConfig },
            policy: filePolicy ?? match.policy,
            policySource: filePolicy ? 'project' : match.policySource,
            fromProjectFile: true,
          }
        : {
            id: newId<'TargetId'>(),
            projectId: project.id,
            provider: ft.provider,
            name: ft.name,
            env: ft.env,
            authMethod: ft.authMethod,
            policy: filePolicy ?? 'ask',
            policySource: filePolicy ? 'project' : 'app',
            credentialRef: null,
            health: 'unconnected',
            healthCheckedAt: null,
            expiredAt: null,
            config: ft.config ?? {},
            fromProjectFile: true,
            createdAt: clock.now(),
          };
      repos.targets.upsert(target);
      targetIds.push(target.id);
    }
    publisher.upsert('targets', targetIds);
    publisher.upsert('projects', [project.id]);
    publisher.settingsSet(undefined, { [project.id]: projectSettingsFor(repos, project.id) });
    if (trusted) this.clearPolicyBanner(project);
    else this.setPolicyBanner(project, hash);
    return { ok: true, error: null };
  }

  /** The file's current grant policy, its hash and the diff against what this machine accepted (Settings review row). */
  async pendingPolicy(
    projectId: string,
  ): Promise<{ hash: string; accepted: boolean; summary: ProjectPolicySummary; diff: ProjectPolicyDiff }> {
    const project = this.require(projectId);
    const summary = policySummaryOf(await this.readProjectFile(project));
    const hash = policyHashOf(summary);
    const before = this.acceptedPolicy(project.id);
    return {
      hash,
      accepted: this.isAccepted(project.id, summary, hash),
      summary,
      diff: policyDiff(before?.summary ?? null, summary),
    };
  }

  private async readProjectFile(project: Project): Promise<ProjectFileV1> {
    const file = join(project.path, PROJECT_FILE_PATH);
    if (!existsSync(file)) fail('not-found', `${project.name} has no ${PROJECT_FILE_PATH}`);
    const parsed = parseProjectFile(await readFile(file, 'utf8'));
    if (!parsed.ok) fail('invalid-input', parsed.error.message);
    return parsed.file;
  }

  /**
   * `project.policy.accept`: records the file's current policy hash as accepted on this machine, applies its rules and
   * target policies, clears the banner and audits `policy-changed` with the diff against the previously accepted set.
   * `hash` must match what is on disk now (the value the banner / review row showed), so a file rewritten between
   * review and click is never accepted unseen. Any later change to the hash (a new commit, a fresh clone) starts
   * untrusted again.
   */
  async acceptPolicies(projectId: string, hash: string): Promise<void> {
    const { repos, publisher } = this.deps;
    const project = this.require(projectId);
    const summary = policySummaryOf(await this.readProjectFile(project));
    const current = policyHashOf(summary);
    if (current !== hash)
      fail('invalid-input', `${PROJECT_FILE_PATH} changed since it was reviewed; review it again`);
    const before = this.acceptedPolicy(project.id);
    repos.uiState.set(acceptedKey(project.id), {
      hash: current,
      summary: redact(summary),
    } satisfies AcceptedProjectPolicy);
    await this.reconcileProjectFile(project.id);
    if (this.deps.audit) {
      const row = this.deps.audit.append({
        actorKind: 'you',
        actorLabel: 'you',
        action: 'policy-changed',
        ...auditContext(repos, { projectId: project.id }),
        triggeredBy: 'settings',
        detail: { file: PROJECT_FILE_PATH, hash: current, ...policyDiff(before?.summary ?? null, summary) },
      });
      publisher.upsert('auditEntries', [row.id]);
      const entry = repos.audit.get(row.id);
      if (entry && this.deps.activity) this.deps.activity.fromAudit(entry);
    }
  }

  /** The hash rides in `notifications.meta` so a restart can re-emit the banner with the same accept token. */
  private setPolicyBanner(project: Project, hash: string): void {
    const { repos, publisher, clock } = this.deps;
    const bannerKey = `${PROJECT_POLICY_BANNER_PREFIX}${project.id}`;
    const text = fill(copy.errors.projectPolicyUntrusted.text, { project: project.name });
    const existing = repos.notifications.byBannerKey(bannerKey);
    const id = existing?.id ?? `banner-${bannerKey}`;
    repos.notifications.upsert({
      id,
      kind: 'info',
      sessionId: null,
      askId: null,
      projectId: project.id,
      title: text,
      body: '',
      meta: hash,
      osDelivered: false,
      state: 'shown',
      bannerKey,
      createdAt: existing?.createdAt ?? clock.now(),
      resolvedAt: null,
    });
    publisher.upsert('notifications', [id]);
    publisher.sendEvent('banner.set', {
      bannerKey,
      kind: 'project-policy',
      text,
      cta: copy.errors.projectPolicyUntrusted.cta,
      action: { kind: 'review-project-policy', projectId: project.id, hash },
      sessionId: null,
      reason: null,
    });
  }

  private clearPolicyBanner(project: Project): void {
    const { repos, publisher, clock } = this.deps;
    const bannerKey = `${PROJECT_POLICY_BANNER_PREFIX}${project.id}`;
    const n = repos.notifications.byBannerKey(bannerKey);
    if (!n || n.state === 'resolved') return;
    repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: clock.now() });
    publisher.upsert('notifications', [n.id]);
    publisher.sendEvent('banner.clear', { bannerKey });
  }

  async setSettings(projectId: string, patch: Partial<ProjectSettings>): Promise<void> {
    const project = this.require(projectId);
    const current = this.deps.repos.projects.settings(project.id);
    const next: Partial<ProjectSettings> = { ...current };
    for (const k of PROJECT_KEYS) if (patch[k] !== undefined) (next as Record<string, unknown>)[k] = patch[k];
    await this.writeSettings(project, next);
  }

  async resetSetting(projectId: string, key: keyof ProjectSettings): Promise<void> {
    const project = this.require(projectId);
    const next = { ...this.deps.repos.projects.settings(project.id) };
    delete next[key];
    await this.writeSettings(project, next);
  }

  private async writeSettings(project: Project, next: Partial<ProjectSettings>): Promise<void> {
    const { repos, publisher, clock } = this.deps;
    // Real projects have absolute paths (`add` / `create` resolve them). A relative one — a fixture's display
    // path like `~/code/acme-shop` — never gets a file written under whatever the working directory happens to be.
    if (isAbsolute(project.path)) {
      const file = join(project.path, PROJECT_FILE_PATH);
      let base: ProjectFileV1 = { version: 1, name: project.name };
      if (existsSync(file)) {
        const parsed = parseProjectFile(await readFile(file, 'utf8'));
        if (parsed.ok) base = parsed.file;
      }
      const out = applySettingsToFile(base, next);
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, serializeProjectFile(out));
      } catch (e) {
        logger.warn('project.json write failed', { project: project.name, error: (e as Error).message });
      }
    }
    repos.projects.setSettings(project.id, next, clock.now());
    publisher.upsert('projects', [project.id]);
    publisher.settingsSet(undefined, { [project.id]: projectSettingsFor(repos, project.id) });
  }
}

/** Writes the flattened settings back into the file's nested shape; absent keys are removed from the file. */
export const applySettingsToFile = (file: ProjectFileV1, s: Partial<ProjectSettings>): ProjectFileV1 => {
  const out: ProjectFileV1 = { ...file };
  const agents: Record<string, unknown> = { ...(file.agents ?? {}) };
  const set = (obj: Record<string, unknown>, key: string, value: unknown) => {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
  };
  set(agents, 'default', s.defaultAgent);
  set(agents, 'model', s.model);
  // The reader (`projectSettingsFromFile`) takes these three; the writer had left them out, so the Agent
  // defaults page said "committed" of values that never reached the file.
  set(agents, 'permissionMode', s.permissionMode);
  set(agents, 'taskPermissionMode', s.taskPermissionMode);
  set(agents, 'effort', s.effort);
  set(agents, 'autoApproveEdits', s.autoApproveEdits);
  set(agents, 'mayRequestTargets', s.mayRequestTargets);
  set(agents, 'notifyWhenNeedsMe', s.notifyWhenNeedsMe);
  if (Object.keys(agents).length > 0) out.agents = agents as ProjectFileV1['agents'];
  else delete out.agents;
  const wt: Record<string, unknown> = { ...(file.worktrees ?? {}) };
  set(wt, 'baseBranch', s.baseBranch);
  set(wt, 'branchPrefix', s.branchPrefix);
  set(wt, 'location', s.worktreeLocation);
  if (Object.keys(wt).length > 0) out.worktrees = wt as ProjectFileV1['worktrees'];
  else delete out.worktrees;
  const shell: Record<string, unknown> = { ...(file.shell ?? {}) };
  set(shell, 'windows', s.shellWindows);
  if (Object.keys(shell).length > 0) out.shell = shell as ProjectFileV1['shell'];
  else delete out.shell;
  if (s.lineEndings !== undefined) out.lineEndings = s.lineEndings;
  else delete out.lineEndings;
  // `devUrl` / `devCommand` are flattened from `dev.url` / `dev.command`; null means "cleared" (the key goes), and
  // the block goes once it is empty rather than storing nulls.
  if (
    s.devUrl !== undefined ||
    s.devCommand !== undefined ||
    s.devPlatform !== undefined ||
    s.devDevice !== undefined ||
    s.devAppId !== undefined
  ) {
    const dev: Record<string, unknown> = { ...(file.dev ?? {}) };
    const put = (key: string, value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null) delete dev[key];
      else dev[key] = value;
    };
    put('url', s.devUrl);
    put('command', s.devCommand);
    put('platform', s.devPlatform);
    put('device', s.devDevice);
    put('appId', s.devAppId);
    if (Object.keys(dev).length > 0) out.dev = dev as ProjectFileV1['dev'];
    else delete out.dev;
  }
  const env: Record<string, unknown> = { ...(file.env ?? {}) };
  set(env, 'files', s.envFiles);
  set(env, 'shareWithAgents', s.envShareWithAgents);
  if (Object.keys(env).length > 0) out.env = env as ProjectFileV1['env'];
  else delete out.env;
  return out;
};

/** `policies.extra` → engine `Policy` rows; ord follows file order and ids are namespaced so they never collide with app rules. */
export const projectFileRules = (file: ProjectFileV1, now: number): Policy[] =>
  (file.policies?.extra ?? []).map((p, i) => ({
    id: idFrom<'PolicyId'>(`project:${p.id}`),
    ord: i + 1,
    rule: p.rule,
    ruleText: p.ruleText,
    enabled: p.enabled ?? true,
    builtinKey: null,
    matchCountToday: 0,
    matchCountWeek: 0,
    countersResetAt: null,
    createdAt: now,
  }));

/** Spec §4.9: unchecked by default when there is no remote *and* the repo is stale (no activity within a year). */
export const isSuggested = (remote: string | null, lastModifiedAt: number | null, now: number): boolean => {
  const stale = lastModifiedAt === null || now - lastModifiedAt > STALE_MS;
  return !(remote === null && stale);
};

/** Plain folders (no remote to go by): suggested when opened within the staleness window. */
export const isRecent = (at: number | null, now: number): boolean => at !== null && now - at <= STALE_MS;

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Git repos first; within each, most recent activity first, unknown activity last; path breaks ties so the list is stable. */
export const byLastActivity = (a: ScannedRepo, b: ScannedRepo): number =>
  Number(b.hasGit) - Number(a.hasGit) ||
  (b.lastModifiedAt ?? -Infinity) - (a.lastModifiedAt ?? -Infinity) ||
  a.path.localeCompare(b.path);

/**
 * Filesystem hits, IDE recents and agent history merged into one candidate list: known paths drop out, a folder found
 * by several sources keeps the first-listed one (scan → ide-recent → claude → codex; the agent list is already one
 * row per path), and the result is sorted by path (scan re-sorts by activity once repos are described).
 */
export const mergeCandidates = (
  fsPaths: readonly string[],
  ideRecents: readonly string[],
  agentDirs: readonly { path: string; source: 'claude' | 'codex' }[],
  known: ReadonlySet<string>,
): { path: string; source: ScanSource }[] => {
  const byPath = new Map<string, ScanSource>();
  const put = (path: string, source: ScanSource) => {
    if (!known.has(path) && !byPath.has(path)) byPath.set(path, source);
  };
  for (const p of fsPaths) put(p, 'scan');
  for (const p of ideRecents) put(p, 'ide-recent');
  for (const d of agentDirs) put(d.path, d.source);
  return [...byPath.entries()]
    .map(([path, source]) => ({ path, source }))
    .sort((a, b) => a.path.localeCompare(b.path));
};

const under = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Agent-history directories that are never projects: the home itself, anything with a `.styx` segment (Styx's own
 * agent worktrees, `<repo>/.styx/…`) and scratch directories under the OS temp dir (Claude Code's
 * `/tmp/claude-<uid>/…/scratchpad`) — unless the temp dir is where the home lives (tests).
 */
export const isTransientPath = (path: string, home: string, tmp: string = tmpdir()): boolean =>
  path === home || path.split(sep).includes('.styx') || (under(path, tmp) && !under(path, home));
