import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures, parseUnifiedDiff } from '@styx/core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { seedDemoRepos } from './seed-repos';

const { ids } = fixtures;
const sender = { senderId: 1, frameUrl: 'file:///index.html' };

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.shutdown();
  t = null;
});

describe('seedDemoRepos', () => {
  it('materialises the fixture repos, re-points project/worktree rows, and worktree.diff on fix/checkout has checkout.ts hunks', async () => {
    t = makeTestApp();
    const { app, userData } = t;
    const t0 = Date.now();
    const r = await seedDemoRepos({ repos: app.repos, userData, fixture: 'demo' });
    const elapsed = Date.now() - t0;
    expect(r.created).toHaveLength(5);
    // Git starts several times slower on Windows (process creation, Defender): the same budget, scaled.
    expect(elapsed).toBeLessThan(process.platform === 'win32' ? 12_000 : 4000);

    const acme = app.repos.projects.get(ids.project.acmeShop)!;
    expect(acme.path).toBe(join(userData, 'demo-repos', 'acme-shop'));
    expect(existsSync(join(acme.path, '.git'))).toBe(true);
    expect(existsSync(join(acme.path, 'checkout.ts'))).toBe(true);
    expect(existsSync(join(acme.path, '.styx', 'project.json'))).toBe(true);
    expect(app.repos.projects.settings(acme.id)).toEqual(t.app.repos.projects.settings(acme.id)); // settings preserved
    for (const p of app.repos.projects.all())
      expect(p.path.startsWith(join(userData, 'demo-repos'))).toBe(true);

    const main = app.repos.worktrees.get(ids.worktree.acmeMain)!;
    expect(main.path).toBe(acme.path);
    expect(main.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const fix = app.repos.worktrees.get(ids.worktree.fixCheckout)!;
    expect(fix.path).toBe(join(userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'fix-checkout'));
    expect(existsSync(join(fix.path, 'validate.ts'))).toBe(true);
    expect(fix.baseCommit).toBe(main.headCommit);
    expect(fix.headCommit).toBe(main.headCommit);

    const diffResult = await app.bus.dispatch(sender, 'worktree.diff', { worktreeId: fix.id });
    if (!diffResult.ok) throw new Error(diffResult.error.message);
    const { diff } = diffResult.value as { diff: string };
    const parsed = parseUnifiedDiff(diff);
    const checkout = parsed.files.find((f) => f.path === 'checkout.ts');
    expect(checkout).toBeDefined();
    expect(checkout!.hunks.length).toBeGreaterThan(0);
    expect(diff).toContain("+import { validate } from './validate'");
    expect(diff).toContain('+  audit(receipt)');

    // git sees the three changed files of the prototype (2 untracked + 1 modified)
    const status = await app.git.status(fix.path);
    expect(status.changed.map((c) => `${c.kind}:${c.path}`).sort()).toEqual([
      'modified:checkout.ts',
      'untracked:checkout.test.ts',
      'untracked:validate.ts',
    ]);

    // feat/promo is merged into main; test/flaky has one modified file
    const branches = await app.git.branches(acme.path);
    expect(branches.sort()).toEqual(['feat/promo', 'fix/checkout', 'main', 'test/flaky']);
    expect(existsSync(join(acme.path, 'promo.ts'))).toBe(true);
    const flaky = app.repos.worktrees.get(ids.worktree.testFlaky)!;
    expect((await app.git.status(flaky.path)).changed).toEqual([
      { path: 'orders.test.ts', kind: 'modified' },
    ]);
    expect(await app.git.detectConflict(acme.path, 'fix/checkout', 'main')).toBeNull();

    // fs.* works on the demo now
    const file = await app.bus.dispatch(sender, 'fs.readFile', { worktreeId: fix.id, path: 'checkout.ts' });
    expect(file).toMatchObject({ ok: true, value: { text: expect.stringContaining('validate(cart)') } });

    // idempotent: a second run reuses the repos and keeps the SHAs
    const again = await seedDemoRepos({ repos: app.repos, userData, fixture: 'demo' });
    expect(again.created).toEqual([]);
    expect(app.repos.worktrees.get(ids.worktree.fixCheckout)?.baseCommit).toBe(fix.baseCommit);
    expect(readFileSync(join(fix.path, 'checkout.ts'), 'utf8')).toContain('audit(receipt)');
  });

  it('git diff of the seeded fix/checkout parses to hunks carrying every added line of the fixture hunks', async () => {
    t = makeTestApp();
    const { app, userData } = t;
    await seedDemoRepos({ repos: app.repos, userData, fixture: 'demo' });
    const fix = app.repos.worktrees.get(ids.worktree.fixCheckout)!;
    const parsed = parseUnifiedDiff(await app.git.diffWithUntracked(fix.path, fix.baseCommit ?? 'HEAD'));
    expect(parsed.files.map((f) => f.path).sort()).toEqual([
      'checkout.test.ts',
      'checkout.ts',
      'validate.ts',
    ]);
    // Prototype rows quote with " where the repo lane diff uses '; compare modulo quote style.
    const norm = (s: string) => s.replace(/"/g, "'");
    const realAdds = new Map<string, string[]>();
    for (const f of parsed.files)
      realAdds.set(
        f.path,
        f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => norm(l.text))),
      );
    for (const hunk of fixtures.demoFixture().hunks[ids.session.claude] ?? []) {
      const adds = parseUnifiedDiff(hunk.patch).files.flatMap((f) =>
        f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => norm(l.text))),
      );
      expect(adds.length).toBeGreaterThan(0);
      for (const line of adds) expect(realAdds.get(hunk.file) ?? []).toContain(line);
    }
    // The checkout.ts hunk is the lane diff's body (`+2 −0` header in the prototype; the app derives the real totals).
    const checkout = parsed.files.find((f) => f.path === 'checkout.ts')!;
    expect(checkout.removed).toBe(0);
    expect(
      checkout.hunks.map((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.text)).flat(),
    ).toEqual(["import { validate } from './validate'", '  validate(cart)', '  audit(receipt)']);
    expect(
      checkout.hunks.every((h) => h.hunkHash === parseUnifiedDiff(h.patch).files[0]?.hunks[0]?.hunkHash),
    ).toBe(true);
  });

  it('error fixture: fix/checkout conflicts with main in checkout.ts', async () => {
    t = makeTestApp({ fixture: 'error' });
    const { app, userData } = t;
    await seedDemoRepos({ repos: app.repos, userData, fixture: 'error' });
    const acme = app.repos.projects.get(ids.project.acmeShop)!;
    const fix = app.repos.worktrees.get(ids.worktree.fixCheckout)!;
    expect(fix.conflict).toEqual({ file: 'checkout.ts', against: 'main' });
    expect(fix.headCommit).not.toBe(fix.baseCommit);
    expect(await app.git.detectConflict(acme.path, 'fix/checkout', 'main')).toEqual({
      file: 'checkout.ts',
      against: 'main',
    });
  });
});
