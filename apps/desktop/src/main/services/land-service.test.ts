import { execa } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
const acmeMain = ids.worktree.acmeMain;
const fixCheckout = ids.worktree.fixCheckout;
const testFlaky = ids.worktree.testFlaky;
const claude = ids.session.claude;
const codex = ids.session.codex;

async function sh(args: string[], cwd: string): Promise<string> {
  const r = await execa('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  return String(r.stdout);
}

interface Rig {
  t: TestApp;
  checks: ReturnType<
    typeof vi.fn<(cwd: string, command: string) => Promise<{ exitCode: number; output: string }>>
  >;
  repo: string;
  wt1: string;
  wt2: string;
  bare: string;
}

/**
 * A real repo with a bare `origin`, and the fixture's `fix/checkout` (Claude) and `test/flaky` (Codex) lanes cut
 * from main, both idle. `fix/checkout` has one commit (`b.ts`) and one uncommitted edit (`a.ts`); main has moved
 * on by one commit (`c.ts`) since the lanes were cut. No GitHub target carries a credential, so pushes go as the
 * user's own git would.
 */
async function rig(
  opts: { checksCommand?: string | null; remote?: boolean; autoLand?: boolean } = {},
): Promise<Rig> {
  const checks = vi.fn(async (_cwd: string, _command: string) => ({ exitCode: 0, output: '' }));
  const t = makeTestApp({ runChecks: checks });
  const root = mkdtempSync(join(tmpdir(), 'styx-land-'));
  const repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await t.app.git.init(repo);
  writeFileSync(join(repo, 'a.ts'), 'a\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
  const head = await t.app.git.headCommit(repo);
  mkdirSync(join(root, 'wt'));
  const wt1 = join(root, 'wt', 'fix-checkout');
  const wt2 = join(root, 'wt', 'test-flaky');
  await t.app.git.worktreeAdd(repo, { branch: 'fix/checkout', base: 'main', path: wt1 });
  await t.app.git.worktreeAdd(repo, { branch: 'test/flaky', base: 'main', path: wt2 });
  writeFileSync(join(wt1, 'b.ts'), 'b\n');
  await sh(['add', '.'], wt1);
  await sh(['commit', '-q', '-m', 'add b'], wt1);
  writeFileSync(join(wt1, 'a.ts'), 'a1\n');
  writeFileSync(join(repo, 'c.ts'), 'c\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'main: add c'], repo);
  const bare = join(root, 'origin.git');
  if (opts.remote ?? true) {
    await sh(['init', '--bare', '-q', bare], root);
    await sh(['remote', 'add', 'origin', bare], repo);
  }
  const project = t.app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  t.app.repos.projects.upsert({ ...project, path: repo }, t.app.repos.projects.settings(project.id));
  t.app.repos.projects.setSettings(
    acme,
    {
      ...t.app.repos.projects.settings(acme),
      checksCommand: opts.checksCommand === undefined ? 'pnpm check' : opts.checksCommand,
      autoLand: opts.autoLand ?? false,
    },
    null,
  );
  for (const target of t.app.repos.targets.all())
    if (target.projectId === acme) t.app.repos.targets.upsert({ ...target, credentialRef: null });
  const rows = t.app.repos.worktrees;
  const main = rows.get(acmeMain);
  const lane1 = rows.get(fixCheckout);
  const lane2 = rows.get(testFlaky);
  if (!main || !lane1 || !lane2) throw new Error('fixture worktrees');
  rows.upsert({ ...main, path: repo, baseCommit: head, headCommit: head });
  for (const [lane, path] of [
    [lane1, wt1],
    [lane2, wt2],
  ] as const)
    rows.upsert({
      ...lane,
      path,
      baseCommit: head,
      headCommit: head,
      pr: null,
      conflict: null,
      overlaps: [],
      resolution: null,
      landing: null,
      mergedAt: null,
    });
  for (const id of [claude, codex]) {
    const s = t.app.repos.sessions.get(id);
    if (!s) throw new Error('fixture session');
    t.app.repos.sessions.upsert({ ...s, state: 'idle', pausedReason: null, exitCode: null });
  }
  return { t, checks, repo, wt1, wt2, bare };
}

/** The session's CLI exited with `exitCode` — what the finish event records before `sessionFinished` fires. */
const finished = (t: TestApp, sessionId: string, exitCode: number): void => {
  const s = t.app.repos.sessions.get(sessionId);
  if (!s) throw new Error('session');
  t.app.repos.sessions.upsert({ ...s, state: 'done', exitCode, endedAt: t.clock.now() });
};

const systemLines = (t: TestApp, sessionId: string): string[] =>
  t.app.repos.transcripts
    .last(sessionId)
    .filter((m) => m.payload.kind === 'system')
    .map((m) => m.body);

// Real repos and several landings per case: room under a fully parallel run.
describe('LandService (ADR-0025 phase C)', { timeout: 30_000 }, () => {
  it("preview: the lane's files against the base, committed and not, and whether the base is pushed", async () => {
    const { t } = await rig();
    expect(await t.app.land.preview(fixCheckout)).toEqual({
      base: 'main',
      files: [
        { path: 'a.ts', added: 1, removed: 1 },
        { path: 'b.ts', added: 1, removed: 0 },
      ],
      willPush: true,
      remote: 'origin',
    });
    const { t: local } = await rig({ remote: false });
    expect(await local.app.land.preview(fixCheckout)).toMatchObject({ willPush: false, remote: null });
  });

  it('land: commits the lane, brings the base in, runs the checks, merges --no-ff with the summary, pushes, and marks the lane landed; undo reverts and pushes again', async () => {
    const { t, checks, repo, wt1, bare } = await rig();
    const r = await t.app.land.land(fixCheckout, { title: 'Fix the checkout total', body: 'a.ts and b.ts.' });
    expect(r.steps).toEqual([
      expect.stringMatching(/^committed [0-9a-f]{7}$/),
      'brought in main (1)',
      'checks passed',
      expect.stringMatching(/^merged into main \([0-9a-f]{7}\)$/),
      'pushed main',
    ]);
    expect(r.pushed).toBe(true);
    expect(checks).toHaveBeenCalledWith(wt1, 'pnpm check');
    // The base: one merge commit carrying the summary, both parents, the lane's files; the remote has it too.
    expect(await sh(['rev-parse', 'HEAD'], repo)).toBe(r.commit);
    expect((await sh(['log', '-1', '--format=%B', 'HEAD'], repo)).trim()).toBe(
      'Fix the checkout total\n\na.ts and b.ts.',
    );
    expect((await sh(['rev-list', '--parents', '-1', 'HEAD'], repo)).split(' ')).toHaveLength(3);
    expect(await sh(['show', 'HEAD:a.ts'], repo)).toBe('a1');
    expect(await sh(['show', 'HEAD:b.ts'], repo)).toBe('b');
    expect(await sh(['show', 'HEAD:c.ts'], repo)).toBe('c');
    expect(await sh(['rev-parse', 'refs/heads/main'], bare)).toBe(r.commit);
    // Rows: the lane is landed (Undo available), main's head moved; the chat and Home say so.
    const lane = t.app.repos.worktrees.get(fixCheckout);
    expect(lane?.mergedAt).toBe(t.clock.now());
    expect(lane?.landing).toEqual({
      commit: r.commit,
      base: 'main',
      pushed: true,
      at: t.clock.now(),
      undoneAt: null,
    });
    expect(t.app.repos.worktrees.get(acmeMain)?.headCommit).toBe(r.commit);
    expect(systemLines(t, claude).at(-1)).toBe(
      'Your work on fix/checkout is now in main and on origin. Undo is on the Repo lane until main moves on; after that the lane is tidied away by itself.',
    );
    expect(t.app.repos.activity.recent(1)[0]).toMatchObject({
      who: 'you',
      what: 'acme-shop · landed fix/checkout into main',
    });
    // Landing it again with nothing new is refused; so is undoing after the base moved on.
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toThrow(
      'Nothing to land: fix/checkout has no changes main does not already have.',
    );

    await t.app.land.undo(fixCheckout);
    const reverted = await sh(['rev-parse', 'HEAD'], repo);
    expect(reverted).not.toBe(r.commit);
    expect(await sh(['ls-tree', '--name-only', 'HEAD'], repo)).toBe('a.ts\nc.ts');
    expect(await sh(['show', 'HEAD:a.ts'], repo)).toBe('a');
    expect(await sh(['rev-parse', 'refs/heads/main'], bare)).toBe(reverted);
    const after = t.app.repos.worktrees.get(fixCheckout);
    expect(after?.mergedAt).toBeNull();
    expect(after?.landing?.undoneAt).toBe(t.clock.now());
    expect(t.app.repos.worktrees.get(acmeMain)?.headCommit).toBe(reverted);
    expect(systemLines(t, claude).at(-1)).toBe(
      'Took fix/checkout back out of main and on origin. The lane is live again.',
    );
    expect(t.app.repos.activity.recent(1)[0]?.what).toBe('acme-shop · took fix/checkout back out of main');
    await expect(t.app.land.undo(fixCheckout)).rejects.toThrow('Nothing to undo on this lane.');
  });

  it('a stale local base is brought up to origin before the merge, so the landing merges onto what origin has and the push fast-forwards', async () => {
    const { t, repo, wt1, bare } = await rig();
    // Origin moves on by one commit the local main does not have (someone else pushed).
    await sh(['push', '-q', '-u', 'origin', 'main'], repo);
    const clone = join(dirname(repo), 'clone');
    await sh(['clone', '-q', '-b', 'main', bare, clone], dirname(repo));
    writeFileSync(join(clone, 'd.ts'), 'd\n');
    await sh(['add', '.'], clone);
    await sh(['commit', '-q', '-m', 'on origin: add d'], clone);
    await sh(['push', '-q', 'origin', 'main'], clone);
    const remoteHead = await sh(['rev-parse', 'HEAD'], clone);

    const r = await t.app.land.land(fixCheckout, { title: 'Fix the checkout total', body: '' });
    expect(r.pushed).toBe(true);
    // The base was forwarded first: the landing sits on origin's commit, the lane got it too, and origin is at the landing.
    expect(await sh(['rev-parse', 'HEAD^1'], repo)).toBe(remoteHead);
    expect(await sh(['show', 'HEAD:d.ts'], repo)).toBe('d');
    expect(existsSync(join(wt1, 'd.ts'))).toBe(true);
    expect(await sh(['rev-parse', 'refs/heads/main'], bare)).toBe(r.commit);
    expect(r.steps).toContain('brought in main (2)');
  });

  it('a diverged local base (commits origin lacks, and vice versa) is refused before anything is touched', async () => {
    const { t, repo, wt1, bare } = await rig();
    await sh(['push', '-q', '-u', 'origin', 'main'], repo);
    const clone = join(dirname(repo), 'clone');
    await sh(['clone', '-q', '-b', 'main', bare, clone], dirname(repo));
    writeFileSync(join(clone, 'd.ts'), 'd\n');
    await sh(['add', '.'], clone);
    await sh(['commit', '-q', '-m', 'on origin: add d'], clone);
    await sh(['push', '-q', 'origin', 'main'], clone);
    writeFileSync(join(repo, 'e.ts'), 'e\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'local only: add e'], repo);
    const mainBefore = await sh(['rev-parse', 'main'], repo);
    const laneBefore = await sh(['rev-parse', 'HEAD'], wt1);

    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining(
        'main on this machine and origin/main have each moved on (1 local, 1 remote)',
      ),
    });
    expect(await sh(['rev-parse', 'main'], repo)).toBe(mainBefore);
    expect(await sh(['rev-parse', 'HEAD'], wt1)).toBe(laneBefore);
    expect(t.app.repos.worktrees.get(fixCheckout)?.landing).toBeNull();
  });

  it('refuses before touching anything: a dirty base, the base not checked out, red checks, a busy agent, nothing to land', async () => {
    const { t, checks, repo } = await rig();
    writeFileSync(join(repo, 'a.ts'), 'dirty\n');
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toThrow(
      'The main folder has uncommitted changes on main. Commit or discard them first.',
    );
    await sh(['checkout', '-q', '--', 'a.ts'], repo);
    await sh(['checkout', '-q', '-b', 'elsewhere'], repo);
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toThrow(
      'The main folder is on elsewhere, not main.',
    );
    await sh(['checkout', '-q', 'main'], repo);
    const s = t.app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    t.app.repos.sessions.upsert({ ...s, state: 'working' });
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toThrow(
      'Claude Code is mid-turn on fix/checkout; wait for it to finish before landing.',
    );
    t.app.repos.sessions.upsert({ ...s, state: 'idle' });
    checks.mockResolvedValueOnce({ exitCode: 2, output: 'FAIL cart.test.ts' });
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toThrow(
      'The checks failed (`pnpm check` exited 2); fix/checkout was not landed.\nFAIL cart.test.ts',
    );
    expect(await sh(['log', '-1', '--format=%s', 'main'], repo)).toBe('main: add c');
    expect(t.app.repos.worktrees.get(fixCheckout)?.mergedAt).toBeNull();
    // test/flaky has nothing main lacks (the failed attempt above committed fix/checkout, not this lane).
    await expect(t.app.land.land(testFlaky, { title: 'x', body: '' })).rejects.toThrow(
      'Nothing to land: test/flaky has no changes main does not already have.',
    );
  });

  it("landings of one project run one after another: the second brings the first's landing in before it merges", async () => {
    const { t, repo, wt2 } = await rig({ checksCommand: null });
    writeFileSync(join(wt2, 'd.ts'), 'd\n');
    const [one, two] = await Promise.all([
      t.app.land.land(fixCheckout, { title: 'checkout', body: '' }),
      t.app.land.land(testFlaky, { title: 'flaky', body: '' }),
    ]);
    expect(one.steps).toContain('brought in main (1)');
    // The second lane is behind by main's own commit plus everything the first landing brought.
    expect(two.steps).toContainEqual(expect.stringMatching(/^brought in main \([2-9]\)$/));
    expect(await sh(['rev-parse', 'HEAD'], repo)).toBe(two.commit);
    expect(await sh(['log', '--first-parent', '--format=%s', '-2', 'HEAD'], repo)).toBe('flaky\ncheckout');
    expect(await sh(['ls-tree', '--name-only', 'HEAD'], repo)).toBe('a.ts\nb.ts\nc.ts\nd.ts');
  });

  it('autoLand: a session that finishes cleanly lands its lane by itself with the file-list summary; off, review mode, or a crash do nothing', async () => {
    const { t, repo } = await rig({ autoLand: true });
    finished(t, claude, 0);
    await t.app.land.maybeAutoLand(claude);
    expect(t.app.repos.worktrees.get(fixCheckout)?.mergedAt).not.toBeNull();
    expect(await sh(['log', '-1', '--format=%s', 'main'], repo)).toBe('Update a.ts and b.ts');
    expect(systemLines(t, claude).at(-1)).toBe(
      'Your work on fix/checkout is now in main and on origin — landed on its own once the checks passed. Undo is on the Repo lane until main moves on; after that the lane is tidied away by itself.',
    );
    expect(t.app.repos.activity.recent(1)[0]).toMatchObject({
      who: 'Claude Code',
      what: 'acme-shop · landed fix/checkout into main on its own',
    });

    // The other lane: a crash never lands; nor does a clean finish once the setting is off or the mode is review.
    const { t: t2, wt2: w2, repo: r2 } = await rig({ autoLand: true });
    writeFileSync(join(w2, 'd.ts'), 'd\n');
    finished(t2, codex, 1);
    await t2.app.land.maybeAutoLand(codex);
    expect(await sh(['log', '-1', '--format=%s', 'main'], r2)).toBe('main: add c');
    const { t: t3, wt2: w3, repo: r3 } = await rig({ autoLand: false });
    writeFileSync(join(w3, 'd.ts'), 'd\n');
    finished(t3, codex, 0);
    await t3.app.land.maybeAutoLand(codex);
    expect(await sh(['log', '-1', '--format=%s', 'main'], r3)).toBe('main: add c');
    const { t: t4, wt2: w4, repo: r4 } = await rig({ autoLand: true });
    t4.app.repos.projects.setSettings(
      acme,
      { ...t4.app.repos.projects.settings(acme), integration: 'review' },
      null,
    );
    writeFileSync(join(w4, 'd.ts'), 'd\n');
    finished(t4, codex, 0);
    await t4.app.land.maybeAutoLand(codex);
    expect(await sh(['log', '-1', '--format=%s', 'main'], r4)).toBe('main: add c');
  });

  it('autoLand at turn end: an idle agent that went quiet lands; a standing refusal is said once, not every turn', async () => {
    const { t, repo, wt2 } = await rig({ autoLand: true, checksCommand: null });
    // Claude's lane lands when its turn settles.
    await t.app.land.onTurnSettled(claude);
    expect(t.app.repos.worktrees.get(fixCheckout)?.landing).not.toBeNull();
    expect(await sh(['log', '-1', '--format=%s', 'main'], repo)).toBe('Update a.ts and b.ts');
    // Codex's lane: main is dirty → refused once; the same reason at the next turn end says nothing new.
    writeFileSync(join(wt2, 'd.ts'), 'd\n');
    writeFileSync(join(repo, 'a.ts'), 'dirty\n');
    const before = systemLines(t, codex).length;
    await t.app.land.onTurnSettled(codex);
    await t.app.land.onTurnSettled(codex);
    expect(systemLines(t, codex).slice(before)).toEqual([
      'Not landed: The main folder has uncommitted changes on main. Commit or discard them first.',
    ]);
    // A working agent is left alone; a hidden task never lands.
    const s = t.app.repos.sessions.get(codex);
    if (!s) throw new Error('session');
    t.app.repos.sessions.upsert({ ...s, state: 'working' });
    await sh(['checkout', '-q', '--', 'a.ts'], repo);
    await t.app.land.onTurnSettled(codex);
    expect(t.app.repos.worktrees.get(testFlaky)?.landing).toBeNull();
  });

  it('settle: a landed lane with new work is live again; one with nothing new is tidied away once the base moves on', async () => {
    const { t, repo, wt1, wt2 } = await rig({ checksCommand: null });
    await t.app.land.land(fixCheckout, { title: 'checkout', body: '' });
    // Still the base's HEAD: nothing happens.
    await t.app.land.settle(acme);
    expect(t.app.repos.worktrees.get(fixCheckout)).toMatchObject({ archivedAt: null });
    // New work on the landed lane: live again (mergedAt cleared, the landing kept).
    writeFileSync(join(wt1, 'e.ts'), 'e\n');
    await t.app.land.settle(acme);
    expect(t.app.repos.worktrees.get(fixCheckout)).toMatchObject({ mergedAt: null, archivedAt: null });
    expect(t.app.repos.worktrees.get(fixCheckout)?.landing).not.toBeNull();
    // Landed again (the new file included), then the other lane lands: the first lane's Undo window is over.
    await t.app.land.land(fixCheckout, { title: 'checkout again', body: '' });
    expect(t.app.repos.worktrees.get(fixCheckout)?.mergedAt).not.toBeNull();
    writeFileSync(join(wt2, 'd.ts'), 'd\n');
    await t.app.land.land(testFlaky, { title: 'flaky', body: '' });
    const lane1 = t.app.repos.worktrees.get(fixCheckout);
    expect(lane1?.archivedAt).toBe(t.clock.now());
    expect(existsSync(wt1)).toBe(false);
    expect(t.app.repos.sessions.get(claude)?.state).toBe('done');
    expect(systemLines(t, claude).at(-1)).toBe(
      'fix/checkout was tidied away: its work is in main, and main has moved on.',
    );
    expect(t.app.repos.activity.recent(1)[0]?.what).toBe('acme-shop · tidied away fix/checkout (landed)');
    // The second lane is the base's HEAD now: it stays, with Undo.
    expect(t.app.repos.worktrees.get(testFlaky)).toMatchObject({ archivedAt: null });
    expect(await sh(['show', 'HEAD:e.ts'], repo)).toBe('e');
  });

  it('autoLand: a refusal is one line in the chat, never a crash', async () => {
    const { t, repo } = await rig({ autoLand: true });
    writeFileSync(join(repo, 'a.ts'), 'dirty\n');
    finished(t, claude, 0);
    await t.app.land.maybeAutoLand(claude);
    expect(systemLines(t, claude).at(-1)).toBe(
      'Not landed: The main folder has uncommitted changes on main. Commit or discard them first.',
    );
    expect(t.app.repos.worktrees.get(fixCheckout)?.mergedAt).toBeNull();
  });
});
