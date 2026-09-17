import { copy, fixtures, type Agent, type ProjectId, type WorktreeId } from '@styx/core';
import { execa } from 'execa';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import {
  agentInvocation,
  commitText,
  draftInput,
  DRAFT_DIFF_LIMIT,
  fallbackDraft,
  parseDraft,
  parsePrUrl,
  PublishService,
  statsOf,
  type ExecOptions,
  type ExecResult,
} from './publish-service';

const { ids } = fixtures;
const fixCheckout = ids.worktree.fixCheckout as WorktreeId;
const acmeMain = ids.worktree.acmeMain as WorktreeId;
const acme = ids.project.acmeShop as ProjectId;

const sh = async (args: string[], cwd: string): Promise<string> => {
  const r = await execa('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  return String(r.stdout ?? '').trim();
};

interface Call {
  file: string;
  args: string[];
  opts: ExecOptions;
}

/** Scriptable `exec`: every call is recorded; answers are keyed on the leading argv (`gh pr view` …). */
class FakeExec {
  readonly calls: Call[] = [];
  private readonly answers: { prefix: string[]; answer: Partial<ExecResult> | Error }[] = [];
  on(prefix: string[], answer: Partial<ExecResult> | Error): this {
    this.answers.unshift({ prefix, answer });
    return this;
  }
  readonly fn = async (file: string, args: string[], opts: ExecOptions): Promise<ExecResult> => {
    this.calls.push({ file, args, opts });
    const hit = this.answers.find((a) => a.prefix.every((p, i) => args[i] === p));
    if (hit === undefined)
      return { stdout: '', stderr: `no answer for ${args.join(' ')}`, exitCode: 1, timedOut: false };
    if (hit.answer instanceof Error) throw hit.answer;
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...hit.answer };
  };
  of(...prefix: string[]): Call[] {
    return this.calls.filter((c) => prefix.every((p, i) => c.args[i] === p));
  }
}

interface Rig {
  t: TestApp;
  exec: FakeExec;
  svc: PublishService;
  repo: string;
  wt: string;
  bare: string;
  settings: { defaultAgent: Agent; baseBranch: string };
}

/**
 * A real repo: `main` with one commit, a `fix/checkout` worktree (the fixture's Claude lane) with a modified file
 * and an untracked one, and — unless `remote: false` — a bare `origin` under the temp dir so pushes succeed.
 * `gh` is an executable stub on a temp PATH so the lookup resolves; the fake exec never runs it.
 */
const rig = async (opts: { remote?: boolean; agent?: Agent; dirty?: boolean } = {}): Promise<Rig> => {
  const t = makeTestApp();
  const root = mkdtempSync(join(tmpdir(), 'styx-publish-'));
  const repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await t.app.git.init(repo);
  writeFileSync(join(repo, 'checkout.ts'), 'a\nb\nc\n');
  writeFileSync(join(repo, 'pay.ts'), 'one\ntwo\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
  const head = await t.app.git.headCommit(repo);
  const wt = join(root, 'wt', 'fix-checkout');
  mkdirSync(join(root, 'wt'));
  await t.app.git.worktreeAdd(repo, { branch: 'fix/checkout', base: 'main', path: wt });
  if (opts.dirty ?? true) {
    writeFileSync(join(wt, 'checkout.ts'), 'a\nb\nc\nd\n');
    writeFileSync(join(wt, 'validate.ts'), 'export const validate = () => true\n');
  }
  const bare = join(root, 'origin.git');
  if (opts.remote ?? true) {
    await sh(['init', '--bare', '-q', bare], root);
    await sh(['remote', 'add', 'origin', bare], repo);
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'gh'), 0o755);

  const project = t.app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  t.app.repos.projects.upsert({ ...project, path: repo }, t.app.repos.projects.settings(project.id));
  const mainRow = t.app.repos.worktrees.get(acmeMain);
  const laneRow = t.app.repos.worktrees.get(fixCheckout);
  if (!mainRow || !laneRow) throw new Error('fixture worktrees');
  t.app.repos.worktrees.upsert({ ...mainRow, path: repo, baseCommit: head, headCommit: head });
  t.app.repos.worktrees.upsert({ ...laneRow, path: wt, baseCommit: head, headCommit: head, pr: null });
  // The GitHub target's fixture credential, so the grant can be issued.
  const gh = t.app.repos.targets.get(ids.target.github);
  if (gh?.credentialRef) await t.vault.set(gh.credentialRef, JSON.stringify({ token: 'ghp_grant' }));

  const settings = { defaultAgent: opts.agent ?? 'claude', baseBranch: 'main' };
  const exec = new FakeExec();
  const svc = new PublishService({
    repos: t.app.repos,
    publisher: t.app.publisher,
    clock: t.clock,
    git: t.app.git,
    grants: t.app.grants,
    activity: t.app.activity,
    audit: t.app.audit,
    exec: exec.fn,
    projectSettings: () => settings,
    loginPath: async () => '',
    env: { PATH: bin },
    platform: 'darwin',
    draftTimeoutMs: 1000,
  });
  return { t, exec, svc, repo, wt, bare, settings };
};

const claudeReply = (text: string): Partial<ExecResult> => ({
  stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }),
});
const codexReply = (text: string): Partial<ExecResult> => ({
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n'),
});
const NO_PR: Partial<ExecResult> = {
  exitCode: 1,
  stderr: 'no pull requests found for branch "fix/checkout"',
};
const CREATED: Partial<ExecResult> = { stdout: 'https://github.com/acme/shop/pull/7\n' };

/** Feed rows this publish wrote (the demo fixture seeds others). */
const activityRows = (t: TestApp) =>
  t.app.repos.activity
    .recent(50)
    .map((r) => r.what)
    .filter((w) => w.includes('published'));
/** Grants the publish requested on the GitHub target (the fixture seeds agent grants there too). */
const publishGrants = (t: TestApp) =>
  t.app.repos.grants.byTarget(ids.target.github).filter((g) => g.reason.startsWith('Publish '));
const openedPrRows = (t: TestApp) =>
  t.app.repos.audit
    .recent(100)
    .filter((e) => e.action === 'opened-pr' && e.triggeredBy === 'worktree.publish');

describe('PublishService.generateMessage', () => {
  it('pipes branch, numstat and patch to `claude -p --output-format json` with tools off and parses the reply', async () => {
    const { exec, svc } = await rig();
    exec.on(
      ['-p'],
      claudeReply('Validate the cart before paying\n\nAdds validate.ts and calls it from checkout.'),
    );
    const m = await svc.generateMessage(fixCheckout, 'commit');
    expect(m).toEqual({
      title: 'Validate the cart before paying',
      body: 'Adds validate.ts and calls it from checkout.',
    });
    const call = exec.calls[0];
    expect(call?.file).toBe('/opt/homebrew/bin/claude'); // the discovery row's binary
    expect(call?.args.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--tools', '']);
    expect(call?.args.at(-1)).toContain('commit message');
    expect(call?.opts.input).toContain('Branch: fix/checkout (base: main)');
    expect(call?.opts.input).toContain('checkout.ts +1 -0');
    expect(call?.opts.input).toContain('validate.ts +1 -0');
    expect(call?.opts.input).toContain('+export const validate');
    expect(call?.opts.timeoutMs).toBe(1000);
    // The agent runs plainly, never with a provider token in its env.
    expect(call?.opts.env).toEqual({ NO_COLOR: '1', TERM: 'dumb' });
  });

  it('Codex: `codex exec --json` read-only and ephemeral; the last agent_message is the draft', async () => {
    const { exec, svc } = await rig({ agent: 'codex' });
    exec.on(
      ['exec'],
      codexReply('Add cart validation\n\n## Summary\n- validate.ts\n\n## Test plan\n- run tests'),
    );
    const m = await svc.generateMessage(fixCheckout, 'pr');
    expect(m.title).toBe('Add cart validation');
    expect(m.body).toBe('## Summary\n- validate.ts\n\n## Test plan\n- run tests');
    const call = exec.calls[0];
    expect(call?.file).toBe('/opt/homebrew/bin/codex');
    expect(call?.args.slice(0, 6)).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
    ]);
    expect(call?.args.at(-1)).toContain('pull request');
  });

  it.each([
    ['exits non-zero', { exitCode: 2, stderr: 'boom' }],
    ['times out', { exitCode: 124, timedOut: true }],
    [
      'answers with an error result',
      { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'quota' }) },
    ],
    ['answers with nothing readable', { stdout: 'not json' }],
  ])('falls back to a message drafted from the file list when the agent %s', async (_label, answer) => {
    const { exec, svc } = await rig();
    exec.on(['-p'], answer);
    const m = await svc.generateMessage(fixCheckout, 'commit');
    expect(m.title).toBe('Update checkout.ts and validate.ts');
    expect(m.body).toBe('- checkout.ts (+1 −0)\n- validate.ts (+1 −0)');
  });

  it('falls back without running anything when the agent has no headless mode or no binary', async () => {
    const cursor = await rig({ agent: 'cursor' });
    expect((await cursor.svc.generateMessage(fixCheckout, 'commit')).title).toBe(
      'Update checkout.ts and validate.ts',
    );
    expect(cursor.exec.calls).toHaveLength(0);

    const missing = await rig({ agent: 'claude' });
    const row = missing.t.app.repos.discovery.cli('claude');
    if (!row) throw new Error('fixture cli row');
    missing.t.app.repos.discovery.saveCli({ ...row, binary: null, found: false });
    expect((await missing.svc.generateMessage(fixCheckout, 'commit')).title).toBe(
      'Update checkout.ts and validate.ts',
    );
    expect(missing.exec.calls).toHaveLength(0);
  });

  it('secret shapes in the diff are masked before the text reaches the agent', async () => {
    const { exec, svc, wt } = await rig();
    writeFileSync(
      join(wt, 'config.ts'),
      "export const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';\n",
    );
    exec.on(['-p'], claudeReply('Add config'));
    await svc.generateMessage(fixCheckout, 'commit');
    expect(exec.calls[0]?.opts.input).toContain('[redacted]');
    expect(exec.calls[0]?.opts.input).not.toContain('ghp_ABCDEFGHIJ');
  });

  it('a clean tree describes the branch against its base for a PR, and a committed change is still a PR diff', async () => {
    const { exec, svc, wt } = await rig();
    await sh(['add', '.'], wt);
    await sh(['commit', '-q', '-m', 'wip'], wt);
    exec.on(['-p'], claudeReply('Add validation'));
    const m = await svc.generateMessage(fixCheckout, 'pr');
    expect(m.title).toBe('Add validation');
    expect(exec.calls[0]?.opts.input).toContain('validate.ts +1 -0');
  });

  it('a clean branch with nothing against its base drafts from the branch name and asks no agent', async () => {
    const { exec, svc } = await rig({ dirty: false });
    expect(await svc.generateMessage(fixCheckout, 'pr')).toEqual({ title: 'fix/checkout', body: '' });
    expect(await svc.generateMessage(fixCheckout, 'commit')).toEqual({ title: 'Update', body: '' });
    expect(exec.calls).toHaveLength(0);
  });
});

describe('PublishService.publish', () => {
  it('commit: stages everything (untracked included), commits with title + body as the user, updates the row and the feed', async () => {
    const { t, svc, wt } = await rig();
    // The user's own identity (the repo's config here), not Styx's: a publish is the user's commit.
    await sh(['config', 'user.name', 'Nic Test'], wt);
    await sh(['config', 'user.email', 'nic@example.com'], wt);
    const r = await svc.publish(fixCheckout, {
      through: 'commit',
      message: { title: 'Validate the cart', body: 'Adds validate.ts.' },
      draft: false,
    });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.pushed).toBe(false);
    expect(r.pr).toBeNull();
    expect(await sh(['status', '--porcelain'], wt)).toBe('');
    expect(await sh(['log', '-1', '--format=%B'], wt)).toBe('Validate the cart\n\nAdds validate.ts.');
    expect(await sh(['log', '-1', '--format=%an <%ae>'], wt)).toBe('Nic Test <nic@example.com>');
    expect(await sh(['show', '--stat', '--format=', 'HEAD'], wt)).toContain('validate.ts');
    expect(t.app.repos.worktrees.get(fixCheckout)?.headCommit).toBe(r.commit);
    expect(activityRows(t)[0]).toBe(`acme-shop · published fix/checkout (commit ${r.commit?.slice(0, 7)})`);

    // A clean tree is a step already done: no commit, no feed row.
    const again = await svc.publish(fixCheckout, {
      through: 'commit',
      message: { title: 'x', body: '' },
      draft: false,
    });
    expect(again.commit).toBeNull();
    expect(activityRows(t)).toHaveLength(1);
  });

  it('push without a remote is refused before anything is committed', async () => {
    const { svc, wt } = await rig({ remote: false });
    await expect(
      svc.publish(fixCheckout, { through: 'push', message: { title: 'x', body: '' }, draft: false }),
    ).rejects.toMatchObject({ code: 'invalid-input', message: copy.publish.noRemote });
    expect(await sh(['status', '--porcelain'], wt)).not.toBe('');
  });

  it('push: takes a write grant on the GitHub target, pushes -u origin, records the use; a second push is a no-op', async () => {
    const { t, svc, bare } = await rig();
    const r = await svc.publish(fixCheckout, {
      through: 'push',
      message: { title: 'Validate', body: '' },
      draft: false,
    });
    expect(r.commit).not.toBeNull();
    expect(r.pushed).toBe(true);
    expect(await sh(['rev-parse', 'refs/heads/fix/checkout'], bare)).toBe(r.commit);
    const grants = publishGrants(t);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      state: 'active',
      scope: ['write'],
      sessionId: null,
      worktreeId: fixCheckout,
    });
    expect(grants[0]?.reason).toBe('Publish fix/checkout from Styx: push and open a pull request');
    const uses = t.app.repos.grantUses.byGrant(grants[0]?.id ?? '');
    expect(uses.map((u) => [u.command, u.scopeUsed, u.via, u.exitCode])).toEqual([
      ['git push -u origin fix/checkout', 'write', 'app', 0],
    ]);
    expect(activityRows(t)[0]).toMatch(/^acme-shop · published fix\/checkout \(commit [0-9a-f]{7} · push\)$/);

    const again = await svc.publish(fixCheckout, {
      through: 'push',
      message: { title: 'x', body: '' },
      draft: false,
    });
    expect(again).toEqual({ commit: null, pushed: true, pr: null });
    expect(t.app.repos.grantUses.byGrant(grants[0]?.id ?? '')).toHaveLength(1);
    expect(activityRows(t)).toHaveLength(1);
  });

  it('pr: looks for an open PR first, then creates one under the grant with the token in env (never argv)', async () => {
    const { t, exec, svc } = await rig();
    exec.on(['pr', 'view'], NO_PR).on(['pr', 'create'], CREATED);
    const r = await svc.publish(fixCheckout, {
      through: 'pr',
      message: { title: 'Add cart validation', body: '## Summary\n- validate.ts' },
      draft: true,
    });
    expect(r.commit).not.toBeNull();
    expect(r.pushed).toBe(true);
    expect(r.pr).toEqual({ number: 7, url: 'https://github.com/acme/shop/pull/7' });

    const view = exec.of('pr', 'view')[0];
    expect(view?.args).toEqual(['pr', 'view', 'fix/checkout', '--json', 'number,url,state,isDraft']);
    const create = exec.of('pr', 'create')[0];
    expect(create?.args).toEqual([
      'pr',
      'create',
      '--head',
      'fix/checkout',
      '--base',
      'main',
      '--title',
      'Add cart validation',
      '--body',
      '## Summary\n- validate.ts',
      '--draft',
    ]);
    for (const c of [view, create]) {
      expect(c?.file).toMatch(/\/bin\/gh$/);
      expect(c?.opts.env).toMatchObject({ GH_TOKEN: 'ghp_grant', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
      expect(c?.args.join(' ')).not.toContain('ghp_grant');
    }

    // The lane now carries the PR, the audit has an opened-pr row, the feed names every step.
    expect(t.app.repos.worktrees.get(fixCheckout)?.pr).toEqual({
      number: 7,
      state: 'draft',
      url: 'https://github.com/acme/shop/pull/7',
    });
    const opened = openedPrRows(t)[0];
    expect(opened).toMatchObject({
      actorKind: 'you',
      worktreeLabel: 'fix/checkout',
      targetLabel: 'GitHub acme/shop scm',
      triggeredBy: 'worktree.publish',
      detail: { prNumber: 7, url: 'https://github.com/acme/shop/pull/7', draft: true, via: 'grant' },
    });
    const grant = publishGrants(t)[0];
    expect(t.app.repos.grantUses.byGrant(grant?.id ?? '').map((u) => [u.command, u.scopeUsed])).toEqual([
      ['git push -u origin fix/checkout', 'write'],
      ['gh pr view fix/checkout --json number,url,state,isDraft', 'read'],
      // The PR body is collateral of `redactArgv` (`--body` values never persist).
      [
        'gh pr create --head fix/checkout --base main --title Add cart validation --body [redacted] --draft',
        'write',
      ],
    ]);
    expect(activityRows(t)[0]).toMatch(
      /^acme-shop · published fix\/checkout \(commit [0-9a-f]{7} · push · PR #7\)$/,
    );
  });

  it('an open PR for the branch is returned, not duplicated', async () => {
    const { t, exec, svc } = await rig();
    exec.on(['pr', 'view'], {
      stdout: JSON.stringify({
        number: 214,
        url: 'https://github.com/acme/shop/pull/214',
        state: 'OPEN',
        isDraft: true,
      }),
    });
    const r = await svc.publish(fixCheckout, {
      through: 'pr',
      message: { title: 'x', body: '' },
      draft: false,
    });
    expect(r.pr).toEqual({ number: 214, url: 'https://github.com/acme/shop/pull/214' });
    expect(exec.of('pr', 'create')).toHaveLength(0);
    expect(t.app.repos.worktrees.get(fixCheckout)?.pr).toEqual({
      number: 214,
      state: 'draft',
      url: 'https://github.com/acme/shop/pull/214',
    });
    expect(openedPrRows(t)).toHaveLength(0);
  });

  it('secret files stay out of the commit even when the repo forgot to ignore them', async () => {
    const { svc, wt } = await rig();
    writeFileSync(join(wt, '.env'), 'API_KEY=hunter2\n');
    writeFileSync(join(wt, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\n');
    const r = await svc.publish(fixCheckout, {
      through: 'commit',
      message: { title: 'Validate the cart', body: '' },
      draft: false,
    });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    const committed = await sh(['show', '--name-only', '--format=', 'HEAD'], wt);
    expect(committed).toContain('validate.ts');
    expect(committed).not.toMatch(/\.env|deploy\.pem/);
    // Left behind, untouched, for the user to decide about.
    expect(await sh(['status', '--porcelain'], wt)).toMatch(/\?\? \.env/);
  });

  it('a grant minted for the step is revoked when the step ends; a persistent one is left alone', async () => {
    const { t, svc } = await rig();
    // The rig's GitHub target policy is `always`: the minted grant is the user's standing decision and stays.
    await svc.publish(fixCheckout, { through: 'push', message: { title: 'x', body: '' }, draft: false });
    const always = t.app.repos.grants.all().filter((g) => g.sessionId === null && g.duration === 'always');
    expect(always.length).toBeGreaterThan(0);
    expect(always.every((g) => g.state === 'active')).toBe(true);

    // With the target on `ask` and an app policy that auto-approves GitHub write for an hour, the step mints a
    // bounded grant — the kind every agent in the project could otherwise ride on for that hour.
    for (const g of always)
      t.app.repos.grants.upsert({ ...g, state: 'revoked', revokedAt: t.clock.now(), revokeReason: 'user' });
    const gh = t.app.repos.targets.get(ids.target.github)!;
    t.app.repos.targets.upsert({ ...gh, policy: 'ask' });
    t.app.repos.policies.upsert({
      id: 'policy:gh-write' as never,
      // Ord is unique and 1-based: take the slot after the demo rows; the demo auto rule is disabled anyway.
      ord: t.app.repos.policies.all().length + 1,
      rule: { kind: 'auto-approve', match: { targetIds: [gh.id] }, scopes: ['write'], duration: '1h' },
      ruleText: 'GitHub write for an hour',
      enabled: true,
      builtinKey: null,
      matchCountToday: 0,
      matchCountWeek: 0,
      countersResetAt: null,
      createdAt: t.clock.now(),
    });
    writeFileSync(join(t.app.repos.worktrees.get(fixCheckout)!.path, 'more.ts'), 'export const m = 1;\n');
    await svc.publish(fixCheckout, { through: 'push', message: { title: 'more', body: '' }, draft: false });
    const minted = t.app.repos.grants.all().filter((g) => g.sessionId === null && g.duration === '1h');
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ state: 'revoked', revokeReason: 'policy' });
  });

  it('a merged or closed PR does not count as existing: a new one is opened', async () => {
    const { exec, svc } = await rig();
    exec
      .on(['pr', 'view'], {
        stdout: JSON.stringify({ number: 3, url: 'u', state: 'MERGED', isDraft: false }),
      })
      .on(['pr', 'create'], CREATED);
    const r = await svc.publish(fixCheckout, {
      through: 'pr',
      message: { title: 'x', body: '' },
      draft: false,
    });
    expect(r.pr?.number).toBe(7);
    expect(exec.of('pr', 'create')).toHaveLength(1);
  });

  it('gh failing surfaces its stderr as the PR step error; commit and push stay done', async () => {
    const { t, exec, svc } = await rig();
    exec
      .on(['pr', 'view'], NO_PR)
      .on(['pr', 'create'], { exitCode: 1, stderr: 'GraphQL: A pull request already exists' });
    await expect(
      svc.publish(fixCheckout, { through: 'pr', message: { title: 'x', body: '' }, draft: false }),
    ).rejects.toMatchObject({
      code: 'provider-error',
      message: 'Commit, push & open PR failed: GraphQL: A pull request already exists',
    });
    expect(t.app.repos.worktrees.get(fixCheckout)?.pr).toBeNull();
    // The push happened before gh was tried, and the feed still records what was done? No: the failing call
    // records nothing, so a retry (a clean tree, an up-to-date branch) reports only the PR step.
    expect(activityRows(t)).toHaveLength(0);
    exec.on(['pr', 'create'], CREATED);
    const retry = await svc.publish(fixCheckout, {
      through: 'pr',
      message: { title: 'x', body: '' },
      draft: false,
    });
    expect(retry).toMatchObject({ commit: null, pushed: true, pr: { number: 7 } });
    expect(activityRows(t)[0]).toBe('acme-shop · published fix/checkout (PR #7)');
  });

  it('gh missing from PATH is a cli-missing error', async () => {
    const r = await rig();
    const svc = new PublishService({
      repos: r.t.app.repos,
      publisher: r.t.app.publisher,
      clock: r.t.clock,
      git: r.t.app.git,
      grants: r.t.app.grants,
      activity: r.t.app.activity,
      audit: r.t.app.audit,
      exec: r.exec.fn,
      projectSettings: () => r.settings,
      loginPath: async () => '',
      env: { PATH: '/nonexistent' },
      platform: 'darwin',
    });
    await expect(
      svc.publish(fixCheckout, { through: 'pr', message: { title: 'x', body: '' }, draft: false }),
    ).rejects.toMatchObject({ code: 'cli-missing', message: 'gh not found on PATH' });
  });

  it("no GitHub target connected: gh runs with the user's own login, no grant, and the feed says so", async () => {
    const { t, exec, svc } = await rig();
    for (const target of t.app.repos.targets.all().filter((x) => x.provider === 'github'))
      t.app.repos.targets.upsert({ ...target, credentialRef: null });
    exec.on(['pr', 'view'], NO_PR).on(['pr', 'create'], CREATED);
    const r = await svc.publish(fixCheckout, {
      through: 'pr',
      message: { title: 'x', body: '' },
      draft: false,
    });
    expect(r.pr?.number).toBe(7);
    expect(publishGrants(t)).toHaveLength(0);
    for (const c of exec.of('pr')) expect(c.opts.env?.['GH_TOKEN']).toBeUndefined();
    expect(activityRows(t)[0]).toMatch(/· PR #7 · your own gh login\)$/);
    const opened = openedPrRows(t)[0];
    expect(opened?.detail).toMatchObject({ via: 'own-gh-login' });
    expect(opened?.targetId).toBeNull();
  });

  it('a GitHub target whose policy asks cannot be answered from the button: forbidden, needs approval', async () => {
    const { t, svc } = await rig();
    const target = t.app.repos.targets.get(ids.target.github);
    if (!target) throw new Error('fixture target');
    t.app.repos.targets.upsert({ ...target, policy: 'ask' });
    await expect(
      svc.publish(fixCheckout, { through: 'push', message: { title: 'x', body: '' }, draft: false }),
    ).rejects.toMatchObject({ code: 'forbidden', message: copy.publish.needsApproval });
  });

  it('the main worktree can commit and push but never opens a PR against itself', async () => {
    const { svc } = await rig();
    await expect(
      svc.publish(acmeMain, { through: 'pr', message: { title: 'x', body: '' }, draft: false }),
    ).rejects.toMatchObject({ code: 'invalid-input', message: copy.publish.mainNoPr });
  });

  it('runs through the command bus with the contract shapes', async () => {
    const { t, exec, svc } = await rig();
    t.app.publish = svc;
    exec.on(['-p'], claudeReply('Validate the cart')).on(['pr', 'view'], NO_PR).on(['pr', 'create'], CREATED);
    const draft = await t.app.bus.dispatch(t.sender, 'worktree.generateMessage', {
      worktreeId: fixCheckout,
      kind: 'commit',
    });
    expect(draft).toEqual({ ok: true, value: { title: 'Validate the cart', body: '' } });
    const r = await t.app.bus.dispatch(t.sender, 'worktree.publish', {
      worktreeId: fixCheckout,
      through: 'pr',
      message: { title: 'Validate the cart', body: '' },
    });
    expect(r).toMatchObject({ ok: true, value: { pushed: true, pr: { number: 7 } } });
    t.app.publisher.flush();
    const upserts = t.win
      .batches()
      .flatMap((b) => b.deltas)
      .filter((d) => d.op === 'upsert' && (d as { table?: string }).table === 'worktrees');
    expect(upserts.length).toBeGreaterThan(0);
  });
});

describe('publish helpers', () => {
  it('parseDraft: first line is the title (prefixes, quotes and fences dropped, cut at 72), the rest the body', () => {
    expect(parseDraft('Subject: "Fix it"\n\nBecause.\n')).toEqual({ title: 'Fix it', body: 'Because.' });
    expect(parseDraft('```\n# Add thing\n\n- a\n- b\n```')).toEqual({ title: 'Add thing', body: '- a\n- b' });
    expect(parseDraft('\n\nOnly a title')).toEqual({ title: 'Only a title', body: '' });
    expect(parseDraft('   \n')).toBeNull();
    const long = parseDraft(`${'x'.repeat(100)}\n\nbody`);
    expect(long?.title.length).toBe(72);
    expect(long?.title.endsWith('…')).toBe(true);
  });

  it('fallbackDraft: one path, up to three names, then a count with the common directory', () => {
    const f = (paths: string[]) =>
      fallbackDraft(
        paths.map((p) => ({ path: p, added: 1, removed: 0 })),
        'commit',
        'b',
      );
    expect(f(['src/a.ts']).title).toBe('Update src/a.ts');
    expect(f(['src/a.ts', 'src/b.ts', 'c.ts']).title).toBe('Update a.ts, b.ts and c.ts');
    expect(f(['src/x/a.ts', 'src/x/b.ts', 'src/x/c.ts', 'src/y/d.ts']).title).toBe('Update 4 files in src');
    expect(f(['a', 'b', 'c', 'd']).title).toBe('Update 4 files');
    expect(fallbackDraft([{ path: 'a', added: 1, removed: 2 }], 'pr', 'b').body).toBe(
      '## Summary\n\n- a (+1 −2)',
    );
  });

  it('draftInput caps the patch at the limit and says so', () => {
    const stats = [{ path: 'a', added: 1, removed: 0 }];
    const s = draftInput('b', 'main', stats, 'x'.repeat(DRAFT_DIFF_LIMIT * 2));
    expect(s.length).toBeLessThan(DRAFT_DIFF_LIMIT + 100);
    expect(s).toContain('patch truncated');
    expect(draftInput('b', 'main', stats, 'short')).toBe(
      'Branch: b (base: main)\n\nFiles:\na +1 -0\n\nPatch:\nshort',
    );
  });

  it('statsOf / parsePrUrl / commitText / agentInvocation', () => {
    expect(statsOf('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n')).toEqual([
      { path: 'x', added: 2, removed: 1 },
    ]);
    expect(parsePrUrl('Creating pull request…\nhttps://github.com/acme/shop/pull/42\n')).toEqual({
      number: 42,
      url: 'https://github.com/acme/shop/pull/42',
    });
    expect(parsePrUrl('nothing')).toBeNull();
    expect(commitText({ title: ' T ', body: '' })).toBe('T');
    expect(commitText({ title: 'T', body: ' b\n' })).toBe('T\n\nb');
    expect(agentInvocation('gemini', '/g', 'commit')?.args.slice(0, 1)).toEqual(['-p']);
    expect(agentInvocation('shell', '/bin/zsh', 'commit')).toBeNull();
  });
});
