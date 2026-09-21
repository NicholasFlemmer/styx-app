import { execa, type Options as ExecaOptions } from 'execa';
import type { Dirent } from 'node:fs';
import { join, sep } from 'node:path';
import { logger } from './logger';

export interface GitStatus {
  branch: string;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: { path: string; kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' }[];
  clean: boolean;
}

export interface NumStat {
  added: number;
  removed: number;
  files: number;
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  main: boolean;
}

export interface ConflictInfo {
  file: string;
  against: string;
}

export interface GitRunOptions {
  reject?: boolean;
  input?: string;
  /** Extra environment (e.g. `GIT_CONFIG_*` for a one-shot auth header); never logged. */
  env?: Record<string, string>;
}

export interface GitRunner {
  run(
    args: string[],
    cwd: string,
    opts?: GitRunOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export class ExecaGitRunner implements GitRunner {
  constructor(private readonly gitBin = 'git') {}
  async run(args: string[], cwd: string, opts: GitRunOptions = {}) {
    const options: ExecaOptions = {
      cwd,
      reject: opts.reject ?? true,
      stripFinalNewline: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(opts.env ?? {}) },
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    };
    try {
      const r = await execa(this.gitBin, args, options);
      return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 0 };
    } catch (e) {
      const err = e as { stderr?: string; exitCode?: number; message: string };
      throw new Error(`git ${args.join(' ')} failed (${err.exitCode ?? '?'}): ${err.stderr || err.message}`);
    }
  }
}

/** Wraps system git (≥2.38 for merge-tree --write-tree). All paths are absolute. */
export class GitService {
  constructor(private readonly git: GitRunner = new ExecaGitRunner()) {}

  async version(): Promise<string> {
    const { stdout } = await this.git.run(['--version'], process.cwd());
    return stdout.replace(/^git version\s*/, '').trim();
  }

  async isRepo(path: string): Promise<boolean> {
    const r = await this.git.run(['rev-parse', '--is-inside-work-tree'], path, { reject: false });
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  }

  async init(path: string, defaultBranch = 'main'): Promise<void> {
    await this.git.run(['init', '-q', '-b', defaultBranch], path);
  }

  async headCommit(path: string): Promise<string | null> {
    const r = await this.git.run(['rev-parse', 'HEAD'], path, { reject: false });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  async defaultBranch(path: string): Promise<string> {
    const r = await this.git.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], path, {
      reject: false,
    });
    if (r.exitCode === 0) return r.stdout.trim().replace(/^origin\//, '');
    for (const b of ['main', 'master']) {
      const has = await this.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${b}`], path, {
        reject: false,
      });
      if (has.exitCode === 0) return b;
    }
    const cur = await this.git.run(['branch', '--show-current'], path, { reject: false });
    return cur.stdout.trim() || 'main';
  }

  async remotes(
    path: string,
  ): Promise<
    { name: string; url: string; host: 'github' | 'gitlab' | 'other'; owner?: string; repo?: string }[]
  > {
    const r = await this.git.run(['remote', '-v'], path, { reject: false });
    const seen = new Map<string, string>();
    for (const line of r.stdout.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
      if (m && m[1] && m[2]) seen.set(m[1], m[2]);
    }
    return [...seen].map(([name, url]) => {
      const host = remoteHost(url);
      const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
      return { name, url, host, ...(m && m[1] && m[2] ? { owner: m[1], repo: m[2] } : {}) };
    });
  }

  async status(path: string): Promise<GitStatus> {
    const { stdout } = await this.git.run(['status', '--porcelain=v2', '--branch', '-z'], path);
    const status: GitStatus = {
      branch: '',
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changed: [],
      clean: true,
    };
    const entries = stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      if (e.startsWith('# branch.head ')) status.branch = e.slice('# branch.head '.length);
      else if (e.startsWith('# branch.oid '))
        status.head =
          e.slice('# branch.oid '.length) === '(initial)' ? null : e.slice('# branch.oid '.length);
      else if (e.startsWith('# branch.upstream ')) status.upstream = e.slice('# branch.upstream '.length);
      else if (e.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(e);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      } else if (e.startsWith('1 ') || e.startsWith('2 ')) {
        const parts = e.split(' ');
        const xy = parts[1] ?? '..';
        const file = e.startsWith('2 ') ? (parts.slice(9).join(' ') ?? '') : parts.slice(8).join(' ');
        if (e.startsWith('2 ')) i++; // rename: next entry is the original path
        const kind = xy.includes('A')
          ? 'added'
          : xy.includes('D')
            ? 'deleted'
            : xy.includes('R')
              ? 'renamed'
              : 'modified';
        status.changed.push({ path: file, kind });
      } else if (e.startsWith('u ')) {
        const parts = e.split(' ');
        status.changed.push({ path: parts.slice(10).join(' '), kind: 'conflict' });
      } else if (e.startsWith('? ')) {
        status.changed.push({ path: e.slice(2), kind: 'untracked' });
      }
    }
    status.clean = status.changed.length === 0;
    return status;
  }

  async numstat(path: string, base: string): Promise<NumStat> {
    const { stdout } = await this.git.run(['diff', '--numstat', base], path);
    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of stdout.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files++;
      if (m[1] !== '-') added += Number(m[1]);
      if (m[2] !== '-') removed += Number(m[2]);
    }
    const untracked = await this.git.run(['ls-files', '--others', '--exclude-standard'], path);
    for (const f of untracked.stdout.split('\n').filter(Boolean)) {
      files++;
      const c = await this.git.run(['diff', '--numstat', '--no-index', '--', '/dev/null', f], path, {
        reject: false,
      });
      const m = /^(\d+)\t/.exec(c.stdout);
      if (m) added += Number(m[1]);
    }
    return { added, removed, files };
  }

  async diff(path: string, base: string, files?: string[]): Promise<string> {
    const { stdout } = await this.git.run(['diff', '--no-color', '-U3', base, '--', ...(files ?? [])], path);
    return stdout;
  }

  async aheadBehind(
    path: string,
    branch: string,
    upstream: string,
  ): Promise<{ ahead: number; behind: number }> {
    const r = await this.git.run(['rev-list', '--left-right', '--count', `${branch}...${upstream}`], path, {
      reject: false,
    });
    const m = /^(\d+)\s+(\d+)/.exec(r.stdout.trim());
    return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : { ahead: 0, behind: 0 };
  }

  /** Paths that differ between two refs in the merge-base form (`from...to`), relative to the repo root. */
  async diffNames(path: string, from: string, to: string): Promise<string[]> {
    const r = await this.git.run(['diff', '--name-only', `${from}...${to}`], path, { reject: false });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  }

  /** Commits reachable from `to` but not from `from` (`from..to`), newest first, each with the files it touched. */
  async logRange(
    path: string,
    from: string,
    to: string,
    limit = 50,
  ): Promise<{ sha: string; subject: string; when: number; files: string[] }[]> {
    const r = await this.git.run(
      ['log', `--max-count=${limit}`, '--name-only', '--format=%x01%H%x00%s%x00%ct', `${from}..${to}`],
      path,
      { reject: false },
    );
    if (r.exitCode !== 0) return [];
    const out: { sha: string; subject: string; when: number; files: string[] }[] = [];
    for (const block of r.stdout.split('\u0001').slice(1)) {
      const [header = '', ...rest] = block.split('\n');
      const [sha = '', subject = '', ct = '0'] = header.split('\u0000');
      if (sha === '') continue;
      out.push({
        sha,
        subject,
        when: Number(ct) * 1000,
        files: rest.map((l) => l.trim()).filter((l) => l !== ''),
      });
    }
    return out;
  }

  /** Paths git lists as unmerged (the `u` entries of `status --porcelain=v2`). */
  async conflictedFiles(path: string): Promise<string[]> {
    return (await this.status(path)).changed.filter((c) => c.kind === 'conflict').map((c) => c.path);
  }

  async mergeInProgress(path: string): Promise<boolean> {
    const r = await this.git.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path, { reject: false });
    return r.exitCode === 0;
  }

  /** Commit subjects in `range` (`a..b`) that touched `file`, newest first. */
  async subjects(path: string, range: string, file: string): Promise<string[]> {
    const r = await this.git.run(['log', '--format=%s', range, '--', file], path, { reject: false });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  }

  async resetHard(path: string, rev: string): Promise<void> {
    await this.git.run(['reset', '--hard', rev], path);
  }

  async setConfig(path: string, key: string, value: string): Promise<void> {
    await this.git.run(['config', key, value], path);
  }

  async fetch(path: string): Promise<void> {
    await this.git.run(['fetch', '--prune', '--quiet'], path, { reject: false });
  }

  /**
   * The remote-tracking ref a branch follows (`origin/main`): its configured upstream, else `<remote>/<branch>` for
   * the first remote when that ref exists (a clone whose branch was never `--set-upstream`); null when there is none.
   */
  async upstreamRef(path: string, branch: string): Promise<string | null> {
    const cfg = await this.git.run(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
      path,
      { reject: false },
    );
    if (cfg.exitCode === 0 && cfg.stdout.trim() !== '') return cfg.stdout.trim();
    const remote = (await this.remotes(path))[0]?.name;
    if (remote === undefined) return null;
    const ref = `${remote}/${branch}`;
    const r = await this.git.run(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], path, {
      reject: false,
    });
    return r.exitCode === 0 ? ref : null;
  }

  async revParse(path: string, ref: string): Promise<string | null> {
    const r = await this.git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], path, {
      reject: false,
    });
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  }

  /** `git merge-base --is-ancestor a b`: is `a` reachable from `b`? */
  async isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.git.run(['merge-base', '--is-ancestor', ancestor, descendant], path, {
      reject: false,
    });
    return r.exitCode === 0;
  }

  /** `git merge --ff-only <ref>` in a checkout: moves the current branch forward or does nothing at all. */
  async mergeFfOnly(path: string, ref: string): Promise<boolean> {
    const r = await this.git.run(['merge', '--ff-only', '--quiet', ref], path, { reject: false });
    return r.exitCode === 0;
  }

  /** Moves a branch ref that is checked out nowhere (`git update-ref`); the caller has checked that. */
  async updateBranchRef(path: string, branch: string, sha: string): Promise<void> {
    await this.git.run(['update-ref', `refs/heads/${branch}`, sha], path);
  }

  /** `git merge --no-edit <ref>` in a worktree; a conflict returns `ok: false` with the tree mid-merge (see `mergeAbort`). */
  async merge(path: string, ref: string): Promise<{ ok: boolean; output: string }> {
    const r = await this.git.run(['merge', '--no-edit', ref], path, { reject: false });
    return { ok: r.exitCode === 0, output: (r.stderr || r.stdout).trim() };
  }

  async mergeAbort(path: string): Promise<void> {
    await this.git.run(['merge', '--abort'], path, { reject: false });
  }

  async branches(path: string): Promise<string[]> {
    const { stdout } = await this.git.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], path);
    return stdout.split('\n').filter(Boolean);
  }

  /** `agent/<name>-<n>`: next free integer for that prefix across existing branches (spec §1). */
  async nextAgentBranch(path: string, agent: string, prefix = 'agent/'): Promise<string> {
    const existing = await this.branches(path);
    const re = new RegExp(`^${escapeRe(prefix + agent)}-(\\d+)$`);
    let n = 0;
    for (const b of existing) {
      const m = re.exec(b);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return `${prefix}${agent}-${n + 1}`;
  }

  async worktreeList(path: string): Promise<WorktreeInfo[]> {
    const { stdout } = await this.git.run(['worktree', 'list', '--porcelain'], path);
    const out: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur?.path) out.push(finish(cur, out.length === 0));
        cur = { path: line.slice(9), head: null, branch: null, bare: false, detached: false };
      } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (cur && line === 'bare') cur.bare = true;
      else if (cur && line === 'detached') cur.detached = true;
    }
    if (cur?.path) out.push(finish(cur, out.length === 0));
    return out;
  }

  async worktreeAdd(
    repoPath: string,
    opts: { branch: string; base: string; path: string; createBranch?: boolean },
  ): Promise<void> {
    const args = ['worktree', 'add', '--quiet'];
    if (opts.createBranch ?? true) args.push('-b', opts.branch, opts.path, opts.base);
    else args.push(opts.path, opts.branch);
    await this.git.run(args, repoPath);
  }

  async worktreeRemove(repoPath: string, worktreePath: string, force = false): Promise<void> {
    await this.git.run(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], repoPath);
    await this.git.run(['worktree', 'prune'], repoPath, { reject: false });
  }

  /** Dry-run merge via `git merge-tree --write-tree`; returns the first conflicting file or null. */
  async detectConflict(repoPath: string, branch: string, against: string): Promise<ConflictInfo | null> {
    const r = await this.git.run(['merge-tree', '--write-tree', '--name-only', against, branch], repoPath, {
      reject: false,
    });
    if (r.exitCode === 0) return null;
    if (r.exitCode !== 1) throw new Error(`merge-tree failed: ${r.stderr}`);
    const lines = r.stdout.split('\n').filter(Boolean);
    const file = lines[1] ?? lines[0] ?? '';
    return { file, against };
  }

  async applyPatch(
    path: string,
    patch: string,
    opts: { cached?: boolean; reverse?: boolean },
  ): Promise<void> {
    const args = ['apply', '--unidiff-zero', '--whitespace=nowarn'];
    if (opts.cached) args.push('--cached');
    if (opts.reverse) args.push('-R');
    await this.git.run(args, path, { input: patch });
  }

  async clone(url: string, into: string): Promise<void> {
    const { dirname } = await import('node:path');
    await this.git.run(['clone', '--quiet', url, into], dirname(into));
  }

  async currentBranch(path: string): Promise<string | null> {
    const r = await this.git.run(['branch', '--show-current'], path, { reject: false });
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  /**
   * Every file the `@` picker may offer: tracked + untracked with ignores honoured (`.git` never). A plain folder
   * (no git) falls back to a bounded walk that skips dot-dirs and node_modules.
   */
  async listFiles(path: string, max = 20_000): Promise<string[]> {
    const r = await this.git.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], path, {
      reject: false,
    });
    if (r.exitCode === 0) return r.stdout.split('\0').filter(Boolean).slice(0, max);
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      if (out.length >= max) return;
      let entries: Dirent[] = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), relPath);
        else if (e.isFile()) out.push(relPath);
        if (out.length >= max) return;
      }
    };
    await walk(path, '');
    return out;
  }

  async untrackedFiles(path: string): Promise<string[]> {
    const r = await this.git.run(['ls-files', '--others', '--exclude-standard'], path, { reject: false });
    return r.stdout.split('\n').filter(Boolean);
  }

  /** `git diff -U3 <base>` plus a `/dev/null` diff for every untracked file, so new files produce hunks too. */
  async diffWithUntracked(path: string, base: string): Promise<string> {
    let out = await this.diff(path, base);
    for (const f of await this.untrackedFiles(path)) {
      const r = await this.git.run(['diff', '--no-color', '-U3', '--no-index', '--', '/dev/null', f], path, {
        reject: false,
      });
      if (r.stdout) out += (out.endsWith('\n') || out === '' ? '' : '\n') + r.stdout;
    }
    return out;
  }

  /** Porcelain status letters per path for the file tree (`M` modified, `A` added/staged, `D` deleted, `?` untracked). */
  async statusMap(path: string): Promise<Map<string, 'M' | 'A' | 'D' | '?'>> {
    const st = await this.status(path);
    const m = new Map<string, 'M' | 'A' | 'D' | '?'>();
    for (const c of st.changed)
      m.set(
        c.path,
        c.kind === 'untracked' ? '?' : c.kind === 'added' ? 'A' : c.kind === 'deleted' ? 'D' : 'M',
      );
    return m;
  }

  async add(path: string, files: string[]): Promise<void> {
    await this.git.run(['add', '--', ...files], path);
  }

  /** Every change in the tree, deletions included (`add -A`): a resolved merge is committed whole. */
  async addAll(path: string): Promise<void> {
    await this.git.run(['add', '-A'], path);
  }

  /**
   * Commits as `Styx <styx@localhost>` (scaffolds, checkpoints). `asUser` commits with the repo's / the user's own
   * git identity instead (a publish is the user's commit), falling back to Styx only when git has no identity at
   * all ("Please tell me who you are").
   */
  async commit(
    path: string,
    message: string,
    opts: { allowEmpty?: boolean; asUser?: boolean } = {},
  ): Promise<void> {
    const args = ['commit', '-q', ...(opts.allowEmpty ? ['--allow-empty'] : []), '-m', message];
    if (opts.asUser) {
      const r = await this.git.run(args, path, { reject: false });
      if (r.exitCode === 0) return;
      if (
        !/tell me who you are|empty ident|auto-detection is disabled|no (name|email) was given|user\.(name|email)/i.test(
          r.stderr,
        )
      )
        throw new Error(`git commit failed (${r.exitCode}): ${r.stderr.trim()}`);
    }
    await this.git.run(['-c', 'user.name=Styx', '-c', 'user.email=styx@localhost', ...args], path);
  }

  /** Runs a commit-making command as the user, with Styx's identity only when git has none (see `commit`). */
  private async asUserOrStyx(args: string[], path: string): Promise<{ ok: boolean; output: string }> {
    const r = await this.git.run(args, path, { reject: false });
    if (r.exitCode === 0) return { ok: true, output: '' };
    if (
      /tell me who you are|empty ident|auto-detection is disabled|no (name|email) was given|user\.(name|email)/i.test(
        r.stderr,
      )
    ) {
      const r2 = await this.git.run(
        ['-c', 'user.name=Styx', '-c', 'user.email=styx@localhost', ...args],
        path,
        { reject: false },
      );
      return { ok: r2.exitCode === 0, output: (r2.stderr || r2.stdout).trim() };
    }
    return { ok: false, output: (r.stderr || r.stdout).trim() };
  }

  /** `git merge --no-ff -m <message> <ref>`: a landing is one commit on the base naming the lane. A conflict returns `ok: false` mid-merge. */
  mergeNoFf(path: string, ref: string, message: string): Promise<{ ok: boolean; output: string }> {
    return this.asUserOrStyx(['merge', '--no-ff', '--no-edit', '-m', message, ref], path);
  }

  /** `git revert -m 1 <merge>`: takes a landing back out of the base as a new commit (history stays). */
  revertMerge(path: string, commit: string): Promise<{ ok: boolean; output: string }> {
    return this.asUserOrStyx(['revert', '--no-edit', '-m', '1', commit], path);
  }

  /** Per-file numstat between two refs in the merge-base form (`from...to`). */
  async numstatFiles(
    path: string,
    from: string,
    to: string,
  ): Promise<{ path: string; added: number; removed: number }[]> {
    const r = await this.git.run(['diff', '--numstat', '--no-renames', `${from}...${to}`], path, {
      reject: false,
    });
    if (r.exitCode !== 0) return [];
    const out: { path: string; added: number; removed: number }[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      out.push({
        path: m[3] ?? '',
        added: m[1] === '-' ? 0 : Number(m[1]),
        removed: m[2] === '-' ? 0 : Number(m[2]),
      });
    }
    return out;
  }

  async addRemote(path: string, name: string, url: string): Promise<void> {
    await this.git.run(['remote', 'add', name, url], path);
  }

  /**
   * `git push -u <remote> <branch>`. A bearer token, when given, travels as a one-shot `http.extraheader` through
   * `GIT_CONFIG_*` env (not argv, so it never shows in `ps`) and is not persisted in the repo config.
   */
  async push(path: string, remote: string, branch: string, opts: { token?: string } = {}): Promise<void> {
    if (opts.token === undefined) {
      await this.git.run(['push', '-q', '-u', remote, branch], path);
      return;
    }
    // The token is scoped to the push URL's host (never a global header some other URL could receive), and the
    // push fails closed: no credential helper and no prompt, so a rejected token cannot silently fall back to
    // the user's own stored credential while the audit says the grant was used.
    const pushUrl = (
      await this.git.run(['remote', 'get-url', '--push', remote], path, { reject: false })
    ).stdout.trim();
    const host = remoteHost(pushUrl);
    if (host !== 'github' || !/^https:\/\//i.test(pushUrl)) {
      // The token is for github.com only; anywhere else the push goes out the way it always did (ssh agent, the
      // user's own helper, a local path) and the token stays home.
      logger.info('git push: remote is not https github.com, pushing without the grant token', { remote });
      await this.git.run(['push', '-q', '-u', remote, branch], path);
      return;
    }
    const env = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${opts.token}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
    };
    await this.git.run(['push', '-q', '-u', remote, branch], path, { env });
  }

  async configureRepo(
    path: string,
    opts: { longPaths?: boolean; lineEndings?: 'auto' | 'lf' | 'crlf' },
  ): Promise<void> {
    if (opts.longPaths) await this.git.run(['config', 'core.longpaths', 'true'], path);
    if (opts.lineEndings && opts.lineEndings !== 'auto') {
      await this.git.run(['config', 'core.autocrlf', opts.lineEndings === 'crlf' ? 'true' : 'false'], path);
    }
  }
}

/** Sibling worktree location: `<repoParent>/.styx/worktrees/<repoName>/<branchSlug>` (short paths on Windows). */

/** Which forge a remote URL points at, by its real hostname (ssh `git@host:` and https forms), never a substring. */
export const remoteHost = (url: string): 'github' | 'gitlab' | 'other' => {
  let host: string | null = null;
  const ssh = /^(?:[^@/]+@)?([^:/]+):/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = null;
    }
  } else if (ssh?.[1] !== undefined) host = ssh[1].toLowerCase();
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  return 'other';
};

export function worktreeLocation(repoPath: string, branch: string): string {
  const parts = repoPath.split(sep);
  const name = parts.pop() ?? 'repo';
  const parent = parts.join(sep) || sep;
  return join(parent, '.styx', 'worktrees', name, branch.replace(/[^A-Za-z0-9._-]+/g, '-'));
}

function finish(w: Partial<WorktreeInfo>, main: boolean): WorktreeInfo {
  return {
    path: w.path ?? '',
    head: w.head ?? null,
    branch: w.branch ?? null,
    bare: w.bare ?? false,
    detached: w.detached ?? false,
    main,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
