import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { GitService, worktreeLocation } from './git';

const git = new GitService();
let repo: string;

async function sh(args: string[], cwd: string) {
  await execa('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
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
    expect(st.changed).toEqual(expect.arrayContaining([{ path: 'checkout.ts', kind: 'modified' }, { path: 'validate.ts', kind: 'untracked' }]));
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
});
