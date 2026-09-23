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
    expect(page).toMatchObject({
      ok: true,
      value: { entries: [{ seq: n }, { seq: n - 1 }], nextCursor: n - 1 },
    });
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

  it('ide.import reads keybindings + theme from the editor config dir and stores them in app_settings', async () => {
    const { app, sender } = makeTestApp();
    const configDir = join(__dirname, '../../services/__fixtures__/vscode/User');
    app.repos.discovery.saveIde({
      id: 'ide-vscode',
      kind: 'vscode',
      recentsSource: 'state-db',
      product: 'VS Code',
      version: '1.99.0',
      location: null,
      launcher: 'code',
      configDir,
      isFallback: false,
      imported: { recents: 0, keybindings: false, theme: false },
      detectedAt: app.clock.now(),
    });
    const r = await app.bus.dispatch(sender, 'ide.import', {
      ideId: 'ide-vscode',
      keybindings: true,
      theme: true,
      recents: true,
    });
    expect(r).toEqual({ ok: true, value: { recents: [], keybindingsImported: 3, themeImported: true } });
    expect(app.repos.settings.kv.get('editor.importedKeybindings')).toEqual([
      { key: 'cmd+shift+p', command: 'workbench.action.showCommands' },
      { key: 'ctrl+k ctrl+t', command: 'workbench.action.selectTheme', when: 'editorTextFocus' },
      { key: 'alt+z', command: '-editor.action.toggleWordWrap' },
    ]);
    expect(app.repos.settings.kv.get('editor.importedTheme')).toEqual({
      colorTheme: 'GitHub Dark Default',
      fontFamily: 'JetBrains Mono, Menlo, monospace',
      from: 'vscode',
    });
    expect(app.repos.discovery.ides()[0]?.imported).toEqual({ recents: 0, keybindings: true, theme: true });
    expect(app.repos.settings.app()).not.toHaveProperty('editor.importedTheme'); // extra keys never leak into AppSettings
    expect(
      await app.bus.dispatch(sender, 'ide.import', {
        ideId: 'nope',
        keybindings: true,
        theme: true,
        recents: true,
      }),
    ).toEqual({
      ok: true,
      value: { recents: [], keybindingsImported: 0, themeImported: false },
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

  it('project.add takes a plain folder; project.gitInit upgrades it and the deltas carry the new branch', async () => {
    const { app, sender, win } = makeTestApp({ fixture: 'empty' });
    const dir = mkdtempSync(join(tmpdir(), 'styx-plain-'));
    writeFileSync(join(dir, 'notes.md'), 'hi\n');
    const added = await app.bus.dispatch(sender, 'project.add', { path: dir });
    if (!added.ok) throw new Error(added.error.message);
    const { projectId } = added.value;
    app.publisher.flush();
    const snap = await app.bus.dispatch(sender, 'store.snapshot', {});
    if (!snap.ok) throw new Error('snapshot');
    expect(snap.value.repos.find((r) => r.projectId === projectId)).toMatchObject({ defaultBranch: null });
    expect(snap.value.worktrees.filter((w) => w.projectId === projectId)).toMatchObject([
      { branch: null, isMain: true, path: dir },
    ]);
    // A spawn asking for a fresh worktree is refused on a plain folder (the modal only offers the folder itself).
    const spawn = await app.bus.dispatch(sender, 'session.spawn', {
      projectId,
      agent: 'shell',
      worktree: { kind: 'new', base: 'main', branch: 'agent/shell-1' },
      firstMessage: '',
      toggles: { autoApproveEdits: false, mayRequestTargets: true, notifyWhenNeedsMe: true },
      model: null,
    });
    expect(spawn).toMatchObject({ ok: false, error: { code: 'git-error' } });
    expect(await app.bus.dispatch(sender, 'project.gitInit', { projectId })).toEqual({ ok: true, value: {} });
    app.publisher.flush();
    const after = await app.bus.dispatch(sender, 'store.snapshot', {});
    if (!after.ok) throw new Error('snapshot');
    expect(after.value.repos.find((r) => r.projectId === projectId)).toMatchObject({ defaultBranch: 'main' });
    expect(after.value.worktrees.find((w) => w.projectId === projectId)).toMatchObject({
      branch: 'main',
      isMain: true,
    });
    expect(
      win
        .batches()
        .flatMap((b) => b.deltas)
        .some((d) => d.op === 'upsert' && (d as { table?: string }).table === 'worktrees'),
    ).toBe(true);
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

    it('reads the whole tree in one call: ordered, depth-limited, ignoring the heavy directories', async () => {
      const { app, sender, worktreeId, root } = setup();
      mkdirSync(join(root, 'node_modules', 'left'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'left', 'index.js'), '');
      mkdirSync(join(root, '.styx'), { recursive: true });
      writeFileSync(join(root, '.styx', 'project.json'), '{}');
      mkdirSync(join(root, 'deep', 'a', 'b', 'c', 'd'), { recursive: true });
      writeFileSync(join(root, 'deep', 'a', 'b', 'c', 'd', 'far.ts'), '');
      writeFileSync(join(root, 'README.md'), '# hi');

      const r = await app.bus.dispatch(sender, 'fs.readTree', { worktreeId, maxDepth: 4 });
      if (!r.ok) throw new Error('readTree failed');
      const paths = r.value.nodes.map((n) => n.path);

      // node_modules, .styx and .git are never descended into: they are why a real project felt slow.
      expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
      expect(paths.some((p) => p.startsWith('.styx'))).toBe(false);
      // Directories come before files at each level, which is the order the pane renders.
      expect(paths[0]).toBe('deep');
      expect(paths).toContain('src/a.ts');
      expect(paths).toContain('README.md');
      expect(r.value.nodes.find((n) => n.path === 'src')?.kind).toBe('dir');
      expect(r.value.nodes.find((n) => n.path === 'src/a.ts')?.depth).toBe(1);
      // maxDepth 4 means the walk stops before the fifth level.
      expect(paths).toContain('deep/a/b/c');
      expect(paths.some((p) => p.startsWith('deep/a/b/c/d'))).toBe(false);
      expect(r.value.truncated).toBe(false);
    });

    it('refuses to walk outside the worktree', async () => {
      const { app, sender } = setup();
      const r = await app.bus.dispatch(sender, 'fs.readTree', {
        worktreeId: 'wt-nope' as never,
        maxDepth: 4,
      });
      expect(r).toMatchObject({ ok: false });
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

    it('fs.find lists worktree files ranked by match quality, trims the query and reports truncation', async () => {
      const { app, sender, worktreeId, root } = setup();
      mkdirSync(join(root, 'src', 'components'));
      writeFileSync(join(root, 'src', 'components', 'a.tsx'), '');
      writeFileSync(join(root, 'src', 'components', 'a.test.tsx'), '');
      writeFileSync(join(root, 'README.md'), '');
      writeFileSync(join(root, 'src', 'ab.ts'), '');
      const all = await app.bus.dispatch(sender, 'fs.find', { worktreeId });
      if (!all.ok) throw new Error(all.error.message);
      expect([...all.value.paths].sort()).toEqual([
        'README.md',
        'src/a.ts',
        'src/ab.ts',
        'src/components/a.test.tsx',
        'src/components/a.tsx',
      ]);
      expect(all.value.truncated).toBe(false);
      expect(await app.bus.dispatch(sender, 'fs.find', { worktreeId, query: '  a.ts ' })).toEqual({
        ok: true,
        // exact basename, then the basename prefix (a.tsx), then subsequence hits in ls-files order
        value: {
          paths: ['src/a.ts', 'src/components/a.tsx', 'src/ab.ts', 'src/components/a.test.tsx'],
          truncated: false,
        },
      });
      expect(await app.bus.dispatch(sender, 'fs.find', { worktreeId, query: 'a.ts', limit: 2 })).toEqual({
        ok: true,
        value: { paths: ['src/a.ts', 'src/components/a.tsx'], truncated: true },
      });
      expect(await app.bus.dispatch(sender, 'fs.find', { worktreeId, query: 'zzz' })).toEqual({
        ok: true,
        value: { paths: [], truncated: false },
      });
      expect(await app.bus.dispatch(sender, 'fs.find', { worktreeId: 'nope', query: '' })).toMatchObject({
        ok: false,
      });
    });
  });

  describe('link.open', () => {
    it.each(['http://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://host/f'])(
      'refuses %s before the shell sees it',
      async (url) => {
        const opened: string[] = [];
        const { app, sender } = makeTestApp({ openExternal: async (u) => void opened.push(u) });
        expect(await app.bus.dispatch(sender, 'link.open', { url })).toMatchObject({ ok: false });
        expect(opened).toEqual([]);
      },
    );

    it('opens an https url in the default browser', async () => {
      const opened: string[] = [];
      const { app, sender } = makeTestApp({ openExternal: async (u) => void opened.push(u) });
      expect(await app.bus.dispatch(sender, 'link.open', { url: 'https://example.com/docs?x=1' })).toEqual({
        ok: true,
        value: {},
      });
      expect(opened).toEqual(['https://example.com/docs?x=1']);
    });
  });
});
