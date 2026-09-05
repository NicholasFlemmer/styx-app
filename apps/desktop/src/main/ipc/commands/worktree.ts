import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { newId, type Worktree } from '@styx/core';
import type { Container } from '../../container';
import { worktreeLocation } from '../../services/git';
import { type CommandBus, fail } from '../bus';

/** Real path of `p`; when it does not exist yet, the real path of its nearest existing ancestor plus the rest. */
function realpathLenient(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return missing.length ? join(realpathSync(cur), ...missing) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * `path.resolve(root, p)` must stay inside `root` (rules/ipc.md), checked on real paths so a symlink inside the
 * worktree cannot point outside it (L6; not-yet-existing files resolve through their parent). Returns the logical
 * absolute path so callers can still `relative()` it against the worktree path.
 */
export function confine(root: string, p: string): string {
  const base = resolve(root);
  const full = resolve(base, p);
  const realBase = realpathLenient(base);
  const realFull = realpathLenient(full);
  if (realFull === realBase) return full;
  if (!realFull.startsWith(realBase + sep)) fail('fs-denied', `${p} is outside the worktree`);
  return full;
}

/** worktree.* · hunk.* · fs.* */
export function registerWorktreeCommands(bus: CommandBus, app: Container): void {
  const { repos, git, publisher, hunks, clock } = app;

  const requireWorktree = (id: string): Worktree =>
    repos.worktrees.get(id) ?? fail('not-found', `worktree ${id} not found`);

  bus.register('worktree.create', async ({ projectId, branch, base }) => {
    const project = repos.projects.get(projectId) ?? fail('not-found', `project ${projectId} not found`);
    const repo = repos.repos.byProject(project.id) ?? fail('not-found', 'project has no repo');
    const path = worktreeLocation(project.path, branch);
    await git.worktreeAdd(project.path, { branch, base, path });
    const head = await git.headCommit(path);
    const wt: Worktree = {
      id: newId<'WorktreeId'>(),
      repoId: repo.id,
      projectId: project.id,
      branch,
      path,
      isMain: false,
      owner: { kind: 'user' },
      baseCommit: head,
      headCommit: head,
      changes: { added: 0, removed: 0, files: 0 },
      pr: null,
      conflict: null,
      mergedAt: null,
      createdAt: clock.now(),
      archivedAt: null,
    };
    repos.worktrees.upsert(wt);
    publisher.upsert('worktrees', [wt.id]);
    return { worktreeId: wt.id };
  });

  bus.register('worktree.archive', async ({ worktreeId }) => {
    const wt = requireWorktree(worktreeId);
    if (wt.isMain) fail('forbidden', 'the main worktree cannot be archived');
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    for (const s of repos.sessions.byProject(project.id))
      if (s.worktreeId === wt.id && s.state !== 'done') app.sessions.stop(s.id);
    await hunks.unwatch(wt.id);
    await git.worktreeRemove(project.path, wt.path, true).catch(() => undefined);
    repos.worktrees.upsert({ ...wt, archivedAt: clock.now() });
    publisher.upsert('worktrees', [wt.id]);
    return {};
  });

  bus.register('worktree.fetch', async ({ projectId }) => {
    const project = repos.projects.get(projectId) ?? fail('not-found', `project ${projectId} not found`);
    const repo = repos.repos.byProject(project.id) ?? fail('not-found', 'project has no repo');
    await git.fetch(project.path);
    const status = await git.status(project.path);
    const ab = status.upstream
      ? await git.aheadBehind(project.path, status.branch, status.upstream)
      : { ahead: status.ahead, behind: status.behind };
    repos.repos.upsert({ ...repo, ahead: ab.ahead, behind: ab.behind, fetchedAt: clock.now() });
    publisher.upsert('repos', [repo.id]);
    const ids: string[] = [];
    for (const wt of repos.worktrees.byProject(project.id)) {
      if (wt.isMain || wt.archivedAt !== null) continue;
      const conflict = await git
        .detectConflict(project.path, wt.branch, repo.defaultBranch)
        .catch(() => null);
      if ((conflict?.file ?? null) !== (wt.conflict?.file ?? null)) {
        repos.worktrees.upsert({ ...wt, conflict });
        ids.push(wt.id);
        const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
        if (owner && conflict && owner.state !== 'done')
          app.sessions.applyEvent(owner.id, { type: 'error', reason: 'conflict' });
        if (owner && !conflict && owner.state === 'paused' && owner.pausedReason === 'conflict')
          app.sessions.applyEvent(owner.id, { type: 'resolve' });
      }
    }
    publisher.upsert('worktrees', ids);
    return ab;
  });

  bus.register('worktree.diff', async ({ worktreeId, file }) => {
    const wt = requireWorktree(worktreeId);
    const base = wt.isMain ? 'HEAD' : (wt.baseCommit ?? 'HEAD');
    return { diff: await git.diff(wt.path, base, file ? [file] : undefined) };
  });

  bus.register('worktree.openInIde', async ({ worktreeId, file }) => {
    const wt = requireWorktree(worktreeId);
    const settings = repos.settings.app();
    const ide =
      repos.discovery.ides().find((i) => i.isFallback) ??
      repos.discovery.ides().find((i) => i.kind === settings.fallbackIde);
    if (!ide?.launcher) fail('not-found', 'no fallback editor is configured');
    await app.openInIde(ide.launcher, file ? confine(wt.path, file) : wt.path);
    return {};
  });

  // --- hunks ---
  bus.register('hunk.accept', async ({ hunkId }) => {
    await hunks.accept(hunkId);
    return {};
  });
  bus.register('hunk.reject', async ({ hunkId }) => {
    await hunks.reject(hunkId);
    return {};
  });
  bus.register('hunk.acceptAll', async ({ sessionId }) => {
    await hunks.acceptAll(sessionId);
    return {};
  });
  bus.register('hunk.rejectAll', async ({ sessionId }) => {
    await hunks.rejectAll(sessionId);
    return {};
  });
  bus.register('hunk.done', ({ sessionId }) => ({ applied: hunks.done(sessionId) }));

  // --- fs (confined to the worktree) ---
  bus.register('fs.readFile', async ({ worktreeId, path }) => {
    const wt = requireWorktree(worktreeId);
    const full = confine(wt.path, path);
    const text = await readFile(full, 'utf8');
    return { text, eol: /\r\n/.test(text) ? 'crlf' : 'lf' };
  });

  bus.register('fs.writeFile', async ({ worktreeId, path, text }) => {
    const wt = requireWorktree(worktreeId);
    const full = confine(wt.path, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
    return {};
  });

  bus.register('fs.listDir', async ({ worktreeId, path }) => {
    const wt = requireWorktree(worktreeId);
    const full = confine(wt.path, path);
    const names = await readdir(full);
    const statuses = await git.statusMap(wt.path).catch(() => new Map<string, 'M' | 'A' | 'D' | '?'>());
    const entries: { name: string; kind: 'file' | 'dir'; gitStatus: 'M' | 'A' | 'D' | '?' | null }[] = [];
    for (const name of names) {
      if (name === '.git') continue;
      const p = join(full, name);
      let kind: 'file' | 'dir' = 'file';
      try {
        kind = (await stat(p)).isDirectory() ? 'dir' : 'file';
      } catch {
        continue;
      }
      const rel = relative(wt.path, p).split(sep).join('/');
      let gitStatus: 'M' | 'A' | 'D' | '?' | null = statuses.get(rel) ?? null;
      if (kind === 'dir' && gitStatus === null) {
        for (const [k, v] of statuses)
          if (k.startsWith(`${rel}/`)) {
            gitStatus = v === '?' ? '?' : 'M';
            break;
          }
      }
      entries.push({ name, kind, gitStatus });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return { entries };
  });
}
