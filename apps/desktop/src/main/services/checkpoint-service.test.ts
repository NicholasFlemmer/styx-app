import { fixtures, type Checkpoint, type SessionId, type WorktreeId } from '@styx/core';
import { execa } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { CHECKPOINT_REF_ROOT, checkpointRef, parseNumstat, sumNumstat } from './checkpoint-service';

const { ids } = fixtures;
const claude = ids.session.claude as SessionId;
const fixCheckout = ids.worktree.fixCheckout as WorktreeId;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

const sh = async (args: string[], cwd: string): Promise<string> =>
  (await execa('git', args, { cwd, env: GIT_ENV })).stdout;

/**
 * A real repo (one commit: checkout.ts + pay.ts, `.gitignore` ignoring `*.log`) wired to the fixture's
 * `fix/checkout` worktree, whose owner is the Claude session; the session is set idle so a revert is allowed.
 */
const realWorktree = async (t: TestApp): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'styx-checkpoints-'));
  const repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await t.app.git.init(repo);
  writeFileSync(join(repo, 'checkout.ts'), 'a\nb\nc\n');
  writeFileSync(join(repo, 'pay.ts'), 'one\ntwo\n');
  writeFileSync(join(repo, '.gitignore'), '*.log\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
  const head = await t.app.git.headCommit(repo);
  const wt = t.app.repos.worktrees.get(fixCheckout);
  if (!wt) throw new Error('fixture worktree missing');
  t.app.repos.worktrees.upsert({ ...wt, path: repo, baseCommit: head });
  const s = t.app.repos.sessions.get(claude);
  if (!s) throw new Error('fixture session missing');
  t.app.repos.sessions.upsert({ ...s, state: 'idle' });
  // The project's path is the repo too: retention looks for refs there.
  const p = t.app.repos.projects.get(s.projectId);
  if (!p) throw new Error('fixture project missing');
  t.app.repos.projects.upsert({ ...p, path: repo }, t.app.repos.projects.settings(p.id));
  return repo;
};

const rows = (t: TestApp): Checkpoint[] => t.app.repos.checkpoints.bySession(claude);
const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8');
const refs = async (repo: string): Promise<string[]> =>
  (await sh(['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_ROOT}/`], repo))
    .split('\n')
    .filter(Boolean);
const treeOf = async (repo: string, rev: string): Promise<string[]> =>
  (await sh(['ls-tree', '-r', '--name-only', rev], repo)).split('\n').filter(Boolean).sort();

/** A turn: start on `messageId`, mutate the worktree, settle. */
const turn = async (t: TestApp, messageId: string, mutate: () => void): Promise<Checkpoint> => {
  t.app.checkpoints.onTurnStarted(claude, messageId);
  await t.app.checkpoints.settled(claude);
  mutate();
  t.app.checkpoints.onTurnSettled(claude);
  await t.app.checkpoints.settled(claude);
  const row = rows(t).at(-1);
  if (row === undefined) throw new Error('no checkpoint row');
  return row;
};

describe('CheckpointService', () => {
  it('parses numstat (binary rows count as files without lines) and sums it', () => {
    const files = parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n0\t4\tb.ts\n');
    expect(files).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'img.png', added: 0, removed: 0 },
      { path: 'b.ts', added: 0, removed: 4 },
    ]);
    expect(sumNumstat(files)).toEqual({ files: 3, added: 3, removed: 5 });
    expect(checkpointRef('s1', 2, 'after')).toBe('refs/styx/checkpoints/s1/2/after');
  });

  it('captures the worktree into hidden refs without touching the index, HEAD or the branch; ignored files stay out', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    const headBefore = await sh(['rev-parse', 'HEAD'], repo);
    // A staged change and an ignored file: the capture must leave the index alone and skip the log.
    writeFileSync(join(repo, 'pay.ts'), 'one\ntwo\nstaged\n');
    await sh(['add', 'pay.ts'], repo);
    writeFileSync(join(repo, 'debug.log'), 'noise\n');
    const indexBefore = await sh(['ls-files', '--stage'], repo);

    const row = await turn(t, 'm1', () => {
      writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\nd\n'); // modified
      writeFileSync(join(repo, 'validate.ts'), 'x\ny\n'); // untracked, captured
      writeFileSync(join(repo, 'trace.log'), 'ignored\n'); // ignored, not captured
    });

    expect(row).toMatchObject({
      sessionId: claude,
      worktreeId: fixCheckout,
      turn: 1,
      messageId: 'm1',
      baseRef: 'refs/styx/checkpoints/' + claude + '/1/base',
      ref: 'refs/styx/checkpoints/' + claude + '/1/after',
      files: 2,
      added: 4,
      removed: 1,
      settledAt: t.clock.now(),
      revertedAt: null,
    });
    expect(await refs(repo)).toEqual([row.ref, row.baseRef]); // for-each-ref sorts by name
    expect(await treeOf(repo, row.baseRef)).toEqual(['.gitignore', 'checkout.ts', 'pay.ts']);
    expect(await treeOf(repo, row.ref ?? '')).toEqual(['.gitignore', 'checkout.ts', 'pay.ts', 'validate.ts']);
    // The base holds the worktree as it was (the staged pay.ts edit included); HEAD is the parent for a readable log.
    expect(await sh(['show', `${row.baseRef}:pay.ts`], repo)).toBe('one\ntwo\nstaged');
    expect(await sh(['rev-parse', `${row.baseRef}^`], repo)).toBe(headBefore);
    // Nothing moved: same HEAD, same branch tip, same index; no branch or tag appeared.
    expect(await sh(['rev-parse', 'HEAD'], repo)).toBe(headBefore);
    expect(await sh(['rev-parse', 'main'], repo)).toBe(headBefore);
    expect(await sh(['ls-files', '--stage'], repo)).toBe(indexBefore);
    expect(
      await sh(['for-each-ref', 'refs/heads', 'refs/tags'], repo).then((s) => s.split('\n').length),
    ).toBe(1);
    // A system line names the turn once it settles with changes; the row was published twice (open, settled).
    const lines = t.app.repos.transcripts.last(claude).filter((m) => m.payload.kind === 'system');
    expect(lines.at(-1)?.body).toBe('Turn 1: 2 files changed.');
    t.app.publisher.flush();
    const deltas = t.win
      .batches()
      .flatMap((b) => b.deltas)
      .filter((d) => d.op === 'checkpoints.replace');
    expect(deltas.length).toBe(2);
  });

  it('diff returns the patch and per-file counts; a running turn diffs base against the live worktree', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    const row = await turn(t, 'm1', () => {
      writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n');
      writeFileSync(join(repo, 'new.txt'), 'hi\n');
    });
    const d = await t.app.checkpoints.diff(row.id);
    expect(d.files).toEqual([
      { path: 'checkout.ts', added: 1, removed: 1 },
      { path: 'new.txt', added: 1, removed: 0 },
    ]);
    expect(d.patch).toContain('-b\n+B');
    expect(d.patch).toContain('+hi');

    // Turn 2 is still running: its diff is base vs. the worktree right now, untracked files included.
    t.app.checkpoints.onTurnStarted(claude, 'm2');
    await t.app.checkpoints.settled(claude);
    writeFileSync(join(repo, 'live.txt'), 'now\n');
    const open = rows(t).at(-1);
    if (open === undefined || open.ref !== null) throw new Error('turn 2 should be open');
    const live = await t.app.checkpoints.diff(open.id);
    expect(live.files).toEqual([{ path: 'live.txt', added: 1, removed: 0 }]);
    expect(live.patch).toContain('+now');
    // No change at all: no system line, zero counts.
    rmSync(join(repo, 'live.txt'));
    t.app.checkpoints.onTurnSettled(claude);
    await t.app.checkpoints.settled(claude);
    expect(rows(t).at(-1)).toMatchObject({ turn: 2, files: 0, added: 0, removed: 0 });
    expect(t.app.repos.transcripts.last(claude).filter((m) => m.body.startsWith('Turn 2'))).toEqual([]);
  });

  it('revert restores the worktree to before the turn: edits undone, added files deleted, deleted files back; later turns are marked too', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    const one = await turn(t, 'm1', () => {
      writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n');
    });
    const two = await turn(t, 'm2', () => {
      writeFileSync(join(repo, 'new.txt'), 'hi\n');
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src', 'deep.ts'), 'deep\n');
      rmSync(join(repo, 'pay.ts'));
    });
    await sh(['add', 'new.txt'], repo); // the agent staged one of its files
    writeFileSync(join(repo, 'keep.log'), 'ignored\n');
    t.win.sent.length = 0;

    await t.app.checkpoints.revert(one.id);

    expect(read(repo, 'checkout.ts')).toBe('a\nb\nc\n');
    expect(read(repo, 'pay.ts')).toBe('one\ntwo\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(existsSync(join(repo, 'src', 'deep.ts'))).toBe(false);
    expect(existsSync(join(repo, 'keep.log'))).toBe(true); // ignored files are never touched
    // Both turns are reverted; the refs stay (the diff can still be read).
    const after = rows(t);
    expect(after.map((c) => [c.turn, c.revertedAt])).toEqual([
      [1, t.clock.now()],
      [2, t.clock.now()],
    ]);
    expect((await refs(repo)).length).toBe(4);
    expect(t.app.repos.transcripts.last(claude).at(-1)?.body).toBe('Workspace restored to before turn 1.');
    // The hunks were re-scanned against the restored tree and the rows re-published.
    expect(t.win.events('hunks.changed').length).toBeGreaterThanOrEqual(1);
    t.app.publisher.flush();
    expect(
      t.win
        .batches()
        .flatMap((b) => b.deltas)
        .some((d) => d.op === 'checkpoints.replace'),
    ).toBe(true);
    expect(two.revertedAt).toBeNull();
  });

  it('revert keeps a pre-existing ignored file the turn un-ignored, never captures secret files, and refuses a second revert', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    // Before any turn: a secret the repo ignores, and a key file the repo forgot to ignore.
    writeFileSync(join(repo, '.env'), 'SECRET=hunter2\n');
    writeFileSync(join(repo, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\n');
    const ignore = read(repo, '.gitignore');
    writeFileSync(join(repo, '.gitignore'), `${ignore}.env\n`);
    const one = await turn(t, 'm1', () => {
      // The agent "fixes" the ignore file: .env is now un-ignored, so a naive revert would see it as added.
      writeFileSync(join(repo, '.gitignore'), ignore);
      writeFileSync(join(repo, 'added.txt'), 'new\n');
    });
    await t.app.checkpoints.revert(one.id);
    expect(read(repo, '.env')).toBe('SECRET=hunter2\n'); // it existed before the turn: kept
    expect(existsSync(join(repo, 'added.txt'))).toBe(false); // it did not: deleted
    expect(read(repo, '.gitignore')).toBe(`${ignore}.env\n`);
    // Secret files never became blobs under the checkpoint refs.
    for (const ref of await refs(repo)) {
      const tree = await sh(['ls-tree', '-r', '--name-only', ref], repo);
      expect(tree).not.toMatch(/deploy\.pem|^\.env$/m);
    }
    await expect(t.app.checkpoints.revert(one.id)).rejects.toMatchObject({ code: 'invalid-transition' });
  });

  it('revert is refused while the agent is working or waiting on the user', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    const row = await turn(t, 'm1', () => writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n'));
    for (const state of ['working', 'needs-you'] as const) {
      const s = t.app.repos.sessions.get(claude);
      if (!s) throw new Error('session');
      t.app.repos.sessions.upsert({ ...s, state });
      await expect(t.app.checkpoints.revert(row.id)).rejects.toMatchObject({ code: 'invalid-transition' });
    }
    expect(read(repo, 'checkout.ts')).toBe('a\nB\nc\n');
    await expect(t.app.checkpoints.revert('nope')).rejects.toMatchObject({ code: 'not-found' });
    // Through the bus: the same errors, typed.
    const r = await t.app.bus.dispatch(t.sender, 'checkpoint.revert', { checkpointId: row.id });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid-transition' } });
  });

  it('a turn left open settles when the next one starts, on the same snapshot as the new base', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    t.app.checkpoints.onTurnStarted(claude, 'm1');
    await t.app.checkpoints.settled(claude);
    writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n');
    // No settle signal (a pty session): the next turn closes it.
    t.app.checkpoints.onTurnStarted(claude, 'm2');
    await t.app.checkpoints.settled(claude);
    const [one, two] = rows(t);
    expect(one).toMatchObject({ turn: 1, files: 1, added: 1, removed: 1 });
    expect(two).toMatchObject({ turn: 2, ref: null, messageId: 'm2' });
    expect(await sh(['rev-parse', one?.ref ?? ''], repo)).toBe(
      await sh(['rev-parse', two?.baseRef ?? ''], repo),
    );
  });

  it('skips sessions in a plain folder and never breaks a turn when git fails', async () => {
    const t = makeTestApp();
    const folder = mkdtempSync(join(tmpdir(), 'styx-plain-'));
    const wt = t.app.repos.worktrees.get(fixCheckout);
    if (!wt) throw new Error('worktree');
    t.app.repos.worktrees.upsert({ ...wt, path: folder });
    t.app.checkpoints.onTurnStarted(claude, 'm1');
    t.app.checkpoints.onTurnSettled(claude);
    await t.app.checkpoints.settled(claude);
    expect(rows(t)).toEqual([]);
    // A worktree that vanished mid-turn: the settle logs and leaves the row open.
    const repo = await realWorktree(t);
    t.app.checkpoints.onTurnStarted(claude, 'm2');
    await t.app.checkpoints.settled(claude);
    rmSync(repo, { recursive: true, force: true });
    t.app.checkpoints.onTurnSettled(claude);
    await t.app.checkpoints.settled(claude);
    expect(rows(t)).toMatchObject([{ turn: 1, ref: null }]);
  });

  it('prune drops the refs and rows of archived or deleted sessions and of vanished worktrees', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    await turn(t, 'm1', () => writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n'));
    expect((await refs(repo)).length).toBe(2);
    // Live session, worktree present: kept.
    await t.app.checkpoints.prune();
    expect((await refs(repo)).length).toBe(2);
    expect(rows(t).length).toBe(1);
    // Archived: gone from git and from the DB.
    const s = t.app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    t.app.repos.sessions.upsert({ ...s, archivedAt: t.clock.now() });
    t.app.publisher.flush();
    t.win.sent.length = 0;
    await t.app.checkpoints.prune();
    expect(await refs(repo)).toEqual([]);
    expect(rows(t)).toEqual([]);
    t.app.publisher.flush();
    expect(
      t.win
        .batches()
        .flatMap((b) => b.deltas)
        .filter((d) => d.op === 'checkpoints.replace'),
    ).toMatchObject([{ sessionId: claude, checkpoints: [] }]);
    // A stray ref for a session that no longer exists at all is dropped too.
    await sh(['update-ref', `${CHECKPOINT_REF_ROOT}/ghost/1/base`, 'HEAD'], repo);
    await t.app.checkpoints.prune();
    expect(await refs(repo)).toEqual([]);
  });
});
