import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { TREE_IGNORED_DIRS, TREE_MAX_NODES, newId, repoHasGit, type Worktree } from '@styx/core';
import type { Container } from '../../container';
import { confine } from '../../services/confine';
import { worktreeLocation } from '../../services/git';
import { projectSettingsFor } from '../../store/projection';
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
  // Commit / push / PR in one step (PublishService, ADR-0021). `app.publish` is read per call so a test can
  // swap in a service with a fake exec.
  bus.register('worktree.generateMessage', ({ worktreeId, kind }) =>
    app.publish.generateMessage(worktreeId, kind),
  );
  bus.register('worktree.publish', ({ worktreeId, through, message, draft }) =>
    app.publish.publish(worktreeId, { through, message, draft }),
  );

  const { repos, git, publisher, hunks, clock } = app;

  const requireWorktree = (id: string): Worktree =>
    repos.worktrees.get(id) ?? fail('not-found', `worktree ${id} not found`);

  bus.register('worktree.create', async ({ projectId, branch, base }) => {
    const project = repos.projects.get(projectId) ?? fail('not-found', `project ${projectId} not found`);
    const repo = repos.repos.byProject(project.id) ?? fail('not-found', 'project has no repo');
    if (!repoHasGit(repo)) fail('git-error', `${project.name} is not a git repository`);
    const path = worktreeLocation(project.path, branch);
    if (
      projectSettingsFor(repos, project.id).syncOnSpawn.value &&
      (await git.remotes(project.path)).length > 0
    )
      await git.fetch(project.path).catch(() => undefined);
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
      behindBase: 0,
      overlaps: [],
      resolution: null,
      landing: null,
      mergedAt: null,
      createdAt: clock.now(),
      archivedAt: null,
    };
    repos.worktrees.upsert(wt);
    publisher.upsert('worktrees', [wt.id]);
    return { worktreeId: wt.id };
  });

  bus.register('worktree.archive', async ({ worktreeId }) => {
    await app.worktrees.archive(worktreeId);
    return {};
  });

  // Keep lanes current (ADR-0023): fetch, ahead/behind, every lane's distance from the base and its conflict state.
  bus.register('worktree.fetch', ({ projectId }) => app.laneSync.refresh(projectId));
  bus.register('worktree.sync', ({ worktreeId }) => app.laneSync.sync(worktreeId));
  bus.register('worktree.resolve', ({ worktreeId }) => app.resolver.resolve(worktreeId));
  bus.register('worktree.undoResolve', async ({ worktreeId }) => {
    await app.resolver.undo(worktreeId);
    return {};
  });
  // Landing (ADR-0025 phase C).
  bus.register('worktree.landPreview', ({ worktreeId }) => app.land.preview(worktreeId));
  bus.register('worktree.land', ({ worktreeId, message }) => app.land.land(worktreeId, message));
  bus.register('worktree.undoLand', async ({ worktreeId }) => {
    await app.land.undo(worktreeId);
    return {};
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

  bus.register('fs.watchTree', async ({ worktreeId }, ctx) => {
    requireWorktree(worktreeId);
    await app.treeWatch.watch(ctx.senderId, worktreeId);
    return {};
  });
  bus.register('fs.unwatchTree', async (_input, ctx) => {
    await app.treeWatch.unwatch(ctx.senderId);
    return {};
  });

  /**
   * Directories that contain a change, worked out once from the status map rather than re-scanned per entry.
   * `src/a/b.ts` marks `src` and `src/a`; an untracked file marks its ancestors as `?` only if nothing tracked
   * there is modified, because a folder holding real edits should not read as merely untracked.
   */
  const dirMarks = (statuses: Map<string, 'M' | 'A' | 'D' | '?'>): Map<string, 'M' | '?'> => {
    const marks = new Map<string, 'M' | '?'>();
    for (const [file, st] of statuses) {
      const mark: 'M' | '?' = st === '?' ? '?' : 'M';
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        if (mark === 'M' || !marks.has(dir)) marks.set(dir, mark);
      }
    }
    return marks;
  };

  /**
   * The whole tree in one pass (discrepancy #115): one `git status`, `readdir` with dirents so a file's kind
   * costs no extra syscall, and siblings read in parallel. What used to be ~113 IPC calls and ~113 `git status`
   * runs per project switch is now one of each.
   */
  bus.register('fs.readTree', async ({ worktreeId, maxDepth }) => {
    const wt = requireWorktree(worktreeId);
    const statuses = await git.statusMap(wt.path).catch(() => new Map<string, 'M' | 'A' | 'D' | '?'>());
    const marks = dirMarks(statuses);
    const ignored = new Set(TREE_IGNORED_DIRS);
    const nodes: {
      path: string;
      name: string;
      kind: 'file' | 'dir';
      depth: number;
      status: 'M' | 'A' | 'D' | '?' | null;
    }[] = [];
    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (truncated) return;
      let entries;
      try {
        entries = await readdir(dir === '' ? wt.path : join(wt.path, dir), { withFileTypes: true });
      } catch {
        return; // a directory that vanished mid-walk is not an error worth failing the tree over
      }
      // Directories first, then names — the order the pane renders, settled here so it need not sort.
      const sorted = entries
        .filter((e) => !(e.isDirectory() && ignored.has(e.name)) && e.name !== '.git')
        .sort((a, b) =>
          a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
        );
      for (const entry of sorted) {
        if (nodes.length >= TREE_MAX_NODES) {
          truncated = true;
          return;
        }
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
        const isDir = entry.isDirectory();
        nodes.push({
          path,
          name: entry.name,
          kind: isDir ? 'dir' : 'file',
          depth,
          status: isDir ? (marks.get(path) ?? null) : (statuses.get(path) ?? null),
        });
        if (isDir && depth + 1 < maxDepth) await walk(path, depth + 1);
      }
    };

    await walk('', 0);
    return { nodes, truncated };
  });

  bus.register('fs.listDir', async ({ worktreeId, path }) => {
    const wt = requireWorktree(worktreeId);
    const full = confine(wt.path, path);
    // Dirents carry the kind, so a listing costs one syscall rather than one per entry (measured on a
    // 706-entry directory: 12.5 ms of sequential `stat` down to 1.1 ms).
    const dirents = await readdir(full, { withFileTypes: true });
    const statuses = await git.statusMap(wt.path).catch(() => new Map<string, 'M' | 'A' | 'D' | '?'>());
    const marks = dirMarks(statuses);
    const entries: { name: string; kind: 'file' | 'dir'; gitStatus: 'M' | 'A' | 'D' | '?' | null }[] = [];
    for (const entry of dirents) {
      if (entry.name === '.git') continue;
      const kind: 'file' | 'dir' = entry.isDirectory() ? 'dir' : 'file';
      const rel = relative(wt.path, join(full, entry.name)).split(sep).join('/');
      const gitStatus = kind === 'dir' ? (marks.get(rel) ?? null) : (statuses.get(rel) ?? null);
      entries.push({ name: entry.name, kind, gitStatus });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return { entries };
  });
}
