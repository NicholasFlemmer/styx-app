import { fixtures, type AgentChange, type SessionId, type WorktreeId } from '@styx/core';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { isPolicyFile } from './hunk-service';

const { ids } = fixtures;
const claude = ids.session.claude as SessionId;
const fixCheckout = ids.worktree.fixCheckout as WorktreeId;

const sh = async (args: string[], cwd: string) => {
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
};

/**
 * A real git repo (one commit: checkout.ts + pay.ts) wired to the fixture's `fix/checkout` worktree, whose owner is
 * the Claude session. The three demo hunks seeded on that session are fakes the rescan marks `stale`.
 */
const realWorktree = async (t: TestApp): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'styx-hunks-'));
  const repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await t.app.git.init(repo);
  writeFileSync(join(repo, 'checkout.ts'), 'a\nb\nc\n');
  writeFileSync(join(repo, 'pay.ts'), 'one\ntwo\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
  const head = await t.app.git.headCommit(repo);
  const wt = t.app.repos.worktrees.get(fixCheckout);
  if (!wt) throw new Error('fixture worktree missing');
  t.app.repos.worktrees.upsert({ ...wt, path: repo, baseCommit: head });
  return repo;
};

const pendingOf = (t: TestApp): AgentChange[] =>
  t.app.repos.agentChanges.bySession(claude).filter((h) => h.status === 'pending');

const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8');

const hunkRow = (
  t: TestApp,
  over: Partial<AgentChange> & Pick<AgentChange, 'id' | 'file' | 'hunkHash'>,
): AgentChange => {
  const now = t.clock.now();
  return {
    sessionId: claude,
    worktreeId: fixCheckout,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    patch: `patch:${over.hunkHash}`,
    status: 'pending',
    firstSeenAt: now,
    lastSeenAt: now,
    decidedAt: null,
    ...over,
  };
};

describe('HunkService', () => {
  it('isPolicyFile matches .styx/project.json at any depth on both separators', () => {
    expect(isPolicyFile('.styx/project.json')).toBe(true);
    expect(isPolicyFile('/repo/.styx/project.json')).toBe(true);
    expect(isPolicyFile('C:\\repo\\.styx\\project.json')).toBe(true);
    expect(isPolicyFile('src/.styx/project.json')).toBe(true);
    expect(isPolicyFile('.STYX/Project.JSON')).toBe(true); // case-insensitive filesystems
    expect(isPolicyFile('src/../.styx/./project.json')).toBe(true);
    expect(isPolicyFile('styx/project.json')).toBe(false);
    expect(isPolicyFile('.styx/project.json.bak')).toBe(false);
    expect(isPolicyFile('a.ts')).toBe(false);
  });

  it('revert reverse-applies the hunk in a real worktree (`git apply -R`), marks it reverted and rescans', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\nd\n'); // the agent's (already applied) edit
    await t.app.hunks.rescan(claude);
    const [hunk, ...rest] = pendingOf(t);
    expect(rest).toEqual([]);
    expect(hunk).toMatchObject({ file: 'checkout.ts', status: 'pending', decidedAt: null });
    if (hunk === undefined) throw new Error('no hunk detected');
    expect(t.app.repos.worktrees.get(fixCheckout)?.changes).toEqual({ added: 2, removed: 1, files: 1 });

    t.win.sent.length = 0;
    await t.app.hunks.revert(hunk.id);

    expect(read(repo, 'checkout.ts')).toBe('a\nb\nc\n');
    expect((await t.app.git.status(repo)).clean).toBe(true);
    expect(t.app.repos.agentChanges.get(hunk.id)).toMatchObject({
      status: 'rejected',
      decidedAt: t.clock.now(),
    });
    expect(pendingOf(t)).toEqual([]);
    // The rescan after the revert zeroes the worktree counters and re-publishes the session's hunks.
    expect(t.app.repos.worktrees.get(fixCheckout)?.changes).toEqual({ added: 0, removed: 0, files: 0 });
    const events = t.win.events('hunks.changed') as { sessionId: string; pending: number }[];
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toEqual({ sessionId: claude, worktreeId: fixCheckout, pending: 0 });
    expect(
      t.win
        .batches()
        .flatMap((b) => b.deltas)
        .filter((d) => d.op === 'hunks.replace').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('revertAll reverts every pending hunk of the session and leaves the worktree clean', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n');
    writeFileSync(join(repo, 'pay.ts'), 'one\ntwo\nthree\n');
    await t.app.hunks.rescan(claude);
    expect(
      pendingOf(t)
        .map((h) => h.file)
        .sort(),
    ).toEqual(['checkout.ts', 'pay.ts']);

    expect(await t.app.hunks.revertAll(claude)).toBe(2);

    expect(read(repo, 'checkout.ts')).toBe('a\nb\nc\n');
    expect(read(repo, 'pay.ts')).toBe('one\ntwo\n');
    expect((await t.app.git.status(repo)).clean).toBe(true);
    expect(pendingOf(t)).toEqual([]);
    expect(
      t.app.repos.agentChanges
        .bySession(claude)
        .filter((h) => h.status === 'rejected')
        .map((h) => h.file)
        .sort(),
    ).toEqual(['checkout.ts', 'pay.ts']);
    // Nothing left to revert: a second pass is a no-op.
    expect(await t.app.hunks.revertAll(claude)).toBe(0);
  });

  it('done marks every pending hunk reviewed (`accepted`) without touching git, skipping .styx/project.json (H-1)', async () => {
    const t = makeTestApp();
    const gitCalls: string[] = [];
    t.app.git.applyPatch = async (_path, patch) => {
      gitCalls.push(patch);
    };
    const policy = hunkRow(t, {
      id: 'h-policy' as AgentChange['id'],
      file: '.styx/project.json',
      hunkHash: 'hp',
    });
    const code = hunkRow(t, { id: 'h-code' as AgentChange['id'], file: 'src/a.ts', hunkHash: 'hc' });
    const reverted = hunkRow(t, {
      id: 'h-reverted' as AgentChange['id'],
      file: 'src/b.ts',
      hunkHash: 'hr',
      status: 'rejected',
      decidedAt: 1,
    });
    for (const h of [policy, code, reverted]) t.app.repos.agentChanges.upsert(h);
    const pendingBefore = pendingOf(t).length; // 3 demo hunks + policy + code
    expect(pendingBefore).toBe(5);
    t.clock.set(fixtures.DEMO_NOW + 60_000);
    t.win.sent.length = 0;

    const n = t.app.hunks.done(claude);

    expect(n).toBe(pendingBefore - 1);
    expect(gitCalls).toEqual([]);
    expect(t.app.repos.agentChanges.get('h-code')).toMatchObject({
      status: 'accepted',
      decidedAt: fixtures.DEMO_NOW + 60_000,
    });
    expect(t.app.repos.agentChanges.get('h-policy')).toMatchObject({ status: 'pending', decidedAt: null });
    expect(t.app.repos.agentChanges.get('h-reverted')).toMatchObject({ status: 'rejected', decidedAt: 1 });
    expect(pendingOf(t).map((h) => h.id)).toEqual(['h-policy']);
    expect(t.win.events('hunks.changed')).toEqual([
      { sessionId: claude, worktreeId: fixCheckout, pending: 1 },
    ]);
    expect(
      t.win
        .batches()
        .flatMap((b) => b.deltas)
        .some((d) => d.op === 'hunks.replace'),
    ).toBe(true);

    // Nothing pending but the policy file: done is a no-op and publishes nothing.
    t.win.sent.length = 0;
    expect(t.app.hunks.done(claude)).toBe(0);
    expect(t.win.events('hunks.changed')).toEqual([]);
  });

  it('revert refuses a hunk that is not pending (invalid-transition) and never calls git for it', async () => {
    const t = makeTestApp();
    const gitCalls: string[] = [];
    t.app.git.applyPatch = async (_path, patch) => {
      gitCalls.push(patch);
    };
    for (const status of ['accepted', 'rejected', 'stale'] as const) {
      const id = `h-${status}` as AgentChange['id'];
      t.app.repos.agentChanges.upsert(hunkRow(t, { id, file: 'src/a.ts', hunkHash: `h-${status}`, status }));
      await expect(t.app.hunks.revert(id)).rejects.toMatchObject({ code: 'invalid-transition' });
      expect(t.app.repos.agentChanges.get(id)?.status).toBe(status);
    }
    expect(gitCalls).toEqual([]);
    await expect(t.app.hunks.revert('nope')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('tracking setting (Settings › Editor › Track agent edits)', () => {
  it('off: rescan yields nothing; applyTracking clears the renderer hunks and keeps the rows for later', async () => {
    const t = makeTestApp();
    const claude = fixtures.ids.session.claude;
    expect(t.app.hunks.enabled()).toBe(true);
    t.app.repos.settings.patch({ trackAgentEdits: false });
    expect(t.app.hunks.enabled()).toBe(false);
    expect(await t.app.hunks.rescan(claude)).toEqual([]);
    await t.app.hunks.applyTracking();
    t.app.publisher.flush();
    const cleared = t.win
      .batches()
      .flatMap((b) => b.deltas)
      .some((raw) => {
        const d = raw as { op: string; sessionId?: string; hunks?: unknown[] };
        return d.op === 'hunks.replace' && d.sessionId === claude && d.hunks?.length === 0;
      });
    expect(cleared).toBe(true);
    expect(t.app.publisher.snapshot().hunks).toEqual({});
    expect(t.app.repos.agentChanges.bySession(claude).length).toBeGreaterThan(0);
  });

  it('settings.set { trackAgentEdits } applies it through the bus', async () => {
    const t = makeTestApp();
    const r = await t.app.bus.dispatch(t.sender, 'settings.set', { patch: { trackAgentEdits: false } });
    expect(r).toEqual({ ok: true, value: {} });
    expect(t.app.hunks.enabled()).toBe(false);
    expect(t.app.publisher.snapshot().hunks).toEqual({});
  });
});
