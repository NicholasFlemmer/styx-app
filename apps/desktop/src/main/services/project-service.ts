import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  newId,
  parseProjectFile,
  PROJECT_FILE_PATH,
  projectSettingsFromFile,
  serializeProjectFile,
  type Project,
  type ProjectFileV1,
  type ProjectId,
  type ProjectSettings,
  type Repo,
  type Target,
  type Worktree,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import { projectSettingsFor } from '../store/projection';
import type { Publisher } from '../store/publisher';
import type { GitService } from './git';
import { logger } from './logger';

export interface ProjectServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  git: GitService;
  platform: NodeJS.Platform;
  home?: string;
  /** `resources/templates/<name>` for `project.create` templates. */
  templatesDir: string | null;
}

export interface ScannedRepo {
  path: string;
  remote: string | null;
  branch: string | null;
  source: 'scan' | 'ide-recent';
  lastModifiedAt: number | null;
  suggested: boolean;
}

const SCAN_DEPTH = 3;
const STALE_MS = 90 * 24 * 3_600_000;
const SKIP_DIRS = new Set([
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

export const initialsOf = (name: string): string => {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const first = parts[0] ?? name;
  const second = parts[1];
  const s = second ? `${first[0] ?? ''}${second[0] ?? ''}` : first.slice(0, 2);
  return (s || 'PR').toUpperCase();
};

const PROJECT_KEYS: (keyof ProjectSettings)[] = [
  'defaultAgent',
  'model',
  'autoApproveEdits',
  'mayRequestTargets',
  'notifyWhenNeedsMe',
  'baseBranch',
  'branchPrefix',
  'worktreeLocation',
  'shellWindows',
  'lineEndings',
  'envFiles',
  'envShareWithAgents',
];

/** Projects, repos and the `.styx/project.json` reconcile (plan §4, §5). Never writes secrets to the file. */
export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  private get home(): string {
    return this.deps.home ?? homedir();
  }

  require(id: string): Project {
    return this.deps.repos.projects.get(id) ?? fail('not-found', `project ${id} not found`);
  }

  // --- scan ------------------------------------------------------------------

  async scan(includeIdeRecents: boolean): Promise<ScannedRepo[]> {
    const roots = [
      join(this.home, 'code'),
      join(this.home, 'work'),
      join(this.home, 'dev'),
      join(this.home, 'src'),
    ];
    if (this.deps.platform === 'win32') roots.push('C:\\dev');
    const found = new Set<string>();
    for (const root of roots) if (existsSync(root)) await this.walk(root, 0, found);
    void includeIdeRecents; // TODO(ide-import): merge IDE recents (VS Code state.vscdb, JetBrains recentProjects.xml) as source 'ide-recent'.
    const known = new Set(this.deps.repos.projects.all().map((p) => p.path));
    const out: ScannedRepo[] = [];
    const now = this.deps.clock.now();
    for (const path of [...found].sort()) {
      if (known.has(path)) continue;
      let remote: string | null = null;
      let branch: string | null = null;
      let lastModifiedAt: number | null = null;
      try {
        const rs = await this.deps.git.remotes(path);
        remote = rs.find((r) => r.name === 'origin')?.url ?? rs[0]?.url ?? null;
        branch = await this.deps.git.currentBranch(path);
        lastModifiedAt = (await stat(join(path, '.git'))).mtimeMs;
      } catch {
        /* unreadable repo: still listed */
      }
      const stale = lastModifiedAt === null || now - lastModifiedAt > STALE_MS;
      out.push({
        path,
        remote,
        branch,
        source: 'scan',
        lastModifiedAt: lastModifiedAt === null ? null : Math.round(lastModifiedAt),
        suggested: !(remote === null && stale),
      });
    }
    return out;
  }

  private async walk(dir: string, depth: number, found: Set<string>): Promise<void> {
    if (depth > SCAN_DEPTH) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    if (entries.includes('.git')) {
      found.add(dir);
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.') || SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      try {
        if ((await stat(p)).isDirectory()) await this.walk(p, depth + 1, found);
      } catch {
        /* skip */
      }
    }
  }

  // --- add / clone / create ---------------------------------------------------

  async add(rawPath: string, name?: string): Promise<Project> {
    const { repos, git, clock, publisher } = this.deps;
    const path = resolve(rawPath.replace(/^~(?=$|[\\/])/, this.home));
    const existing = repos.projects.byPath(path);
    if (existing) return existing;
    if (!existsSync(path)) fail('not-found', `${path} does not exist`);
    if (!(await git.isRepo(path))) fail('git-error', `${path} is not a git repository`);
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
    const remotes = await git.remotes(path);
    const defaultBranch = await git.defaultBranch(path);
    const branch = (await git.currentBranch(path)) ?? defaultBranch;
    const head = await git.headCommit(path);
    const status = await git.status(path).catch(() => null);
    const repo: Repo = {
      id: newId<'RepoId'>(),
      projectId: project.id,
      defaultBranch,
      remotes: remotes.map((r) => ({ name: r.name, url: r.url })),
      ahead: status?.ahead ?? 0,
      behind: status?.behind ?? 0,
      fetchedAt: null,
      lineEndings: 'auto',
      longPaths: this.deps.platform === 'win32',
    };
    const main: Worktree = {
      id: newId<'WorktreeId'>(),
      repoId: repo.id,
      projectId: project.id,
      branch,
      path,
      isMain: true,
      owner: { kind: 'user' },
      baseCommit: head,
      headCommit: head,
      changes: { added: 0, removed: 0, files: 0 },
      pr: null,
      conflict: null,
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

  async clone(url: string, into: string): Promise<Project> {
    const target = resolve(into.replace(/^~(?=$|[\\/])/, this.home));
    await mkdir(dirname(target), { recursive: true });
    await this.deps.git.clone(url, target);
    return this.add(target);
  }

  async create(input: {
    name: string;
    location: string;
    gitInit: boolean;
    template: string | null;
    copyTargetsFrom: string | null;
  }): Promise<Project> {
    const location = resolve(input.location.replace(/^~(?=$|[\\/])/, this.home));
    const dir = basename(location) === input.name ? location : join(location, input.name);
    if (existsSync(dir) && (await readdir(dir)).length > 0 && !(await this.deps.git.isRepo(dir)))
      fail('invalid-input', `${dir} exists and is not empty`);
    await mkdir(dir, { recursive: true });
    if (input.template && this.deps.templatesDir) {
      const src = join(this.deps.templatesDir, input.template);
      if (existsSync(src)) await cp(src, dir, { recursive: true });
      else logger.warn('project.create: template not found', { template: input.template });
    }
    const readme = join(dir, 'README.md');
    if (!existsSync(readme)) await writeFile(readme, `# ${input.name}\n`);
    if (input.gitInit || !(await this.deps.git.isRepo(dir))) {
      if (!(await this.deps.git.isRepo(dir))) {
        await this.deps.git.init(dir);
        await this.deps.git.add(dir, ['.']);
        await this.deps.git.commit(dir, 'Initial commit');
      }
    }
    const project = await this.add(dir, input.name);
    if (input.copyTargetsFrom) this.copyTargets(input.copyTargetsFrom, project.id);
    return this.require(project.id);
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

  async remove(
    projectId: string,
    deleteFiles: boolean,
  ): Promise<{ sessionIds: string[]; worktreePaths: string[] }> {
    const { repos, publisher } = this.deps;
    const project = this.require(projectId);
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
    // Re-pack rail order.
    const rest = repos.projects.all();
    rest.forEach((p, i) => repos.projects.upsert({ ...p, railOrder: i }));
    publisher.upsert(
      'projects',
      rest.map((p) => p.id),
    );
    if (deleteFiles) {
      const home = resolve(this.home);
      const inHome = project.path.startsWith(home + '/') || project.path.startsWith(home + '\\');
      if (!inHome || project.path === home)
        fail('fs-denied', 'refusing to delete a folder outside the home directory');
      await rm(project.path, { recursive: true, force: true });
    }
    return { sessionIds, worktreePaths: worktrees.filter((w) => !w.isMain).map((w) => w.path) };
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
    const targetIds: string[] = [];
    const existing = repos.targets.byProject(project.id);
    for (const ft of parsed.file.targets ?? []) {
      const match = existing.find(
        (t) => t.provider === ft.provider && t.env === ft.env && t.name === ft.name,
      );
      const target: Target = match
        ? {
            ...match,
            config: { ...match.config, ...(ft.config ?? {}) },
            policy: ft.policy ?? match.policy,
            policySource: ft.policy ? 'project' : match.policySource,
            fromProjectFile: true,
          }
        : {
            id: newId<'TargetId'>(),
            projectId: project.id,
            provider: ft.provider,
            name: ft.name,
            env: ft.env,
            authMethod: ft.authMethod,
            policy: ft.policy ?? 'ask',
            policySource: ft.policy ? 'project' : 'app',
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
    return { ok: true, error: null };
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
  const env: Record<string, unknown> = { ...(file.env ?? {}) };
  set(env, 'files', s.envFiles);
  set(env, 'shareWithAgents', s.envShareWithAgents);
  if (Object.keys(env).length > 0) out.env = env as ProjectFileV1['env'];
  else delete out.env;
  return out;
};
