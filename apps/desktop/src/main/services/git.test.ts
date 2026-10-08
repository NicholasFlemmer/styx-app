import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExecaGitRunner, GitService, isGitMissing, isTokenRefusal, worktreeLocation } from './git';
import { slow } from '../test-timeouts';

const git = new GitService();
let repo: string;

async function sh(args: string[], cwd: string) {
  await execa('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'styx-git-'));
  repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await git.init(repo);
  writeFileSync(join(repo, 'checkout.ts'), 'a\nb\nc\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
});

describe('GitService', () => {
  it('reports version, repo-ness, head, default branch', async () => {
    expect(await git.version()).toMatch(/^\d+\.\d+/);
    expect(await git.isRepo(repo)).toBe(true);
    expect(await git.headCommit(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.defaultBranch(repo)).toBe('main');
  });

  it('allocates agent branches and creates sibling worktrees', async () => {
    expect(await git.nextAgentBranch(repo, 'claude')).toBe('agent/claude-1');
    const wt = worktreeLocation(repo, 'agent/claude-1');
    expect(wt).toContain(join('.styx', 'worktrees', 'acme-shop', 'agent-claude-1'));
    await git.worktreeAdd(repo, { branch: 'agent/claude-1', base: 'main', path: wt });
    expect(await git.nextAgentBranch(repo, 'claude')).toBe('agent/claude-2');
    // A second lane started from a form that still suggests claude-1 (it was filled in before the first lane
    // existed) gets the next free number instead of failing `git worktree add -b`; a free name passes through;
    // a taken name someone typed is theirs to change.
    expect(await git.freeBranch(repo, 'agent/claude-1')).toBe('agent/claude-2');
    expect(await git.freeBranch(repo, 'agent/codex-1')).toBe('agent/codex-1');
    expect(await git.freeBranch(repo, 'main')).toBeNull();
    expect(await git.freeBranch(repo, 'feature/basket')).toBe('feature/basket');
    const list = await git.worktreeList(repo);
    expect(list.map((w) => w.branch)).toEqual(['main', 'agent/claude-1']);
    expect(list[0]?.main).toBe(true);

    writeFileSync(join(wt, 'checkout.ts'), 'a\nB\nc\nd\n');
    writeFileSync(join(wt, 'validate.ts'), 'x\n');
    const st = await git.status(wt);
    expect(st.branch).toBe('agent/claude-1');
    expect(st.clean).toBe(false);
    expect(st.changed).toEqual(
      expect.arrayContaining([
        { path: 'checkout.ts', kind: 'modified' },
        { path: 'validate.ts', kind: 'untracked' },
      ]),
    );
    const ns = await git.numstat(wt, 'main');
    expect(ns).toEqual({ added: 3, removed: 1, files: 2 });
    expect(await git.diff(wt, 'main')).toContain('+B');
  });

  it('detects merge conflicts with merge-tree', async () => {
    const wt = worktreeLocation(repo, 'agent/claude-1');
    await sh(['add', '.'], wt);
    await sh(['commit', '-q', '-m', 'agent change'], wt);
    expect(await git.detectConflict(repo, 'agent/claude-1', 'main')).toBeNull();
    writeFileSync(join(repo, 'checkout.ts'), 'a\nZ\nc\n');
    await sh(['commit', '-q', '-am', 'main change'], repo);
    const c = await git.detectConflict(repo, 'agent/claude-1', 'main');
    expect(c).toEqual({ file: 'checkout.ts', against: 'main' });
    const ab = await git.aheadBehind(wt, 'agent/claude-1', 'main');
    expect(ab).toEqual({ ahead: 1, behind: 1 });
  });

  it('applies and reverses a hunk patch', async () => {
    const wt = worktreeLocation(repo, 'agent/claude-1');
    writeFileSync(join(wt, 'pay.ts'), 'one\n');
    await sh(['add', 'pay.ts'], wt);
    await sh(['commit', '-q', '-m', 'pay'], wt);
    writeFileSync(join(wt, 'pay.ts'), 'one\ntwo\n');
    const patch = await git.diff(wt, 'HEAD', ['pay.ts']);
    await git.applyPatch(wt, patch, { reverse: true });
    expect((await git.status(wt)).clean).toBe(true);
    await git.applyPatch(wt, patch, {});
    await git.applyPatch(wt, patch, { cached: true });
    const st = await git.status(wt);
    expect(st.changed).toEqual([{ path: 'pay.ts', kind: 'modified' }]);
  });

  it('commit: Styx identity by default; `asUser` takes the configured identity and falls back to Styx without one', async () => {
    // A runner whose git sees no global / system config and no identity env: only what the repo itself sets.
    const env: Record<string, string> = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !/^(GIT_(AUTHOR|COMMITTER)_|EMAIL$)/.test(k) && !(k in env)) env[k] = v;
    const isolated = new GitService({
      run: async (args, cwd, opts = {}) => {
        const r = await execa('git', args, {
          cwd,
          reject: opts.reject ?? true,
          env,
          extendEnv: false,
          ...(opts.input !== undefined ? { input: opts.input } : {}),
        });
        return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 0 };
      },
    });
    const author = () =>
      execa('git', ['log', '-1', '--format=%an <%ae>'], { cwd: repo }).then((r) => r.stdout);
    writeFileSync(join(repo, 'one.txt'), '1\n');
    await isolated.add(repo, ['one.txt']);
    await isolated.commit(repo, 'default identity');
    expect(await author()).toBe('Styx <styx@localhost>');
    // No identity anywhere (and git's passwd/hostname guess switched off): asUser falls back to Styx.
    await sh(['config', 'user.useConfigOnly', 'true'], repo);
    writeFileSync(join(repo, 'two.txt'), '2\n');
    await isolated.add(repo, ['two.txt']);
    await isolated.commit(repo, 'no identity', { asUser: true });
    expect(await author()).toBe('Styx <styx@localhost>');
    // The repo's own identity wins once it exists.
    await sh(['config', 'user.name', 'Nic Test'], repo);
    await sh(['config', 'user.email', 'nic@example.com'], repo);
    writeFileSync(join(repo, 'three.txt'), '3\n');
    await isolated.add(repo, ['three.txt']);
    await isolated.commit(repo, 'own identity', { asUser: true });
    expect(await author()).toBe('Nic Test <nic@example.com>');
    // Any other failure surfaces as is.
    await expect(isolated.commit(repo, 'nothing staged', { asUser: true })).rejects.toThrow(
      /git commit failed/,
    );
  });
});

describe('a machine where git has no name or email', () => {
  it('a merge commit is made as Styx instead of failing (as every other commit-making path already did)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'styx-noident-'));
    const r = join(root, 'r');
    mkdirSync(r);
    await git.init(r);
    writeFileSync(join(r, 'a.txt'), 'a');
    await sh(['add', '.'], r);
    await sh(['commit', '-q', '-m', 'init'], r);
    await sh(['checkout', '-q', '-b', 'side'], r);
    writeFileSync(join(r, 'b.txt'), 'b');
    await sh(['add', '.'], r);
    await sh(['commit', '-q', '-m', 'side'], r);
    await sh(['checkout', '-q', 'main'], r);
    writeFileSync(join(r, 'c.txt'), 'c');
    await sh(['add', '.'], r);
    await sh(['commit', '-q', '-m', 'main'], r);
    // No global or system config, and git may not guess one from the host name.
    const empty = join(root, 'empty.gitconfig');
    writeFileSync(empty, '');
    await sh(['config', 'user.useConfigOnly', 'true'], r);
    const saved = { g: process.env['GIT_CONFIG_GLOBAL'], s: process.env['GIT_CONFIG_NOSYSTEM'] };
    process.env['GIT_CONFIG_GLOBAL'] = empty;
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    try {
      const m = await git.merge(r, 'side');
      expect(m.ok).toBe(true);
    } finally {
      if (saved.g === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = saved.g;
      if (saved.s === undefined) delete process.env['GIT_CONFIG_NOSYSTEM'];
      else process.env['GIT_CONFIG_NOSYSTEM'] = saved.s;
    }
    const { stdout } = await execa('git', ['log', '-1', '--format=%an %P'], { cwd: r });
    expect(stdout.split(' ')[0]).toBe('Styx');
    expect(stdout.split(' ').length).toBe(3); // a merge: two parents
  });

  it('undoing a merge reverts it as Styx in one go, never half-applied (revert changes the tree before it asks for an author)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'styx-noident-rev-'));
    const r = join(root, 'r');
    mkdirSync(r);
    await git.init(r);
    writeFileSync(join(r, 'a.txt'), 'a');
    await sh(['add', '.'], r);
    await sh(['commit', '-q', '-m', 'init'], r);
    await sh(['checkout', '-q', '-b', 'side'], r);
    writeFileSync(join(r, 'b.txt'), 'b');
    await sh(['add', '.'], r);
    await sh(['commit', '-q', '-m', 'side'], r);
    await sh(['checkout', '-q', 'main'], r);
    await sh(['merge', '-q', '--no-ff', '-m', 'land side', 'side'], r);
    const landed = (await execa('git', ['rev-parse', 'HEAD'], { cwd: r })).stdout.trim();
    const empty = join(root, 'empty.gitconfig');
    writeFileSync(empty, '');
    await sh(['config', 'user.useConfigOnly', 'true'], r);
    const saved = { g: process.env['GIT_CONFIG_GLOBAL'], s: process.env['GIT_CONFIG_NOSYSTEM'] };
    process.env['GIT_CONFIG_GLOBAL'] = empty;
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    try {
      expect((await git.revertMerge(r, landed)).ok).toBe(true);
      expect((await git.status(r)).clean).toBe(true);
    } finally {
      if (saved.g === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = saved.g;
      if (saved.s === undefined) delete process.env['GIT_CONFIG_NOSYSTEM'];
      else process.env['GIT_CONFIG_NOSYSTEM'] = saved.s;
    }
    const { stdout } = await execa('git', ['log', '-1', '--format=%an'], { cwd: r });
    expect(stdout.trim()).toBe('Styx');
  });
});

describe('commitOwnedPaths (ADR-0028)', () => {
  it('commits only the given paths, with the agent’s hooks off, and refuses a worktree pointed at another git dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'styx-owned-'));
    const project = join(root, 'p');
    mkdirSync(project);
    await git.init(project);
    writeFileSync(join(project, 'a.txt'), 'a');
    await sh(['add', '.'], project);
    await sh(['commit', '-q', '-m', 'init'], project);
    const wt = join(root, 'wt');
    await git.worktreeAdd(project, { branch: 'agent/claude-1', base: 'main', path: wt });
    // A hook the agent planted: it would leave a marker if it ran.
    const hooks = join(root, 'hooks');
    mkdirSync(hooks);
    // `/` separators so Git for Windows' sh could also leave the marker if the hook ran.
    const marker = join(root, 'hook-ran').replace(/\\/g, '/');
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await sh(['config', 'core.hooksPath', hooks], project);
    mkdirSync(join(wt, '.styx', 'designs'), { recursive: true });
    writeFileSync(join(wt, '.styx', 'designs', 'tokens.json'), '{}');
    writeFileSync(join(wt, 'other.txt'), 'not ours');
    expect(await git.commitOwnedPaths(wt, project, ['.styx/designs'], 'Design: tokens')).toBe(true);
    expect(existsSync(join(root, 'hook-ran'))).toBe(false);
    const { stdout } = await execa('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: wt });
    expect(stdout).toContain('Design: tokens');
    expect(stdout).toContain('.styx/designs/tokens.json');
    expect(stdout).not.toContain('other.txt');
    expect(await git.commitOwnedPaths(wt, project, ['.styx/designs'], 'again')).toBe(false);
    // A worktree whose .git points at a git dir of its own making is not the project's.
    const rogue = join(root, 'rogue');
    mkdirSync(rogue);
    await git.init(rogue);
    // Unlinked first: Git for Windows marks a worktree's `.git` file hidden, and Windows refuses to open a hidden
    // file for overwrite (EPERM).
    rmSync(join(wt, '.git'));
    writeFileSync(join(wt, '.git'), `gitdir: ${join(rogue, '.git')}\n`);
    await expect(git.commitOwnedPaths(wt, project, ['.styx/designs'], 'x')).rejects.toThrow();
  });
});

describe('remoteHost', () => {
  it('matches the real hostname only, for https and ssh forms', async () => {
    const { remoteHost } = await import('./git');
    expect(remoteHost('https://github.com/acme/shop.git')).toBe('github');
    expect(remoteHost('git@github.com:acme/shop.git')).toBe('github');
    expect(remoteHost('ssh://git@github.com/acme/shop.git')).toBe('github');
    expect(remoteHost('https://gitlab.com/acme/shop.git')).toBe('gitlab');
    // Look-alikes that a substring match accepted.
    expect(remoteHost('https://github.com.evil.io/acme/shop.git')).toBe('other');
    expect(remoteHost('https://evil.io/github.com/acme/shop.git')).toBe('other');
    expect(remoteHost('/srv/git/github.com/shop.git')).toBe('other');
  });
});

describe('push with a grant token', () => {
  /** A runner that records each call; `remote get-url` answers with the configured push URL. */
  const recorder = (pushUrl: string, pushError: string | null = null) => {
    const calls: { args: string[]; env: Record<string, string> | undefined }[] = [];
    const runner = {
      run: async (args: string[], _cwd: string, opts: { env?: Record<string, string> } = {}) => {
        calls.push({ args, env: opts.env });
        if (args[0] === 'remote') return { stdout: `${pushUrl}\n`, stderr: '', exitCode: 0 };
        if (args[0] === 'push' && pushError !== null) throw new Error(pushError);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    return { calls, svc: new GitService(runner) };
  };

  it('sends the token as basic x-access-token auth, scoped to github.com, with helpers and prompts off', async () => {
    const { calls, svc } = recorder('https://github.com/acme/shop.git');
    await svc.push('/repo', 'origin', 'fix/checkout', { token: 'gho_abc' });
    const push = calls.find((c) => c.args[0] === 'push');
    expect(push?.args).toEqual(['push', '-q', '-u', 'origin', 'fix/checkout']);
    expect(push?.env).toMatchObject({
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:gho_abc').toString('base64')}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
    });
    expect(push?.env?.['GIT_CONFIG_VALUE_0']).not.toContain('bearer');
  });

  it('a non-github or ssh remote is pushed without the token and without the lockdown', async () => {
    for (const url of [
      'git@github.com:acme/shop.git',
      'https://gitlab.com/acme/shop.git',
      '/srv/git/shop.git',
    ]) {
      const { calls, svc } = recorder(url);
      await svc.push('/repo', 'origin', 'main', { token: 'gho_abc' });
      const push = calls.find((c) => c.args[0] === 'push');
      expect(push?.env, url).toBeUndefined();
    }
  });

  it('a refused token reads as a refused token, not as an askpass failure', async () => {
    const { svc } = recorder(
      'https://github.com/acme/shop.git',
      "git push -q -u origin main failed (128): error: unable to read askpass response from '/usr/bin/false'\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    await expect(svc.push('/repo', 'origin', 'main', { token: 'gho_abc' })).rejects.toThrow(
      /GitHub refused the token for https:\/\/github.com\/acme\/shop.git/,
    );
    expect(isTokenRefusal('The requested URL returned error: 403')).toBe(true);
    expect(isTokenRefusal('remote: not found')).toBe(false);
  });
});

describe('a machine without git (owner request: git is never a requirement to start)', () => {
  const missing = () => new GitService(new ExecaGitRunner({ gitBin: 'styx-no-such-git' }));

  it('reports it plainly: available() says so, a rejecting call names it, a non-rejecting one is never a success', async () => {
    const git = missing();
    expect(await git.available()).toEqual({ installed: false, version: null });
    await expect(git.version()).rejects.toThrow(/^git is not installed/);
    expect(isGitMissing('git is not installed (git init)')).toBe(true);
    // `isRepo` and friends run with reject:false: a missing git must not read as "yes".
    expect(await git.isRepo(tmpdir())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'finds a git installed while Styx runs: the login PATH is asked again before giving up',
    async () => {
      const bin = mkdtempSync(join(tmpdir(), 'styx-fake-git-'));
      writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "git version 9.9.9"\n', { mode: 0o755 });
      const asked: (number | undefined)[] = [];
      const git = new GitService(
        new ExecaGitRunner({
          loginPath: async (o) => {
            asked.push(o.maxAgeMs);
            return o.maxAgeMs === 0 ? bin : '/styx/nowhere';
          },
        }),
      );
      expect(await git.available()).toEqual({ installed: true, version: '9.9.9' });
      expect(asked).toEqual([undefined, 0]);
    },
    // Two process spawns (a miss, then the fake git): over 5s on a loaded machine.
    slow(20_000),
  );

  it.skipIf(process.platform === 'win32')(
    'Windows\' answer for a missing command (cmd.exe: "is not recognized…", exit 1) counts as no git',
    async () => {
      const bin = mkdtempSync(join(tmpdir(), 'styx-win-missing-'));
      writeFileSync(
        join(bin, 'git'),
        '#!/bin/sh\necho "\'git\' is not recognized as an internal or external command," >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const git = new GitService(new ExecaGitRunner({ loginPath: async () => bin }));
      await expect(git.version()).rejects.toThrow(/^git is not installed/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    "macOS's /usr/bin/git stub (no Command Line Tools) counts as no git",
    async () => {
      const bin = mkdtempSync(join(tmpdir(), 'styx-stub-git-'));
      writeFileSync(
        join(bin, 'git'),
        '#!/bin/sh\necho "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const git = new GitService(new ExecaGitRunner({ loginPath: async () => bin }));
      expect(await git.available()).toEqual({ installed: false, version: null });
      await expect(git.init(bin)).rejects.toThrow(/^git is not installed/);
    },
  );
});
