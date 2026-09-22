import { execa } from 'execa';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copy, fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import type { ImageBlock, StreamEvents, StreamRunnerLike, StreamSpawnOptions } from './stream-runner';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
const acmeMain = ids.worktree.acmeMain;
const fixCheckout = ids.worktree.fixCheckout;
const claude = ids.session.claude;

/** The agent: records what Styx sends it; the test writes the files and says when it went quiet. */
class FakeStream extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  readonly spawned: StreamSpawnOptions[] = [];
  readonly sent: { id: string; text: string }[] = [];
  readonly live = new Set<string>();
  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    this.spawned.push(opts);
    this.live.add(opts.id);
    return { pid: 777 };
  }
  send(id: string, text: string, _blocks: readonly ImageBlock[] = []): void {
    this.sent.push({ id, text });
  }
  respondPermission(): void {}
  setModel(): void {}
  setPermissionMode(): void {}
  setEffort(): void {}
  interrupt(): void {}
  kill(id: string): void {
    if (!this.live.delete(id)) return;
    this.emit('exit', id, 0);
  }
  has(id: string): boolean {
    return this.live.has(id);
  }
  killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  quiet(id: string): void {
    this.emit('effect', id, { type: 'session', event: 'quiet' });
  }
}

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
  stream: FakeStream;
  checks: ReturnType<
    typeof vi.fn<(cwd: string, command: string) => Promise<{ exitCode: number; output: string }>>
  >;
  repo: string;
  wt: string;
}

/**
 * A real repo whose main and the fixture's `fix/checkout` lane (Claude, idle, "Fix the checkout total") both edited
 * `a.ts` since they parted: bringing main in conflicts on that one file.
 */
async function rig(
  opts: { checksCommand?: string | null; mergiraf?: (file: string, cwd: string) => Promise<boolean> } = {},
): Promise<Rig> {
  const stream = new FakeStream();
  const checks = vi.fn(async (_cwd: string, _command: string) => ({ exitCode: 0, output: '' }));
  const t = makeTestApp({ stream, runChecks: checks, ...(opts.mergiraf ? { mergiraf: opts.mergiraf } : {}) });
  const root = mkdtempSync(join(tmpdir(), 'styx-resolve-'));
  const repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await t.app.git.init(repo);
  writeFileSync(join(repo, 'a.ts'), 'a\n');
  writeFileSync(join(repo, 'b.ts'), 'b\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
  const head = await t.app.git.headCommit(repo);
  const wt = join(root, 'wt', 'fix-checkout');
  mkdirSync(join(root, 'wt'));
  await t.app.git.worktreeAdd(repo, { branch: 'fix/checkout', base: 'main', path: wt });
  const project = t.app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  t.app.repos.projects.upsert({ ...project, path: repo }, t.app.repos.projects.settings(project.id));
  t.app.repos.projects.setSettings(
    acme,
    {
      ...t.app.repos.projects.settings(acme),
      checksCommand: opts.checksCommand === undefined ? 'pnpm check' : opts.checksCommand,
    },
    null,
  );
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
    overlaps: [],
    resolution: null,
  });
  const session = t.app.repos.sessions.get(claude);
  if (!session) throw new Error('fixture session');
  t.app.repos.sessions.upsert({
    ...session,
    state: 'idle',
    pausedReason: null,
    firstMessage: 'Fix the checkout total',
  });
  // The conflict: both sides changed a.ts.
  writeFileSync(join(repo, 'a.ts'), 'main version\n');
  await sh(['commit', '-qam', 'main: rework a'], repo);
  writeFileSync(join(wt, 'a.ts'), 'lane version\n');
  await sh(['commit', '-qam', 'lane: fix the total in a'], wt);
  return { t, stream, checks, repo, wt };
}

const systemLines = (t: TestApp, sessionId: string): string[] =>
  t.app.repos.transcripts
    .last(sessionId)
    .filter((m) => m.payload.kind === 'system')
    .map((m) => m.body);
const lane = (t: TestApp) => {
  const w = t.app.repos.worktrees.get(fixCheckout);
  if (!w) throw new Error('lane');
  return w;
};
const parents = async (wt: string): Promise<number> =>
  (await sh(['rev-list', '--parents', '-n', '1', 'HEAD'], wt)).trim().split(' ').length - 1;

describe('MergeResolveService (ADR-0025 phase B)', () => {
  it(
    'hands the conflict to the lane agent with both intents, then verifies, runs the checks and commits the merge',
    { timeout: 30_000 },
    async () => {
      const { t, stream, checks, wt } = await rig();
      const { app } = t;
      const before = systemLines(t, claude).length;

      const r = await app.resolver.resolve(fixCheckout);
      expect(r).toEqual({ started: true, merged: 0 });
      // The merge is in progress in the lane, checkpointed, and the row says who is on it.
      expect(existsSync(join(wt, '.git', 'MERGE_HEAD')) || (await app.git.mergeInProgress(wt))).toBe(true);
      expect(readFileSync(join(wt, 'a.ts'), 'utf8')).toContain('<<<<<<<');
      const res = lane(t).resolution;
      expect(res).toMatchObject({
        state: 'resolving',
        sessionId: claude,
        files: ['a.ts'],
        attempts: 1,
        preTree: null,
      });
      expect(res?.preHead).toBe(await sh(['rev-parse', 'fix/checkout'], wt));
      // The agent got one Styx-authored turn: the file, this lane's intent, main's intent, the rules, the checks.
      const turn = stream.sent.at(-1)?.text ?? '';
      expect(turn).toContain('Conflicted files:\n- a.ts');
      expect(turn).toContain('yours (fix/checkout, "Fix the checkout total"): lane: fix the total in a');
      expect(turn).toContain('theirs (main): main: rework a');
      expect(turn).toContain('do not abort, rebase, or commit it');
      expect(turn).toContain('`pnpm check`');
      // …as a system row, never as the human's words.
      const rows = app.repos.transcripts.last(claude);
      expect(rows.at(-1)?.payload.kind).toBe('system');
      expect(rows.some((m) => m.payload.kind === 'user' && m.body.includes('Conflicted files'))).toBe(false);
      expect(systemLines(t, claude).slice(before)[0]).toBe(
        'main conflicts with this lane in a.ts. Claude Code is bringing it in now — both sides kept; the checks run before it counts.',
      );
      expect(app.repos.activity.recent(1)[0]?.what).toBe(
        'acme-shop · Claude Code is bringing main into fix/checkout',
      );

      // The agent resolves the file and goes quiet: Styx verifies, runs the checks in the lane, commits.
      writeFileSync(join(wt, 'a.ts'), 'main version\nlane version\n');
      stream.quiet(claude);
      await vi.waitFor(() => expect(lane(t).resolution?.state).toBe('done'), { timeout: 10_000 });
      expect(checks).toHaveBeenCalledWith(wt, 'pnpm check');
      expect(await app.git.mergeInProgress(wt)).toBe(false);
      expect(await parents(wt)).toBe(2);
      const done = lane(t);
      expect(done.resolution?.mergeCommit).toBe(await app.git.headCommit(wt));
      expect(done.headCommit).toBe(done.resolution?.mergeCommit);
      expect(done.conflict).toBeNull();
      expect(done.behindBase).toBe(0);
      expect((await sh(['log', '-1', '--format=%s'], wt)).trim()).toBe('Bring in main into fix/checkout');
      expect(systemLines(t, claude)).toContain(
        'Brought in main. a.ts were changed by both sides; both kept, checks pass. Undo is on the Repo lane.',
      );
      expect(app.repos.activity.recent(1)[0]?.what).toBe(
        'acme-shop · brought main into fix/checkout · resolved a.ts',
      );

      // Undo puts the lane back exactly: HEAD, the file, the row; the conflict is detected again.
      await app.resolver.undo(fixCheckout);
      expect(await app.git.headCommit(wt)).toBe(res?.preHead);
      expect(readFileSync(join(wt, 'a.ts'), 'utf8')).toBe('lane version\n');
      expect(lane(t)).toMatchObject({
        resolution: null,
        conflict: { file: 'a.ts', against: 'main' },
        behindBase: 1,
      });
      expect(systemLines(t, claude)).toContain(
        'Undid the merge of main: the lane is back to how it was before it.',
      );
      await expect(app.resolver.undo(fixCheckout)).rejects.toMatchObject({ code: 'invalid-transition' });
    },
  );

  it(
    'markers left → one more turn with the reason; still there → the merge is undone and the lane is as it was',
    { timeout: 30_000 },
    async () => {
      const { t, stream, wt } = await rig({ checksCommand: null });
      const { app } = t;
      await app.resolver.resolve(fixCheckout);
      expect(stream.sent).toHaveLength(1);
      stream.quiet(claude); // the agent did nothing
      await vi.waitFor(() => expect(lane(t).resolution?.attempts).toBe(2), { timeout: 10_000 });
      expect(lane(t).resolution?.state).toBe('resolving');
      expect(stream.sent).toHaveLength(2);
      expect(stream.sent[1]?.text).toBe(
        'Not finished yet: conflict markers remain in a.ts. Fix that and finish the merge as before — do not abort or commit it; Styx commits once the checks pass.',
      );
      expect(systemLines(t, claude)).toContain(
        'The merge is not finished: conflict markers remain in a.ts. Asked Claude Code once more.',
      );
      stream.quiet(claude); // still nothing
      await vi.waitFor(() => expect(lane(t).resolution?.state).toBe('failed'), { timeout: 10_000 });
      expect(await app.git.mergeInProgress(wt)).toBe(false);
      expect(readFileSync(join(wt, 'a.ts'), 'utf8')).toBe('lane version\n');
      expect((await app.git.status(wt)).clean).toBe(true);
      expect(lane(t)).toMatchObject({ conflict: { file: 'a.ts', against: 'main' } });
      expect(lane(t).resolution).toMatchObject({
        state: 'failed',
        attempts: 2,
        failure: 'conflict markers remain in a.ts',
      });
      expect(app.repos.sessions.get(claude)).toMatchObject({ state: 'paused', pausedReason: 'conflict' });
      expect(systemLines(t, claude)).toContain(
        'Could not finish bringing in main: conflict markers remain in a.ts. The merge was undone; the lane is as it was.',
      );
      expect(stream.sent).toHaveLength(2);
    },
  );

  it(
    'a red check goes back to the agent with the command, the exit code and the output tail',
    { timeout: 30_000 },
    async () => {
      const { t, stream, checks, wt } = await rig();
      checks.mockResolvedValueOnce({ exitCode: 2, output: 'src/a.ts(1,1): error TS1005' });
      await t.app.resolver.resolve(fixCheckout);
      writeFileSync(join(wt, 'a.ts'), 'merged\n');
      stream.quiet(claude);
      await vi.waitFor(() => expect(stream.sent).toHaveLength(2), { timeout: 10_000 });
      expect(stream.sent[1]?.text).toContain(
        'the checks failed (`pnpm check` exited 2)\nsrc/a.ts(1,1): error TS1005',
      );
      // Second time green: committed.
      stream.quiet(claude);
      await vi.waitFor(() => expect(lane(t).resolution?.state).toBe('done'), { timeout: 10_000 });
      expect(checks).toHaveBeenCalledTimes(2);
      expect(await parents(wt)).toBe(2);
    },
  );

  it(
    'a lane whose agent is gone gets a hidden merge task on the same lane; a conflict-free merge just lands',
    { timeout: 30_000 },
    async () => {
      const { t, stream, wt } = await rig({ checksCommand: null });
      const { app } = t;
      const s = app.repos.sessions.get(claude);
      if (!s) throw new Error('session');
      app.repos.sessions.upsert({ ...s, state: 'done', endedAt: fixtures.DEMO_NOW });
      const r = await app.resolver.resolve(fixCheckout);
      expect(r.started).toBe(true);
      const task = stream.spawned.at(-1);
      expect(task?.firstMessage).toContain('Conflicted files:\n- a.ts');
      const res = lane(t).resolution;
      expect(res?.sessionId).not.toBe(claude);
      const taskSession =
        res?.sessionId === null || res?.sessionId === undefined
          ? null
          : app.repos.sessions.get(res.sessionId);
      expect(taskSession).toMatchObject({ purpose: 'merge', worktreeId: fixCheckout });
      expect(lane(t).owner).toEqual({ kind: 'session', sessionId: taskSession?.id });
      writeFileSync(join(wt, 'a.ts'), 'merged\n');
      stream.quiet(taskSession?.id ?? '');
      await vi.waitFor(() => expect(lane(t).resolution?.state).toBe('done'), { timeout: 10_000 });
      expect(await parents(wt)).toBe(2);
      // The hidden task ends with its turn.
      expect(app.repos.sessions.get(taskSession?.id ?? '')?.state).toBe('done');

      // Nothing to resolve: a lane that is current says so without starting anything.
      expect(await app.resolver.resolve(fixCheckout)).toEqual({ started: false, merged: 0 });
    },
  );

  it(
    'Mergiraf settles what it can before any agent is asked; a fully mechanical merge is committed as a sync',
    { timeout: 30_000 },
    async () => {
      const mergiraf = vi.fn(async (file: string, cwd: string) => {
        writeFileSync(join(cwd, file), 'main version\nlane version\n');
        return true;
      });
      const { t, stream, wt } = await rig({ mergiraf, checksCommand: null });
      const r = await t.app.resolver.resolve(fixCheckout);
      expect(mergiraf).toHaveBeenCalledWith('a.ts', wt);
      expect(r).toEqual({ started: false, merged: 1 });
      expect(stream.sent).toHaveLength(0);
      expect(await parents(wt)).toBe(2);
      expect(lane(t)).toMatchObject({ conflict: null, behindBase: 0 });
      expect(lane(t).resolution).toMatchObject({ state: 'done', sessionId: null, files: [] });
      expect(systemLines(t, claude)).toContain(
        copy.sync.synced.replace('{base}', 'main').replace('{n}', '1'),
      );
    },
  );

  it(
    'Stop merging while the agent is at it: its turn is interrupted, the merge undone, the conflict marked again',
    { timeout: 30_000 },
    async () => {
      const { t, wt } = await rig();
      const { app } = t;
      const r = await app.resolver.resolve(fixCheckout);
      expect(r).toEqual({ started: true, merged: 0 });
      const res = lane(t).resolution;
      expect(res?.state).toBe('resolving');
      // The person stops it from the Repo row: undoResolve while resolving.
      await app.resolver.undo(fixCheckout);
      expect(await app.git.mergeInProgress(wt)).toBe(false);
      expect(await app.git.headCommit(wt)).toBe(res?.preHead);
      expect(readFileSync(join(wt, 'a.ts'), 'utf8')).toBe('lane version\n');
      expect(lane(t)).toMatchObject({
        conflict: { file: 'a.ts', against: 'main' },
        resolution: { state: 'failed', failure: 'stopped by you' },
      });
      expect(systemLines(t, claude)).toContain(
        'Stopped bringing in main: the merge was undone and the lane is as it was. Resolve is on the Repo lane.',
      );
      expect(app.repos.activity.recent(1)[0]?.what).toBe(
        'acme-shop · stopped bringing main into fix/checkout',
      );
      // Resolve is offered again and works.
      const again = await app.resolver.resolve(fixCheckout);
      expect(again).toEqual({ started: true, merged: 0 });
    },
  );

  it('refuses while the agent is mid-turn, and does nothing twice', { timeout: 30_000 }, async () => {
    const { t } = await rig();
    const s = t.app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    t.app.repos.sessions.upsert({ ...s, state: 'working' });
    await expect(t.app.resolver.resolve(fixCheckout)).rejects.toMatchObject({ code: 'invalid-input' });
    t.app.repos.sessions.upsert({ ...s, state: 'idle' });
    expect((await t.app.resolver.resolve(fixCheckout)).started).toBe(true);
    expect(await t.app.resolver.resolve(fixCheckout)).toEqual({ started: false, merged: 0 });
  });
});
