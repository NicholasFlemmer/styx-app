import { fixtures, type Checkpoint, type ProjectId, type SessionId, type WorktreeId } from '@styx/core';
import { execa } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import {
  CHECKPOINT_REF_ROOT,
  CheckpointService,
  checkpointRef,
  parseNumstat,
  screenshotSourceFor,
  sumNumstat,
  withScreen,
  SCREENS_KEEP_TURNS,
} from './checkpoint-service';
import { ExecaGitRunner } from './git';
import { ScreensStore } from './screens-store';

const { ids } = fixtures;
const claude = ids.session.claude as SessionId;
const fixCheckout = ids.worktree.fixCheckout as WorktreeId;
const acme = ids.project.acmeShop as ProjectId;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * The service with a screenshot source of the test's choosing and a real on-disk ScreensStore in a temp dir
 * (the container's own instance answers null for both: no device, no design window in tests).
 */
const withScreens = (
  t: TestApp,
  screenshot: (projectId: ProjectId) => Promise<Buffer | null>,
  opts: { captureTimeoutMs?: number } = {},
): { service: CheckpointService; screens: ScreensStore; dir: string } => {
  const dir = join(mkdtempSync(join(tmpdir(), 'styx-cp-screens-')), 'screens');
  const screens = new ScreensStore(dir);
  const service = new CheckpointService({
    repos: t.app.repos,
    publisher: t.app.publisher,
    clock: t.clock,
    git: new ExecaGitRunner(),
    transcript: t.app.transcript,
    rescanHunks: async () => undefined,
    screens,
    screenshot,
    ...opts,
  });
  return { service, screens, dir };
};

/** A turn through a given service instance: start on `messageId`, mutate, settle. */
const turnOn = async (
  service: CheckpointService,
  t: TestApp,
  messageId: string,
  mutate: () => void,
): Promise<Checkpoint> => {
  service.onTurnStarted(claude, messageId);
  await service.settled(claude);
  mutate();
  service.onTurnSettled(claude);
  await service.settled(claude);
  const row = t.app.repos.checkpoints.bySession(claude).at(-1);
  if (row === undefined) throw new Error('no checkpoint row');
  return row;
};

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
  it('onTurnStarted resolves once the baseline exists, so an agent editing at once still has its edit in the turn', async () => {
    const t = makeTestApp();
    const repo = await realWorktree(t);
    // The agent starts the moment the promise resolves (what SessionService does): no settled() in between.
    await t.app.checkpoints.onTurnStarted(claude, 'm1');
    expect(rows(t).at(-1)?.baseRef).toBe('refs/styx/checkpoints/' + claude + '/1/base');
    writeFileSync(join(repo, 'first-edit.ts'), 'written straight away\n');
    t.app.checkpoints.onTurnSettled(claude);
    await t.app.checkpoints.settled(claude);
    const row = rows(t).at(-1);
    expect(row?.files).toBe(1);
    expect(await treeOf(repo, row?.baseRef ?? '')).not.toContain('first-edit.ts');
  });

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

  describe('screens (the running app before and after each turn)', () => {
    const shot = (n: number): Buffer => Buffer.concat([PNG, Buffer.from([n])]);

    it("screenshotSourceFor: a device session owns the picture; else the page, but only when the design window has this project's URL loaded", () => {
      const p = 'p1';
      const L = 'http://localhost:3000/';
      const web = { projectId: p, phase: 'running', platform: 'web', url: 'http://localhost:3000' } as const;
      const webNoUrl = { projectId: p, phase: 'running', platform: 'web', url: null } as const;
      const ios = { projectId: p, phase: 'running', platform: 'ios', url: null } as const;
      const gone = { projectId: p, phase: 'exited', platform: 'web', url: 'http://localhost:3000' } as const;
      const other = {
        projectId: 'p2',
        phase: 'running',
        platform: 'web',
        url: 'http://localhost:4000',
      } as const;
      const table: [Parameters<typeof screenshotSourceFor>[0], ReturnType<typeof screenshotSourceFor>][] = [
        // Device sessions win, ready or still booting (the device answers null until it is ready; the page never stands in).
        [
          {
            projectId: p,
            devices: [{ projectId: p, phase: 'ready' }],
            runs: [web],
            devUrl: null,
            loadedUrl: L,
          },
          'device',
        ],
        [
          {
            projectId: p,
            devices: [{ projectId: p, phase: 'booting' }],
            runs: [ios],
            devUrl: 'http://localhost:3000',
            loadedUrl: null,
          },
          'device',
        ],
        // A stopped / failed device session no longer counts.
        [
          {
            projectId: p,
            devices: [{ projectId: p, phase: 'stopped' }],
            runs: [web],
            devUrl: null,
            loadedUrl: L,
          },
          'preview',
        ],
        [
          {
            projectId: p,
            devices: [{ projectId: p, phase: 'failed' }],
            runs: [],
            devUrl: null,
            loadedUrl: L,
          },
          null,
        ],
        // Another project's device is not this project's picture.
        [
          {
            projectId: p,
            devices: [{ projectId: 'p2', phase: 'ready' }],
            runs: [web],
            devUrl: null,
            loadedUrl: L,
          },
          'preview',
        ],
        // Live web run: the page, when it is the one the window loaded (`localhost:3000` and `…/` are the same page).
        [{ projectId: p, devices: [], runs: [web], devUrl: null, loadedUrl: 'localhost:3000' }, 'preview'],
        [{ projectId: p, devices: [], runs: [web], devUrl: null, loadedUrl: 'http://localhost:4000/' }, null],
        [{ projectId: p, devices: [], runs: [web], devUrl: null, loadedUrl: null }, null],
        [{ projectId: p, devices: [], runs: [webNoUrl], devUrl: null, loadedUrl: L }, null],
        // A device platform without a device session → nothing, even with a saved URL loaded.
        [{ projectId: p, devices: [], runs: [ios], devUrl: 'http://localhost:3000', loadedUrl: L }, null],
        // No live run for this project: the saved dev URL decides (the user runs the server themselves) — if loaded.
        [
          { projectId: p, devices: [], runs: [gone, other], devUrl: 'http://localhost:3000', loadedUrl: L },
          'preview',
        ],
        [
          {
            projectId: p,
            devices: [],
            runs: [gone, other],
            devUrl: 'http://localhost:3000',
            loadedUrl: 'http://localhost:4000/',
          },
          null,
        ],
        [{ projectId: p, devices: [], runs: [gone, other], devUrl: '  ', loadedUrl: L }, null],
        [{ projectId: p, devices: [], runs: [], devUrl: null, loadedUrl: L }, null],
      ];
      for (const [input, want] of table) expect(screenshotSourceFor(input), JSON.stringify(input)).toBe(want);
    });

    it('withScreen keeps the canonical before → after order whichever side landed first, without duplicates', () => {
      expect(withScreen([], 'before')).toEqual(['before']);
      expect(withScreen([], 'after')).toEqual(['after']);
      expect(withScreen(['before'], 'after')).toEqual(['before', 'after']);
      expect(withScreen(['after'], 'before')).toEqual(['before', 'after']);
      expect(withScreen(['before', 'after'], 'after')).toEqual(['before', 'after']);
    });

    it('a source that answers keeps before and after on disk and names them on the row, in order, published each time', async () => {
      const t = makeTestApp();
      const repo = await realWorktree(t);
      const asked: ProjectId[] = [];
      let n = 0;
      const { service, screens } = withScreens(t, async (projectId) => {
        asked.push(projectId);
        return shot(++n);
      });
      t.app.publisher.flush();
      t.win.sent.length = 0;
      const row = await turnOn(service, t, 'm1', () => writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n'));
      expect(row.screens).toEqual(['before', 'after']);
      expect(row).toMatchObject({ turn: 1, files: 1, ref: row.ref });
      // The pictures are the source's, kept per side; the source was asked for the session's project, twice.
      expect(await screens.screen(row.id, 'before')).toEqual(shot(1));
      expect(await screens.screen(row.id, 'after')).toEqual(shot(2));
      expect(asked).toEqual([acme, acme]);
      // Published four times: open, before landed, settled, after landed — the renderer sees each side as it arrives.
      t.app.publisher.flush();
      const deltas = t.win
        .batches()
        .flatMap((b) => b.deltas as { op: string; checkpoints?: Checkpoint[] }[])
        .filter((d) => d.op === 'checkpoints.replace');
      expect(deltas.map((d) => d.checkpoints?.[0]?.screens)).toEqual([
        [],
        ['before'],
        ['before'],
        ['before', 'after'],
      ]);
      // Revert leaves the pictures as they are: the turn can still be looked at.
      await service.revert(row.id);
      expect(rows(t)[0]?.screens).toEqual(['before', 'after']);
      expect(await screens.screen(row.id, 'after')).toEqual(shot(2));
    });

    it('a source that answers null (nothing running) changes nothing: no files, empty screens, the turn settles as usual', async () => {
      const t = makeTestApp();
      const repo = await realWorktree(t);
      const { service, dir } = withScreens(t, async () => null);
      const row = await turnOn(service, t, 'm1', () => writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n'));
      expect(row).toMatchObject({ turn: 1, files: 1, screens: [] });
      expect(row.ref).not.toBeNull();
      expect(existsSync(dir)).toBe(false);
    });

    it('a throwing source and one slower than the timeout are tolerated: the turn is unaffected and the missing side stays missing', async () => {
      const t = makeTestApp();
      const repo = await realWorktree(t);
      // Turn 1: the source throws on both sides.
      const throwing = withScreens(t, async () => {
        throw new Error('simctl: device not booted');
      });
      const one = await turnOn(throwing.service, t, 'm1', () =>
        writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n'),
      );
      expect(one).toMatchObject({ turn: 1, files: 1, screens: [] });
      expect(existsSync(throwing.dir)).toBe(false);
      // Turn 2: `before` never resolves (abandoned after the timeout), `after` answers: only `after` lands, and the
      // settle was never held up by the hanging capture beyond the timeout.
      let calls = 0;
      const slow = withScreens(
        t,
        () => (++calls === 1 ? new Promise<Buffer | null>(() => undefined) : Promise.resolve(shot(2))),
        { captureTimeoutMs: 30 },
      );
      const two = await turnOn(slow.service, t, 'm2', () => writeFileSync(join(repo, 'pay.ts'), 'one\n'));
      expect(two).toMatchObject({ turn: 2, files: 1, screens: ['after'] });
      expect(await slow.screens.screen(two.id, 'before')).toBeNull();
      expect(await slow.screens.screen(two.id, 'after')).toEqual(shot(2));
      expect(t.app.repos.transcripts.last(claude).at(-1)?.body).toBe('Turn 2: 1 files changed.');
    });

    it('a slow before never lets after overtake it: captures run in the session chain, one after the other', async () => {
      const t = makeTestApp();
      const repo = await realWorktree(t);
      const order: string[] = [];
      let n = 0;
      const { service, screens } = withScreens(t, async () => {
        const i = ++n;
        // The first capture (before) is the slow one; the settle is queued behind it and waits.
        if (i === 1) await new Promise((r) => setTimeout(r, 60));
        order.push(i === 1 ? 'before' : 'after');
        return shot(i);
      });
      service.onTurnStarted(claude, 'm1');
      writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n');
      service.onTurnSettled(claude);
      await service.settled(claude);
      const row = rows(t)[0];
      expect(order).toEqual(['before', 'after']);
      expect(row?.screens).toEqual(['before', 'after']);
      expect(await screens.screen(row?.id ?? '', 'before')).toEqual(shot(1));
      expect(await screens.screen(row?.id ?? '', 'after')).toEqual(shot(2));
    });

    it('a turn left open gets its after from the next start: the same picture as the new turn takes for before', async () => {
      const t = makeTestApp();
      const repo = await realWorktree(t);
      let n = 0;
      const { service, screens } = withScreens(t, async () => shot(++n));
      service.onTurnStarted(claude, 'm1');
      await service.settled(claude);
      writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n');
      service.onTurnStarted(claude, 'm2'); // no settle signal came (a pty session)
      await service.settled(claude);
      const [one, two] = rows(t);
      expect(one?.screens).toEqual(['before', 'after']);
      expect(two?.screens).toEqual(['before']);
      // Two captures in all: turn 1's before, then one picture shared by turn 1's after and turn 2's before.
      expect(n).toBe(2);
      expect(await screens.screen(one?.id ?? '', 'after')).toEqual(shot(2));
      expect(await screens.screen(two?.id ?? '', 'before')).toEqual(shot(2));
    });

    it('prune keeps pictures for the newest SCREENS_KEEP_TURNS turns of a live session only', async () => {
      const t = makeTestApp();
      await realWorktree(t);
      const { service, screens, dir } = withScreens(t, async () => PNG);
      // Rows straight into the repo (a real turn each would take minutes): every one with both pictures on disk.
      const base = t.app.repos.checkpoints.bySession(claude);
      expect(base).toEqual([]);
      const ids: string[] = [];
      for (let turn = 1; turn <= SCREENS_KEEP_TURNS + 3; turn += 1) {
        const id = `cp-cap-${turn}`;
        ids.push(id);
        t.app.repos.checkpoints.upsert({
          id,
          sessionId: claude,
          worktreeId: fixCheckout,
          turn,
          messageId: null,
          baseRef: `refs/styx/checkpoints/${claude}/${turn}/base`,
          ref: `refs/styx/checkpoints/${claude}/${turn}/after`,
          files: 1,
          added: 1,
          removed: 0,
          createdAt: t.clock.now(),
          settledAt: t.clock.now(),
          revertedAt: null,
          screens: ['before', 'after'],
        });
        await screens.putScreen(id, 'before', PNG);
        await screens.putScreen(id, 'after', PNG);
      }
      await service.prune();
      const after = t.app.repos.checkpoints.bySession(claude);
      expect(after).toHaveLength(SCREENS_KEEP_TURNS + 3);
      // The three oldest lost their pictures (files and row), the rest kept both; rows and refs stay for Review.
      for (const [i, row] of after.entries()) {
        const kept = i >= 3;
        expect(row.screens, row.id).toEqual(kept ? ['before', 'after'] : []);
        expect(existsSync(join(dir, `${row.id}-before.png`)), row.id).toBe(kept);
      }
    });

    it('prune drops the pictures with the rows', async () => {
      const t = makeTestApp();
      const repo = await realWorktree(t);
      const { service, screens, dir } = withScreens(t, async () => PNG);
      const row = await turnOn(service, t, 'm1', () => writeFileSync(join(repo, 'checkout.ts'), 'a\nB\nc\n'));
      expect(existsSync(join(dir, `${row.id}-before.png`))).toBe(true);
      expect(existsSync(join(dir, `${row.id}-after.png`))).toBe(true);
      await service.prune(); // live session: kept
      expect(existsSync(join(dir, `${row.id}-after.png`))).toBe(true);
      const s = t.app.repos.sessions.get(claude);
      if (!s) throw new Error('session');
      t.app.repos.sessions.upsert({ ...s, archivedAt: t.clock.now() });
      await service.prune();
      expect(rows(t)).toEqual([]);
      expect(existsSync(join(dir, `${row.id}-before.png`))).toBe(false);
      expect(existsSync(join(dir, `${row.id}-after.png`))).toBe(false);
      expect(await screens.screen(row.id, 'before')).toBeNull();
    });
  });
});
