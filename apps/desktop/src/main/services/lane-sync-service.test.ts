import { copy, fixtures } from '@styx/core';
import { execa } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
const acmeMain = ids.worktree.acmeMain;
const fixCheckout = ids.worktree.fixCheckout;
const claude = ids.session.claude;

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

/** A real repo with one commit and the fixture's `fix/checkout` lane cut from main, owned by the Claude session. */
async function rig(): Promise<{ t: TestApp; repo: string; wt: string }> {
  const t = makeTestApp();
  const root = mkdtempSync(join(tmpdir(), 'styx-lane-sync-'));
  const repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await t.app.git.init(repo);
  writeFileSync(join(repo, 'a.ts'), 'a\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
  const head = await t.app.git.headCommit(repo);
  const wt = join(root, 'wt', 'fix-checkout');
  mkdirSync(join(root, 'wt'));
  await t.app.git.worktreeAdd(repo, { branch: 'fix/checkout', base: 'main', path: wt });
  const project = t.app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  t.app.repos.projects.upsert({ ...project, path: repo }, t.app.repos.projects.settings(project.id));
  const mainRow = t.app.repos.worktrees.get(acmeMain);
  const laneRow = t.app.repos.worktrees.get(fixCheckout);
  if (!mainRow || !laneRow) throw new Error('fixture worktrees');
  t.app.repos.worktrees.upsert({ ...mainRow, path: repo, baseCommit: head, headCommit: head });
  t.app.repos.worktrees.upsert({
    ...laneRow,
    path: wt,
    baseCommit: head,
    headCommit: head,
    pr: null,
    conflict: null,
  });
  const session = t.app.repos.sessions.get(claude);
  if (!session) throw new Error('fixture session');
  t.app.repos.sessions.upsert({ ...session, state: 'idle', pausedReason: null });
  return { t, repo, wt };
}

const lastSystemLine = (t: TestApp, sessionId: string): string | null =>
  t.app.repos.transcripts
    .last(sessionId)
    .filter((m) => m.payload.kind === 'system')
    .at(-1)?.body ?? null;

describe('LaneSyncService (keep lanes current, ADR-0023)', () => {
  it('fetch counts how far a lane is behind main and tells its session; sync merges main in and resets the count', async () => {
    const { t, repo, wt } = await rig();
    const { app, sender } = t;
    writeFileSync(join(repo, 'b.ts'), 'b\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'main moves'], repo);

    const fetched = await app.bus.dispatch(sender, 'worktree.fetch', { projectId: acme });
    expect(fetched.ok).toBe(true);
    expect(app.repos.worktrees.get(fixCheckout)?.behindBase).toBe(1);
    expect(app.repos.worktrees.get(acmeMain)?.behindBase).toBe(0);
    expect(lastSystemLine(t, claude)).toBe(
      'main moved: 1 new commits. Bring them in from Repo before you publish.',
    );
    // A second fetch with nothing new says nothing more.
    await app.bus.dispatch(sender, 'worktree.fetch', { projectId: acme });
    expect(t.app.repos.transcripts.last(claude).filter((m) => m.body.startsWith('main moved')).length).toBe(
      1,
    );

    // Mid-turn agents are left alone.
    const s = app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    app.repos.sessions.upsert({ ...s, state: 'working' });
    expect(await app.bus.dispatch(sender, 'worktree.sync', { worktreeId: fixCheckout })).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-input',
        message: 'Claude Code is mid-turn. Wait for it to finish, or stop it, before bringing in main.',
      },
    });
    app.repos.sessions.upsert({ ...s, state: 'idle' });

    const synced = await app.bus.dispatch(sender, 'worktree.sync', { worktreeId: fixCheckout });
    expect(synced).toEqual({ ok: true, value: { merged: 1, conflict: null } });
    expect(existsSync(join(wt, 'b.ts'))).toBe(true);
    const lane = app.repos.worktrees.get(fixCheckout);
    expect(lane?.behindBase).toBe(0);
    expect(lane?.headCommit).toBe(await app.git.headCommit(wt));
    expect(lastSystemLine(t, claude)).toBe('Brought in main: 1 commits.');
    expect(app.repos.activity.recent(1)[0]?.what).toBe(
      'acme-shop · brought main into fix/checkout (1 commits)',
    );

    // Nothing to bring in: no merge, one quiet line.
    expect(await app.bus.dispatch(sender, 'worktree.sync', { worktreeId: fixCheckout })).toEqual({
      ok: true,
      value: { merged: 0, conflict: null },
    });
    expect(lastSystemLine(t, claude)).toBe('Already up to date with main.');
    // The main worktree is the base itself.
    expect(await app.bus.dispatch(sender, 'worktree.sync', { worktreeId: acmeMain })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
  });

  it('a conflicting merge is undone on the spot: the tree is untouched, the lane is marked and the session pauses', async () => {
    const { t, repo, wt } = await rig();
    const { app, sender } = t;
    writeFileSync(join(repo, 'a.ts'), 'main version\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'main edits a'], repo);
    writeFileSync(join(wt, 'a.ts'), 'lane version\n');
    await sh(['add', '.'], wt);
    await sh(['commit', '-q', '-m', 'lane edits a'], wt);

    const r = await app.bus.dispatch(sender, 'worktree.sync', { worktreeId: fixCheckout });
    expect(r).toEqual({ ok: true, value: { merged: 0, conflict: { file: 'a.ts', against: 'main' } } });
    // The merge was aborted: no MERGE_HEAD, the lane's own content stands, the tree is clean.
    expect(existsSync(join(wt, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(wt, 'a.ts'), 'utf8')).toBe('lane version\n');
    expect((await app.git.status(wt)).clean).toBe(true);
    const lane = app.repos.worktrees.get(fixCheckout);
    expect(lane?.conflict).toEqual({ file: 'a.ts', against: 'main' });
    expect(lane?.behindBase).toBe(1);
    expect(app.repos.sessions.get(claude)).toMatchObject({ state: 'paused', pausedReason: 'conflict' });
    expect(lastSystemLine(t, claude)).toBe(
      'Could not bring in main: conflict in a.ts. The merge was undone; resolve it to continue.',
    );
    expect(copy.sync.conflict.length).toBeGreaterThan(0);
  });
});

describe('LaneSyncService.autoSync (ADR-0025)', () => {
  it('brings the base in at a turn boundary when clean, says so, and leaves a conflicting lane marked and paused', async () => {
    const { t, repo, wt } = await rig();
    const { app } = t;
    writeFileSync(join(repo, 'b.ts'), 'b\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'main adds b'], repo);
    await app.laneSync.autoSync(claude);
    expect(existsSync(join(wt, 'b.ts'))).toBe(true);
    expect(app.repos.worktrees.get(fixCheckout)?.behindBase).toBe(0);
    expect(lastSystemLine(t, claude)).toBe('Brought in main after this turn: 1 commits.');
    // Current → nothing to do, nothing said.
    const before = app.repos.transcripts.last(claude).length;
    await app.laneSync.autoSync(claude);
    expect(app.repos.transcripts.last(claude)).toHaveLength(before);

    // The setting turns it off; a lane owned by a hidden task is never touched either.
    const project = app.repos.projects.get(acme);
    if (!project) throw new Error('project');
    app.repos.projects.setSettings(acme, { ...app.repos.projects.settings(acme), autoSync: 'off' }, null);
    writeFileSync(join(repo, 'c.ts'), 'c\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'main adds c'], repo);
    await app.laneSync.autoSync(claude);
    expect(existsSync(join(wt, 'c.ts'))).toBe(false);
    app.repos.projects.setSettings(acme, { ...app.repos.projects.settings(acme), autoSync: 'turn' }, null);

    // A merge that would conflict: in review mode it is not attempted — the lane is marked, the session pauses,
    // the tree is untouched, and the line says how to ask the agent (phase B).
    app.repos.projects.setSettings(
      acme,
      { ...app.repos.projects.settings(acme), integration: 'review' },
      null,
    );
    writeFileSync(join(repo, 'a.ts'), 'main version\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'main edits a'], repo);
    writeFileSync(join(wt, 'a.ts'), 'lane version\n');
    await sh(['add', '.'], wt);
    await sh(['commit', '-q', '-m', 'lane edits a'], wt);
    await app.laneSync.autoSync(claude);
    expect(app.repos.worktrees.get(fixCheckout)?.conflict).toEqual({ file: 'a.ts', against: 'main' });
    expect(app.repos.sessions.get(claude)).toMatchObject({ state: 'paused', pausedReason: 'conflict' });
    expect(readFileSync(join(wt, 'a.ts'), 'utf8')).toBe('lane version\n');
    expect(existsSync(join(wt, 'c.ts'))).toBe(false);
    expect(lastSystemLine(t, claude)).toBe(
      'main conflicts with this lane in a.ts. Resolve on Repo asks Claude Code to merge it, both sides kept.',
    );
    expect(app.repos.worktrees.get(fixCheckout)?.resolution).toBeNull();
  });

  it('auto mode (the default): a conflicting turn-end sync is handed straight to the resolver', async () => {
    const { t, repo, wt } = await rig();
    const { app } = t;
    writeFileSync(join(repo, 'a.ts'), 'main version\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'main edits a'], repo);
    writeFileSync(join(wt, 'a.ts'), 'lane version\n');
    await sh(['add', '.'], wt);
    await sh(['commit', '-q', '-m', 'lane edits a'], wt);
    await app.laneSync.autoSync(claude);
    const lane = app.repos.worktrees.get(fixCheckout);
    expect(lane?.resolution).toMatchObject({ state: 'resolving', sessionId: claude, files: ['a.ts'] });
    expect(await app.git.mergeInProgress(wt)).toBe(true);
    expect(lastSystemLine(t, claude)).toContain('Conflicted files:');
  });
});

/**
 * A bare `origin` for the rig's repo with main pushed, plus a clone that moves origin's main by one commit
 * (`remote.ts`) — the state a fetch leaves behind: `origin/main` ahead of the local `main`.
 */
async function withOriginAhead(repo: string): Promise<{ bare: string; remoteHead: string }> {
  const root = dirname(repo);
  const bare = join(root, 'origin.git');
  await sh(['init', '--bare', '-q', bare], root);
  await sh(['remote', 'add', 'origin', bare], repo);
  await sh(['push', '-q', '-u', 'origin', 'main'], repo);
  const clone = join(root, 'clone');
  await sh(['clone', '-q', '-b', 'main', bare, clone], root);
  writeFileSync(join(clone, 'remote.ts'), 'r\n');
  await sh(['add', '.'], clone);
  await sh(['commit', '-q', '-m', 'on origin'], clone);
  await sh(['push', '-q', 'origin', 'main'], clone);
  return { bare, remoteHead: await sh(['rev-parse', 'HEAD'], clone) };
}

describe('LaneSyncService.freshenBase (the local base follows its upstream, ADR-0023 closed)', () => {
  it('fetch fast-forwards a clean main folder to origin, and the lane is measured against what origin has', async () => {
    const { t, repo, wt } = await rig();
    const { remoteHead } = await withOriginAhead(repo);
    // Before: local main is one behind origin; the lane matches local main exactly.
    expect(await sh(['rev-parse', 'main'], repo)).not.toBe(remoteHead);

    // An untracked file in the main folder (a `.styx/project.json` Styx wrote, say) does not block the move.
    writeFileSync(join(repo, 'scratch.txt'), 'x\n');
    const fetched = await t.app.bus.dispatch(t.sender, 'worktree.fetch', { projectId: acme });
    expect(fetched.ok).toBe(true);
    expect(await sh(['rev-parse', 'main'], repo)).toBe(remoteHead);
    expect(existsSync(join(repo, 'remote.ts'))).toBe(true);
    expect(existsSync(join(repo, 'scratch.txt'))).toBe(true);
    expect(t.app.repos.worktrees.get(fixCheckout)?.behindBase).toBe(1);
    expect(lastSystemLine(t, claude)).toBe(
      'main moved: 1 new commits. Bring them in from Repo before you publish.',
    );
    // The lane never hears "already up to date" about a main that origin has moved past.
    const synced = await t.app.bus.dispatch(t.sender, 'worktree.sync', { worktreeId: fixCheckout });
    expect(synced).toEqual({ ok: true, value: { merged: 1, conflict: null } });
    expect(existsSync(join(wt, 'remote.ts'))).toBe(true);
    expect(lastSystemLine(t, claude)).toBe('Brought in main: 1 commits.');
  });

  it('a dirty main folder is left alone; the lane is measured against origin/main and merges from it', async () => {
    const { t, repo, wt } = await rig();
    const { remoteHead } = await withOriginAhead(repo);
    const before = await sh(['rev-parse', 'main'], repo);
    writeFileSync(join(repo, 'a.ts'), 'edited, not committed\n');

    await t.app.git.fetch(repo);
    expect(await t.app.laneSync.freshenBase(acme)).toEqual({
      state: 'stale',
      reason: 'dirty',
      behind: 1,
      upstream: 'origin/main',
    });
    expect(await sh(['rev-parse', 'main'], repo)).toBe(before);
    expect(t.app.laneSync.baseRefOf(acme)).toBe('origin/main');

    await t.app.bus.dispatch(t.sender, 'worktree.fetch', { projectId: acme });
    expect(t.app.repos.worktrees.get(fixCheckout)?.behindBase).toBe(1);
    const synced = await t.app.bus.dispatch(t.sender, 'worktree.sync', { worktreeId: fixCheckout });
    expect(synced).toEqual({ ok: true, value: { merged: 1, conflict: null } });
    // The lane had no commits of its own, so origin's commit came in as a fast-forward.
    expect(await sh(['rev-parse', 'HEAD'], wt)).toBe(remoteHead);
    expect(existsSync(join(wt, 'remote.ts'))).toBe(true);
    expect(lastSystemLine(t, claude)).toBe('Brought in main: 1 commits.');
    // Once the folder is clean again the base catches up and the plain name is back.
    await sh(['checkout', '--', 'a.ts'], repo);
    expect((await t.app.laneSync.freshenBase(acme)).state).toBe('forwarded');
    expect(t.app.laneSync.baseRefOf(acme)).toBe('main');
  });

  it('a diverged main (local commits origin lacks) is never moved; the person sees it on the Repo row', async () => {
    const { t, repo } = await rig();
    await withOriginAhead(repo);
    writeFileSync(join(repo, 'local.ts'), 'l\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'local only'], repo);
    const before = await sh(['rev-parse', 'main'], repo);
    await t.app.git.fetch(repo);
    expect(await t.app.laneSync.freshenBase(acme)).toEqual({
      state: 'diverged',
      ahead: 1,
      behind: 1,
      upstream: 'origin/main',
    });
    expect(await sh(['rev-parse', 'main'], repo)).toBe(before);
    expect(t.app.laneSync.baseRefOf(acme)).toBe('main');
    const r = await t.app.bus.dispatch(t.sender, 'worktree.fetch', { projectId: acme });
    expect(r).toMatchObject({ ok: true, value: { ahead: 1, behind: 1 } });
  });

  it('a base checked out nowhere is moved by ref', async () => {
    const { t, repo } = await rig();
    const { remoteHead } = await withOriginAhead(repo);
    await sh(['checkout', '-q', '-b', 'other'], repo);
    await t.app.git.fetch(repo);
    expect((await t.app.laneSync.freshenBase(acme)).state).toBe('forwarded');
    expect(await sh(['rev-parse', 'main'], repo)).toBe(remoteHead);
    expect(await sh(['branch', '--show-current'], repo)).toBe('other');
  });

  it('no remote, no upstream: nothing to do and nothing said', async () => {
    const { t } = await rig();
    expect(await t.app.laneSync.freshenBase(acme)).toEqual({ state: 'no-remote' });
    expect(t.app.laneSync.baseRefOf(acme)).toBe('main');
  });
});
