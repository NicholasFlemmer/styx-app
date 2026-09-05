import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_NAMES, commandResultSchema, commands, fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test-support';

describe('command contract', () => {
  it('registers a handler for every command in the contract', () => {
    const { app } = makeTestApp({ fixture: null });
    const missing = COMMAND_NAMES.filter((n) => !app.bus.has(n));
    expect(missing).toEqual([]);
    expect(app.bus.registered().length).toBe(COMMAND_NAMES.length);
  });

  it('store.snapshot returns a contract-valid snapshot through the bus', async () => {
    const { app, sender } = makeTestApp();
    const r = await app.bus.dispatch(sender, 'store.snapshot', {});
    expect(commandResultSchema('store.snapshot').safeParse(r).success).toBe(true);
    if (!r.ok) throw new Error('snapshot failed');
    expect(commands['store.snapshot'].output.safeParse(r.value).success).toBe(true);
    expect(r.value.sessions.length).toBe(fixtures.demoFixture().sessions.length);
  });

  it('settings.set persists, publishes a settings delta and reads back', async () => {
    const { app, sender, win } = makeTestApp();
    expect(await app.bus.dispatch(sender, 'settings.set', { patch: { theme: 'light', dnd: true } })).toEqual({
      ok: true,
      value: {},
    });
    const get = await app.bus.dispatch(sender, 'settings.get', {});
    expect(get).toMatchObject({
      ok: true,
      value: { app: { theme: 'light', dnd: true, onboardingDone: true } },
    });
    app.publisher.flush();
    expect(
      win
        .batches()
        .at(-1)
        ?.deltas.some((d) => d.op === 'settings.set'),
    ).toBe(true);
  });

  it('ui.persist and onboarding.complete write ui_state / app_settings', async () => {
    const { app, sender } = makeTestApp({ fixture: 'empty' });
    await app.bus.dispatch(sender, 'ui.persist', {
      screen: 'home',
      projectId: null,
      paneSizes: { chat: 360 },
    });
    expect(app.repos.uiState.get('screen')).toBe('home');
    expect(app.repos.uiState.get('paneSizes')).toEqual({ chat: 360 });
    await app.bus.dispatch(sender, 'onboarding.complete', {});
    expect(app.repos.settings.app().onboardingDone).toBe(true);
  });

  it('policy.upsert / toggle / reorder / remove audit and publish', async () => {
    const { app, sender } = makeTestApp();
    const r = await app.bus.dispatch(sender, 'policy.upsert', {
      policyId: null,
      rule: { kind: 'auto-approve', match: { provider: ['github'] }, scopes: ['read'], duration: 'session' },
      ruleText: 'Auto-approve GitHub reads',
    });
    if (!r.ok) throw new Error(r.error.message);
    const id = r.value.policyId;
    if (!id) throw new Error('no policy id');
    expect(app.repos.policies.get(id)?.ord).toBe(4);
    await app.bus.dispatch(sender, 'policy.reorder', { policyIds: [id] });
    expect(app.repos.policies.get(id)?.ord).toBe(1);
    await app.bus.dispatch(sender, 'policy.toggle', { policyId: id, enabled: false });
    expect(app.repos.policies.get(id)?.enabled).toBe(false);
    expect(
      await app.bus.dispatch(sender, 'policy.remove', { policyId: fixtures.ids.policy['idle-expiry-1h'] }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await app.bus.dispatch(sender, 'policy.remove', { policyId: id })).toEqual({
      ok: true,
      value: {},
    });
    expect(app.repos.audit.all().filter((e) => e.action === 'policy-changed').length).toBe(4);
  });

  it('audit.list pages by seq and audit.verifyChain reports the fixture chain', async () => {
    const { app, sender } = makeTestApp();
    const n = fixtures.demoFixture().auditEntries.length;
    const page = await app.bus.dispatch(sender, 'audit.list', { limit: 2 });
    expect(page).toMatchObject({ ok: true, value: { entries: [{ seq: n }, { seq: n - 1 }], nextCursor: n - 1 } });
    const next = await app.bus.dispatch(sender, 'audit.list', { cursor: n - 1, limit: 10 });
    expect(next).toMatchObject({
      ok: true,
      value: { entries: Array.from({ length: n - 2 }, (_, i) => ({ seq: n - 2 - i })), nextCursor: null },
    });
    // Seeding re-chains fixture rows, so the demo chain verifies.
    expect(await app.bus.dispatch(sender, 'audit.verifyChain', {})).toMatchObject({
      ok: true,
      value: { ok: true },
    });
  });

  it('window.popout / dock publish popouts.set', async () => {
    const { app, sender, win, popouts } = makeTestApp();
    await app.bus.dispatch(sender, 'window.popout', { sessionId: fixtures.ids.session.claude });
    expect(popouts).toEqual([fixtures.ids.session.claude]);
    app.publisher.flush();
    expect(win.batches().at(-1)?.deltas).toEqual([
      { op: 'popouts.set', sessionIds: [fixtures.ids.session.claude] },
    ]);
    await app.bus.dispatch(sender, 'window.dock', { sessionId: fixtures.ids.session.claude });
    expect(popouts).toEqual([]);
  });

  describe('fs.* confinement', () => {
    const setup = () => {
      const t = makeTestApp();
      const root = mkdtempSync(join(tmpdir(), 'styx-wt-'));
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\r\n');
      writeFileSync(join(tmpdir(), 'styx-outside.txt'), 'secret');
      const wt = t.app.repos.worktrees.get(fixtures.ids.worktree.fixCheckout);
      if (!wt) throw new Error('fixture worktree missing');
      t.app.repos.worktrees.upsert({ ...wt, path: root });
      return { ...t, root, worktreeId: wt.id };
    };

    it('reads and writes inside the worktree and detects eol', async () => {
      const { app, sender, worktreeId } = setup();
      const read = await app.bus.dispatch(sender, 'fs.readFile', { worktreeId, path: 'src/a.ts' });
      expect(read).toEqual({ ok: true, value: { text: 'export const a = 1;\r\n', eol: 'crlf' } });
      expect(
        await app.bus.dispatch(sender, 'fs.writeFile', { worktreeId, path: 'src/b.ts', text: 'x\n' }),
      ).toEqual({ ok: true, value: {} });
      const list = await app.bus.dispatch(sender, 'fs.listDir', { worktreeId, path: 'src' });
      expect(list).toMatchObject({
        ok: true,
        value: {
          entries: [
            { name: 'a.ts', kind: 'file' },
            { name: 'b.ts', kind: 'file' },
          ],
        },
      });
    });

    it('rejects paths that resolve outside the worktree', async () => {
      const { app, sender, worktreeId } = setup();
      for (const path of ['../styx-outside.txt', 'src/../../styx-outside.txt', '/etc/passwd', '..']) {
        const r = await app.bus.dispatch(sender, 'fs.readFile', { worktreeId, path });
        expect(r, path).toMatchObject({ ok: false, error: { code: 'fs-denied' } });
      }
      expect(
        await app.bus.dispatch(sender, 'fs.writeFile', { worktreeId, path: '../x', text: '' }),
      ).toMatchObject({ ok: false, error: { code: 'fs-denied' } });
      expect(await app.bus.dispatch(sender, 'fs.listDir', { worktreeId, path: '../' })).toMatchObject({
        ok: false,
        error: { code: 'fs-denied' },
      });
    });
  });
});
