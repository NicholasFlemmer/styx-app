import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { GitService, isTokenRefusal, worktreeLocation } from './git';

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
