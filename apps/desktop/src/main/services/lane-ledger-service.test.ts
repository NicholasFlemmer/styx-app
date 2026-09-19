import { execa } from 'execa';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
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

/**
 * A real repo with one commit and two of the fixture's lanes cut from main: `fix/checkout` (Claude, "Fix the
 * checkout total") and `test/flaky` (Codex, "Make the flaky test pass"), both idle.
 */
async function rig(): Promise<{ t: TestApp; repo: string; wt1: string; wt2: string }> {
  const t = makeTestApp();
  const root = mkdtempSync(join(tmpdir(), 'styx-ledger-'));
  const repo = join(root, 'acme-shop');
  mkdirSync(repo);
  await t.app.git.init(repo);
  writeFileSync(join(repo, 'a.ts'), 'a\n');
  writeFileSync(join(repo, 'package.json'), '{}\n');
  await sh(['add', '.'], repo);
  await sh(['commit', '-q', '-m', 'init'], repo);
  const head = await t.app.git.headCommit(repo);
  mkdirSync(join(root, 'wt'));
  const wt1 = join(root, 'wt', 'fix-checkout');
  const wt2 = join(root, 'wt', 'test-flaky');
  await t.app.git.worktreeAdd(repo, { branch: 'fix/checkout', base: 'main', path: wt1 });
  await t.app.git.worktreeAdd(repo, { branch: 'test/flaky', base: 'main', path: wt2 });
  const project = t.app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  t.app.repos.projects.upsert({ ...project, path: repo }, t.app.repos.projects.settings(project.id));
  const rows = t.app.repos.worktrees;
  const main = rows.get(ids.worktree.acmeMain);
  const lane1 = rows.get(ids.worktree.fixCheckout);
  const lane2 = rows.get(ids.worktree.testFlaky);
  if (!main || !lane1 || !lane2) throw new Error('fixture worktrees');
  rows.upsert({ ...main, path: repo, baseCommit: head, headCommit: head });
  rows.upsert({
    ...lane1,
    path: wt1,
    baseCommit: head,
    headCommit: head,
    pr: null,
    conflict: null,
    overlaps: [],
  });
  rows.upsert({
    ...lane2,
    path: wt2,
    baseCommit: head,
    headCommit: head,
    pr: null,
    conflict: null,
    overlaps: [],
  });
  for (const [id, firstMessage] of [
    [claude, 'Fix the checkout total'],
    [codex, 'Make the flaky test pass'],
  ] as const) {
    const s = t.app.repos.sessions.get(id);
    if (!s) throw new Error('fixture session');
    t.app.repos.sessions.upsert({ ...s, state: 'idle', pausedReason: null, firstMessage });
  }
  // Every other fixture session in the project is out of the way, so only these two lanes are live.
  for (const s of t.app.repos.sessions.byProject(acme)) {
    if (s.id === claude || s.id === codex || s.state === 'done') continue;
    t.app.repos.sessions.upsert({ ...s, state: 'done', pausedReason: null, endedAt: fixtures.DEMO_NOW });
  }
  return { t, repo, wt1, wt2 };
}

const systemLines = (t: TestApp, sessionId: string): string[] =>
  t.app.repos.transcripts
    .last(sessionId)
    .filter((m) => m.payload.kind === 'system')
    .map((m) => m.body);

describe('LaneLedgerService (ADR-0025)', () => {
  it('filesOf = committed against the base plus uncommitted; overlaps land on both lanes and each agent is told once', async () => {
    const { t, wt1, wt2 } = await rig();
    const ledger = t.app.ledger;
    writeFileSync(join(wt1, 'b.ts'), 'b\n');
    await sh(['add', '.'], wt1);
    await sh(['commit', '-q', '-m', 'add b'], wt1);
    writeFileSync(join(wt1, 'a.ts'), 'a1\n'); // uncommitted
    writeFileSync(join(wt2, 'a.ts'), 'a2\n'); // the same file, the other lane
    expect(await ledger.filesOf(t.app.repos.worktrees.get(ids.worktree.fixCheckout)!)).toEqual([
      'a.ts',
      'b.ts',
    ]);

    const before1 = systemLines(t, claude).length;
    const before2 = systemLines(t, codex).length;
    await ledger.refreshProject(acme);
    expect(t.app.repos.worktrees.get(ids.worktree.fixCheckout)?.overlaps).toEqual([
      { worktreeId: ids.worktree.testFlaky, files: ['a.ts'] },
    ]);
    expect(t.app.repos.worktrees.get(ids.worktree.testFlaky)?.overlaps).toEqual([
      { worktreeId: ids.worktree.fixCheckout, files: ['a.ts'] },
    ]);
    const toClaude = systemLines(t, claude).slice(before1);
    const toCodex = systemLines(t, codex).slice(before2);
    expect(toClaude).toEqual([
      'Codex on test/flaky also changed a.ts — their task: "Make the flaky test pass". Keep to your own files, or agree who does what with send_message.',
    ]);
    expect(toCodex).toEqual([
      'Claude on fix/checkout also changed a.ts — their task: "Fix the checkout total". Keep to your own files, or agree who does what with send_message.',
    ]);

    // The same overlap again says nothing new; a hotspot both touch gets the louder line, once.
    ledger.invalidate(ids.worktree.fixCheckout);
    ledger.invalidate(ids.worktree.testFlaky);
    await ledger.refreshProject(acme);
    expect(systemLines(t, claude).slice(before1)).toHaveLength(1);
    writeFileSync(join(wt1, 'package.json'), '{"a":1}\n');
    writeFileSync(join(wt2, 'package.json'), '{"b":1}\n');
    await ledger.laneChanged(ids.worktree.fixCheckout);
    ledger.invalidate(ids.worktree.testFlaky);
    await ledger.laneChanged(ids.worktree.testFlaky);
    const claudeLines = systemLines(t, claude).slice(before1);
    expect(claudeLines).toHaveLength(2);
    expect(claudeLines[1]).toBe(
      'Shared file: package.json should have one owner, and Codex on test/flaky changed it too (their task: "Make the flaky test pass"). Agree who owns it with send_message before going further.',
    );
    expect(t.app.repos.worktrees.get(ids.worktree.fixCheckout)?.overlaps).toEqual([
      { worktreeId: ids.worktree.testFlaky, files: ['a.ts', 'package.json'] },
    ]);
  });

  it('activity and promptBlock read as the agents see them; baseSince attributes a merged lane to its owner', async () => {
    const { t, repo, wt1, wt2 } = await rig();
    const ledger = t.app.ledger;
    writeFileSync(join(wt1, 'a.ts'), 'a1\n');
    await sh(['commit', '-qam', 'checkout: fix the total'], wt1);
    writeFileSync(join(repo, 'c.ts'), 'c\n');
    await sh(['add', '.'], repo);
    await sh(['commit', '-q', '-m', 'main: add c'], repo);
    writeFileSync(join(wt2, 'a.ts'), 'a2\n');

    const activity = await ledger.activity(codex);
    expect(activity.base).toBe('main');
    expect(activity.lanes).toEqual([
      {
        sessionId: claude,
        agent: 'claude',
        branch: 'fix/checkout',
        state: 'idle',
        task: 'Fix the checkout total',
        files: ['a.ts'],
      },
    ]);
    expect(activity.overlaps).toEqual([
      {
        file: 'a.ts',
        with: [
          { sessionId: claude, agent: 'claude', branch: 'fix/checkout', task: 'Fix the checkout total' },
        ],
      },
    ]);
    expect(activity.baseCommits.map((c) => [c.subject, c.files, c.lane])).toEqual([
      ['main: add c', ['c.ts'], null],
    ]);

    const block = await ledger.promptBlock(codex);
    expect(block).toContain('Other lanes in this project right now:');
    expect(block).toContain('- Claude on fix/checkout — "Fix the checkout total" — files: a.ts');
    expect(block).toContain('call project_activity');

    // Once main has merged the lane, the base history names it — attributed to the lane's owner — and the lane's
    // own file list is empty again: it has nothing main lacks.
    await sh(['merge', '--no-ff', '-m', "Merge branch 'fix/checkout'", 'fix/checkout'], repo);
    ledger.invalidate(ids.worktree.fixCheckout);
    const lane2 = t.app.repos.worktrees.get(ids.worktree.testFlaky);
    if (!lane2) throw new Error('lane');
    expect((await ledger.baseSince(lane2)).map((c) => [c.subject, c.files, c.lane])).toEqual([
      [
        "Merge branch 'fix/checkout'",
        [],
        { agent: 'Claude', branch: 'fix/checkout', task: 'Fix the checkout total' },
      ],
      ['main: add c', ['c.ts'], null],
      ['checkout: fix the total', ['a.ts'], null],
    ]);
    const lane1 = t.app.repos.worktrees.get(ids.worktree.fixCheckout);
    if (!lane1) throw new Error('lane');
    expect(await ledger.filesOf(lane1)).toEqual([]);

    // Alone in the project → nothing to say.
    const s = t.app.repos.sessions.get(claude);
    if (!s) throw new Error('session');
    t.app.repos.sessions.upsert({ ...s, state: 'done', endedAt: fixtures.DEMO_NOW });
    expect(await ledger.promptBlock(codex)).toBe('');
    expect(ledger.liveLanes(acme).map((l) => l.session.id)).toEqual([codex]);
  });
});
