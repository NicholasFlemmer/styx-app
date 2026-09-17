import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { newId, repoHasGit, type Worktree } from '@styx/core';
import type { Container } from '../../container';
import { confine } from '../../services/confine';
import { worktreeLocation } from '../../services/git';
import { type CommandBus, fail } from '../bus';

/** Subsequence match (`srcchk` hits `src/components/checkout.ts`), the `@` picker's cheap fuzzy filter. */
export const fuzzyMatch = (text: string, query: string): boolean => {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return i === query.length;
};

/**
 * `fs.find` ranking for the `@` picker: exact basename matches first, then paths (or basenames) that start with the
 * query, then paths containing it, then subsequence hits; original (ls-files) order within a tier. Case-insensitive
 * on a trimmed query; an empty query keeps every path in order.
 */
export const rankFiles = (paths: readonly string[], query: string): string[] => {
  const q = query.trim().toLowerCase();
  if (q === '') return [...paths];
  const exact: string[] = [];
  const prefix: string[] = [];
  const substring: string[] = [];
  const subsequence: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = basename(lower);
    if (base === q) exact.push(p);
    else if (lower.startsWith(q) || base.startsWith(q)) prefix.push(p);
    else if (lower.includes(q)) substring.push(p);
    else if (fuzzyMatch(lower, q)) subsequence.push(p);
  }
  return [...exact, ...prefix, ...substring, ...subsequence];
};

/** worktree.* · hunk.* · fs.* */
export function registerWorktreeCommands(bus: CommandBus, app: Container): void {
  // Commit / push / PR in one step: filled by the publish work package (PublishService).
  bus.register('worktree.generateMessage', async ({ worktreeId, kind }) => {
    const svc = app.publish;
    if (!svc) fail('internal', 'publish unavailable');
    return svc.generateMessage(worktreeId, kind);
  });
  bus.register('worktree.publish', async ({ worktreeId, through, message, draft }) => {
    const svc = app.publish;
    if (!svc) fail('internal', 'publish unavailable');
    return svc.publish(worktreeId, { through, message, draft });
  });

  const { repos, git, publisher, hunks, clock } = app;

  const requireWorktree = (id: string): Worktree =>
    repos.worktrees.get(id) ?? fail('not-found', `worktree ${id} not found`);

  bus.register('worktree.create', async ({ projectId, branch, base }) => {
    const project = repos.projects.get(projectId) ?? fail('not-found', `project ${projectId} not found`);
    const repo = repos.repos.byProject(project.id) ?? fail('not-found', 'project has no repo');
    if (!repoHasGit(repo)) fail('git-error', `${project.name} is not a git repository`);
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
    if (!repoHasGit(repo)) return { ahead: 0, behind: 0 }; // plain folder: nothing to fetch
    await git.fetch(project.path);
    const status = await git.status(project.path);
    const ab = status.upstream
      ? await git.aheadBehind(project.path, status.branch, status.upstream)
      : { ahead: status.ahead, behind: status.behind };
    repos.repos.upsert({ ...repo, ahead: ab.ahead, behind: ab.behind, fetchedAt: clock.now() });
    publisher.upsert('repos', [repo.id]);
    const ids: string[] = [];
    for (const wt of repos.worktrees.byProject(project.id)) {
      if (wt.isMain || wt.archivedAt !== null || wt.branch === null) continue;
      const conflict = await git
        .detectConflict(project.path, wt.branch, repo.defaultBranch ?? 'main')
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
    if (!repoHasGit(repos.repos.get(wt.repoId))) return { diff: '' }; // plain folder: no diffs
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

  // --- hunks --- (the agent already applied its edits: revert / revert all / mark reviewed; no accept)
  bus.register('hunk.revert', async ({ hunkId }) => {
    await hunks.revert(hunkId);
    return {};
  });
  bus.register('hunk.revertAll', async ({ sessionId }) => {
    await hunks.revertAll(sessionId);
    return {};
  });
  bus.register('hunk.done', ({ sessionId }) => ({ reviewed: hunks.done(sessionId) }));

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

  bus.register('fs.find', async ({ worktreeId, query, limit }) => {
    const wt = requireWorktree(worktreeId);
    const hits = rankFiles(await git.listFiles(wt.path), query);
    return { paths: hits.slice(0, limit), truncated: hits.length > limit };
  });

  // Transcript links only: https, never file:, http: or custom schemes (index.ts checks again at the shell edge).
  bus.register('link.open', async ({ url }) => {
    if (!/^https:\/\//i.test(url)) fail('invalid-input', 'only https links open in the browser');
    await app.openExternal(url);
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
