import { execa } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BrokerClient } from '@styx/broker';
import { copy, fill, fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { slow } from '../test-timeouts';
import { sha256 } from './session-service';

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
  root: string;
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
  opts: { checksCommand?: string | null; remote?: boolean; autoLand?: boolean; askForChecks?: boolean } = {},
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
  // With no checks, a first landing asks the agent for them (issue #2); cases about something else start past that
  // ask, where a landing goes without checks and says so.
  if (opts.checksCommand === null && opts.askForChecks !== true) t.app.land.checksLearned(acme);
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
  return { t, checks, repo, wt1, wt2, bare, root };
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
describe('LandService (ADR-0025 phase C)', { timeout: slow(30_000) }, () => {
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
    const { t, checks, repo, wt1, bare, root } = await rig();
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
      revertCommit: null,
    });
    expect(t.app.repos.worktrees.get(acmeMain)?.headCommit).toBe(r.commit);
    expect(systemLines(t, claude).at(-1)).toBe(
      'Your work on fix/checkout is now in main and on origin. Undo is in Lanes until main moves on; after that the lane is tidied away by itself.',
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
    expect(after?.landing?.revertCommit).toBe(reverted);
    await expect(t.app.land.undo(fixCheckout)).rejects.toThrow('Nothing to undo on this lane.');

    // Land again after the undo: the revert is reapplied on main first, so the lane's work goes back in, and the
    // lane's own tree keeps its files (the revert never wipes it when main is brought in).
    const again = await t.app.land.land(fixCheckout, { title: 'Fix the checkout total, again', body: '' });
    expect(again.steps[0]).toMatch(/^reapplied the undone landing on main \([0-9a-f]{7}\)$/);
    expect(again.steps).toContain('pushed main');
    expect(await sh(['show', 'HEAD:a.ts'], repo)).toBe('a1');
    expect(await sh(['show', 'HEAD:b.ts'], repo)).toBe('b');
    expect(await sh(['show', 'HEAD:a.ts'], wt1)).toBe('a1');
    expect(await sh(['rev-parse', 'refs/heads/main'], bare)).toBe(again.commit);
    expect(t.app.repos.worktrees.get(fixCheckout)?.landing).toMatchObject({
      commit: again.commit,
      undoneAt: null,
      revertCommit: null,
    });
    // origin moves on (another machine pushes): the next fetch fast-forwards the main folder to it.
    const clone = join(root, 'clone');
    await sh(['clone', '-q', '-b', 'main', bare, clone], root);
    writeFileSync(join(clone, 'upstream.txt'), 'from elsewhere\n');
    await sh(['add', '.'], clone);
    await sh(['commit', '-q', '-m', 'upstream'], clone);
    await sh(['push', '-q', 'origin', 'HEAD:main'], clone);
    const tip = (await sh(['rev-parse', 'HEAD'], clone)).trim();
    await t.app.laneSync.refresh(acme);
    expect((await sh(['rev-parse', 'main'], repo)).trim()).toBe(tip);
    // And that landing (a single commit, not a merge) can be undone too — main has moved, so not any more.
    await expect(t.app.land.undo(fixCheckout)).rejects.toThrow(
      'main has moved on since that landing; undo it by hand.',
    );
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
    // Waiting on the person is not mid-turn: the refusal says what to do.
    t.app.repos.sessions.upsert({ ...s, state: 'needs-you' });
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toThrow(
      'Claude Code is waiting on you on fix/checkout; answer it (or stop it) before landing.',
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

  it("the lane's own agent lands it from inside its turn: mid-turn is not a refusal for the caller", async () => {
    const { t, repo } = await rig();
    const s = t.app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    t.app.repos.sessions.upsert({ ...s, state: 'working' });
    // Anyone else still waits for the turn to end…
    await expect(t.app.land.land(testFlaky, { title: 'x', body: '' }, { caller: claude })).rejects.toThrow(
      'Nothing to land',
    );
    // …but the owner's `land` call brings main in (it is behind by one) and lands.
    const r = await t.app.land.land(
      fixCheckout,
      { title: 'Fix the checkout total', body: '' },
      { caller: claude },
    );
    expect(r.steps).toContain('brought in main (1)');
    expect(await sh(['rev-parse', 'HEAD'], repo)).toBe(r.commit);
    expect(t.app.repos.worktrees.get(fixCheckout)?.mergedAt).not.toBeNull();
  });

  it('a merge its agent finished is verified by the landing, not left at "resolving" until a turn ends', async () => {
    const { t, repo, wt1 } = await rig({ checksCommand: null });
    // The lane is mid-merge of main, resolved by hand (no markers), with the resolver waiting on the turn's end.
    await sh(['add', '.'], wt1);
    await sh(['commit', '-q', '-m', 'lane work'], wt1);
    await sh(['merge', '--no-commit', '--no-ff', 'main'], wt1).catch(() => undefined);
    const lane = t.app.repos.worktrees.get(fixCheckout);
    if (!lane) throw new Error('lane');
    const preHead = await sh(['rev-parse', 'HEAD'], wt1);
    t.app.repos.worktrees.upsert({
      ...lane,
      resolution: {
        state: 'resolving',
        sessionId: claude,
        files: ['c.ts'],
        preHead,
        preTree: null,
        mergeCommit: null,
        attempts: 2,
        startedAt: t.clock.now(),
        finishedAt: null,
        failure: 'conflict markers remain in c.ts',
      },
    });
    const s = t.app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    t.app.repos.sessions.upsert({ ...s, state: 'working' });
    const r = await t.app.land.land(fixCheckout, { title: 'Land it', body: '' }, { caller: claude });
    expect(t.app.repos.worktrees.get(fixCheckout)?.resolution?.state).toBe('done');
    expect(await sh(['show', 'HEAD:c.ts'], repo)).toBe('c');
    expect(await sh(['rev-parse', 'HEAD'], repo)).toBe(r.commit);
  });

  it("issue #2: the first landing with no checks asks the lane's agent to work them out; it alone may teach them, and the next landing runs them", async () => {
    const { t, checks, repo } = await rig({ checksCommand: null, askForChecks: true });
    const ask = vi.spyOn(t.app.sessions, 'sendMessage').mockResolvedValue(undefined);
    const before = await sh(['rev-parse', 'HEAD'], repo);
    await expect(t.app.land.land(fixCheckout, { title: 'Fix the checkout total', body: '' })).rejects.toThrow(
      fill(copy.land.learningChecks, { branch: 'fix/checkout', agent: copy.agentProducts.claude }),
    );
    expect(await sh(['rev-parse', 'HEAD'], repo)).toBe(before);
    expect(checks).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith(
      claude,
      fill(copy.agentPrompt.learnChecks, {
        branch: 'fix/checkout',
        base: 'main',
        then: copy.agentPrompt.learnChecksThenLand,
      }),
      [],
      { now: true, from: 'styx' },
    );
    expect(t.app.land.askedForChecks(claude)).toBe(true);
    expect(t.app.land.askedForChecks(codex)).toBe(false);

    // The agent teaches them through the broker: accepted from it, refused from a session nobody asked.
    await t.app.broker.listen();
    const connect = async (sessionId: string) => {
      const token = randomBytes(32).toString('hex');
      t.app.repos.sessions.setBrokerTokenHash(sessionId, sha256(token));
      const c = new BrokerClient({ endpoint: t.app.runtime.brokerEndpoint, sessionId, token, client: 'mcp' });
      await c.connect();
      return c;
    };
    const other = await connect(codex);
    await expect(other.call('remember_command', { kind: 'checks', command: 'pnpm test' })).rejects.toThrow(
      copy.abilities.checksNotResolving,
    );
    other.close();
    const agent = await connect(claude);
    expect(
      await agent.call('remember_command', { kind: 'checks', command: '  pnpm typecheck && pnpm test ' }),
    ).toEqual({ ok: true });
    agent.close();
    expect(t.app.repos.projects.settings(acme).checksCommand).toBe('pnpm typecheck && pnpm test');
    expect(systemLines(t, claude)).toContain(
      fill(copy.abilities.learnedChecks, { command: 'pnpm typecheck && pnpm test' }),
    );
    expect(t.app.repos.activity.recent(20).map((a) => a.what)).toContain(
      fill(copy.abilities.activityChecks, { agent: copy.agentProducts.claude, project: 'acme-shop' }),
    );
    // The ask is spent once answered.
    expect(t.app.land.askedForChecks(claude)).toBe(false);
    await t.app.broker.close();

    const r = await t.app.land.land(fixCheckout, { title: 'Fix the checkout total', body: '' });
    expect(checks).toHaveBeenCalledWith(expect.any(String), 'pnpm typecheck && pnpm test');
    expect(r.steps).toContain(copy.land.steps.checks);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('issue #2: asked once — the next landing goes without checks and says so; review mode asks the agent to report, not land; no agent to ask lands without', async () => {
    const { t } = await rig({ checksCommand: null, askForChecks: true });
    const ask = vi.spyOn(t.app.sessions, 'sendMessage').mockResolvedValue(undefined);
    await t.app.projects.setSettings(acme, { integration: 'review' });
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' })).rejects.toThrow(
      fill(copy.land.learningChecksReview, { branch: 'fix/checkout', agent: copy.agentProducts.claude }),
    );
    expect(ask.mock.calls[0]?.[1]).toContain(copy.agentPrompt.learnChecksThenTell);
    // The agent did not teach them (or could not): Land again goes ahead, saying none ran.
    const r = await t.app.land.land(fixCheckout, { title: 'x', body: '' });
    expect(r.steps).toContain(copy.land.steps.noChecks);
    expect(ask).toHaveBeenCalledTimes(1);

    // A lane whose agent is a shell has nobody to ask: it lands without, at once.
    const fresh = await rig({ checksCommand: null, askForChecks: true });
    const ask2 = vi.spyOn(fresh.t.app.sessions, 'sendMessage').mockResolvedValue(undefined);
    const s = fresh.t.app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    fresh.t.app.repos.sessions.upsert({ ...s, agent: 'shell' });
    const r2 = await fresh.t.app.land.land(fixCheckout, { title: 'x', body: '' });
    expect(r2.steps).toContain(copy.land.steps.noChecks);
    expect(ask2).not.toHaveBeenCalled();
  });

  it('issue #2: the agent calling land from its own turn is told, in the refusal, to work out the checks and land again', async () => {
    const { t } = await rig({ checksCommand: null, askForChecks: true });
    const ask = vi.spyOn(t.app.sessions, 'sendMessage').mockResolvedValue(undefined);
    await expect(t.app.land.land(fixCheckout, { title: 'x', body: '' }, { caller: claude })).rejects.toThrow(
      fill(copy.agentPrompt.learnChecks, {
        branch: 'fix/checkout',
        base: 'main',
        then: copy.agentPrompt.learnChecksThenLand,
      }),
    );
    expect(ask).not.toHaveBeenCalled();
    expect(t.app.land.askedForChecks(claude)).toBe(true);
  });

  it("landings of one project run one after another: the second brings the first's landing in before it merges", async () => {
    const { t, repo, wt2 } = await rig({ checksCommand: null });
    writeFileSync(join(wt2, 'd.ts'), 'd\n');
    const [one, two] = await Promise.all([
      t.app.land.land(fixCheckout, { title: 'checkout', body: '' }),
      t.app.land.land(testFlaky, { title: 'flaky', body: '' }),
    ]);
    expect(one.steps).toContain('brought in main (1)');
    // Issue #2: no checks known (and the agent asked already): said plainly, not implied by a missing line.
    expect(one.steps).toContain(copy.land.steps.noChecks);
    expect(one.steps).not.toContain(copy.land.steps.checks);
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
      'Your work on fix/checkout is now in main and on origin — landed on its own once the checks passed. Undo is in Lanes until main moves on; after that the lane is tidied away by itself.',
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
    // Reopening the agent brings its lane back where it was, caught up with main (owner request): the thread goes on.
    await t.app.sessions.reopen(claude);
    expect(existsSync(wt1)).toBe(true);
    expect(t.app.repos.worktrees.get(fixCheckout)).toMatchObject({
      archivedAt: null,
      mergedAt: null,
      landing: null,
      changes: { added: 0, removed: 0, files: 0 },
    });
    expect(await sh(['rev-parse', 'fix/checkout'], repo)).toBe(await sh(['rev-parse', 'main'], repo));
    expect(t.app.repos.sessions.get(claude)?.state).not.toBe('done');
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
