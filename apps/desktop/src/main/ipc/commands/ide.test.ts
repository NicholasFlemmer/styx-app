import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fakeIdeMachine,
  installAll,
  installVscodeLike,
  installZed,
} from '../../services/__fixtures__/ide-machine';
import { DetectService, type DetectDeps } from '../../services/detect-service';
import { makeTestApp } from '../../test-support';
import { cliBinaryKey } from './ide';

describe('detect.ides', () => {
  it('publishes one IdeInstall per found kind with its recentsSource, and isFallback from the app setting', async () => {
    const m = fakeIdeMachine('darwin');
    installAll(m);
    const t = makeTestApp({ fixture: 'empty', detect: new DetectService(m.deps) });
    t.app.repos.settings.patch({ fallbackIde: 'windsurf' });
    const r = await t.app.bus.dispatch(t.sender, 'detect.ides', {});
    if (!r.ok) throw new Error(r.error.message);
    expect(
      r.value.ides.map((i) => ({
        id: i.id,
        kind: i.kind,
        product: i.product,
        recentsSource: i.recentsSource,
        isFallback: i.isFallback,
        launcher: i.launcher,
      })),
    ).toEqual([
      {
        id: 'ide-vscode',
        kind: 'vscode',
        product: 'VS Code',
        recentsSource: 'state-db',
        isFallback: false,
        launcher: join(m.bins, 'code'),
      },
      {
        id: 'ide-cursor',
        kind: 'cursor',
        product: 'Cursor',
        recentsSource: 'state-db',
        isFallback: false,
        launcher: join(m.bins, 'cursor'),
      },
      {
        id: 'ide-windsurf',
        kind: 'windsurf',
        product: 'Windsurf',
        recentsSource: 'state-db',
        isFallback: true,
        launcher: join(m.bins, 'windsurf'),
      },
      {
        id: 'ide-zed',
        kind: 'zed',
        product: 'Zed',
        recentsSource: null,
        isFallback: false,
        launcher: join(m.bins, 'zed'),
      },
      {
        id: 'ide-jetbrains',
        kind: 'jetbrains',
        product: 'JetBrains (WebStorm)',
        recentsSource: 'recent-projects',
        isFallback: false,
        launcher: 'open -a "WebStorm"',
      },
      {
        id: 'ide-neovim',
        kind: 'neovim',
        product: 'Neovim',
        recentsSource: 'shada',
        isFallback: false,
        launcher: join(m.bins, 'nvim'),
      },
    ]);
    // JetBrains recents are counted from recentProjects.xml at detection time; the rest wait for an import.
    expect(r.value.ides.map((i) => i.imported.recents)).toEqual([0, 0, 0, 0, 3, 0]);
    // Persisted (the DB CHECK admits the two new kinds) and published as one discovery.set delta.
    expect(t.app.repos.discovery.ides().map((i) => i.kind)).toEqual([
      'vscode',
      'cursor',
      'windsurf',
      'zed',
      'jetbrains',
      'neovim',
    ]);
    t.app.publisher.flush();
    expect(
      t.win
        .batches()
        .at(-1)
        ?.deltas.some((d) => d.op === 'discovery.set'),
    ).toBe(true);

    // Only what is installed is published: a machine with just Zed and Cursor yields two rows.
    const m2 = fakeIdeMachine('win32');
    installZed(m2, '0.201.6');
    installVscodeLike(m2, 'cursor', '1.7.28');
    const t2 = makeTestApp({ fixture: 'empty', detect: new DetectService(m2.deps) });
    const r2 = await t2.app.bus.dispatch(t2.sender, 'detect.ides', {});
    if (!r2.ok) throw new Error(r2.error.message);
    expect(r2.value.ides.map((i) => [i.kind, i.isFallback])).toEqual([
      ['cursor', false],
      ['zed', false],
    ]);
  });
});

const fakeDetect = (home: string) =>
  new DetectService({
    platform: 'darwin',
    home,
    pathEnv: '', // nothing on PATH: only a located binary can make an agent `found`
    env: { SHELL: '/bin/sh' },
    exec: async (bin, args) => {
      if (args[0] === '--version') {
        if (bin.endsWith('settings.json')) return { stdout: 'exec format error', exitCode: 126 };
        return { stdout: bin.includes('codex') ? 'codex-cli 0.42.0' : 'sh 3.2', exitCode: 0 };
      }
      if (args[0] === '--help') return { stdout: 'usage: --config <f> -c', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    },
  } satisfies DetectDeps);

describe('detect.setBinary (Locate binary)', () => {
  it('a bare command name resolves on the login shell PATH; an unknown one says so; a relative path is refused (#98)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const tools = join(home, 'tools');
    mkdirSync(tools);
    const bin = join(tools, 'codex');
    writeFileSync(bin, '#!/bin/sh\necho 0.42.0\n');
    chmodSync(bin, 0o755);
    const detect = new DetectService({
      platform: 'darwin',
      home,
      pathEnv: '',
      env: { SHELL: '/bin/sh' },
      login: async () => ({ path: tools, which: {} }),
      exec: async (b, args) => {
        if (args[0] === '--version')
          return { stdout: b.includes('codex') ? 'codex-cli 0.42.0' : 'sh 3.2', exitCode: 0 };
        return { stdout: 'usage: --config <f> -c', exitCode: 0 };
      },
    });
    const t = makeTestApp({ fixture: 'empty', detect });
    const r = await t.app.bus.dispatch(t.sender, 'detect.setBinary', { agent: 'codex', path: 'codex' });
    expect(r).toMatchObject({ ok: true, value: { cli: { binary: bin, found: true, version: '0.42.0' } } });
    expect(t.app.repos.settings.kv.get<string>(cliBinaryKey('codex'))).toBe(bin);
    expect(
      await t.app.bus.dispatch(t.sender, 'detect.setBinary', { agent: 'codex', path: 'nope' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'not-found', message: "Couldn't find nope on your shell PATH." },
    });
    expect(
      await t.app.bus.dispatch(t.sender, 'detect.setBinary', { agent: 'codex', path: 'tools/codex' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  });

  it('probes the picked path, stores it in cli_installs + app_settings, and survives a re-detect until the file goes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const bin = join(home, 'codex');
    writeFileSync(bin, '#!/bin/sh\necho 0.42.0\n');
    chmodSync(bin, 0o755);
    const t = makeTestApp({ fixture: 'empty', detect: fakeDetect(home) });
    const { app, sender } = t;

    const missing = await app.bus.dispatch(sender, 'detect.setBinary', {
      agent: 'codex',
      path: join(home, 'nope'),
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'shell', path: bin })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });

    const r = await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'codex', path: bin });
    expect(r).toMatchObject({
      ok: true,
      value: {
        cli: {
          agent: 'codex',
          binary: bin,
          version: '0.42.0',
          found: true,
          capabilities: { configOverride: true },
        },
      },
    });
    expect(app.repos.discovery.cli('codex')?.binary).toBe(bin);
    expect(app.repos.settings.kv.get<string>(cliBinaryKey('codex'))).toBe(bin);
    app.publisher.flush();
    expect(
      t.win
        .batches()
        .at(-1)
        ?.deltas.some((d) => d.op === 'discovery.set'),
    ).toBe(true);

    // PATH detection finds nothing, but the located binary keeps codex `found`.
    const again = await app.bus.dispatch(sender, 'detect.clis', {});
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.clis.find((c) => c.agent === 'codex')).toMatchObject({ binary: bin, found: true });
    expect(again.value.clis.find((c) => c.agent === 'claude')).toMatchObject({ binary: null, found: false });

    // Once the file disappears the override is dropped and detection is honest again.
    rmSync(bin);
    const gone = await app.bus.dispatch(sender, 'detect.clis', {});
    if (!gone.ok) throw new Error(gone.error.message);
    expect(gone.value.clis.find((c) => c.agent === 'codex')).toMatchObject({ binary: null, found: false });
    expect(app.repos.settings.kv.get<string>(cliBinaryKey('codex'))).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a pick that is not this CLI, with a human reason, and remembers nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const t = makeTestApp({ fixture: 'empty', detect: fakeDetect(home) });
    const { app, sender } = t;
    const folder = join(home, '.claude');
    mkdirSync(folder);
    expect(
      await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'claude', path: folder }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-input',
        message: `${folder} is a folder, not the Claude Code program. Pick the Claude Code executable itself.`,
      },
    });
    const settings = join(folder, 'settings.json');
    writeFileSync(settings, '{}');
    expect(
      await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'claude', path: settings }),
    ).toMatchObject({
      ok: false,
      error: {
        message: `${settings} did not run as Claude Code (no version reported). Pick the Claude Code executable itself.`,
      },
    });
    const codex = join(home, 'codex');
    writeFileSync(codex, '#!/bin/sh\necho 0.42.0\n');
    chmodSync(codex, 0o755);
    expect(
      await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'claude', path: codex }),
    ).toMatchObject({
      ok: false,
      error: { message: `${codex} is the Codex CLI, not Claude Code.` },
    });
    expect(app.repos.settings.kv.get<string>(cliBinaryKey('claude'))).toBeUndefined();
    expect(app.repos.discovery.cli('claude')?.binary ?? null).not.toBe(codex);
    const honest = await app.bus.dispatch(sender, 'detect.clis', {});
    if (!honest.ok) throw new Error(honest.error.message);
    expect(honest.value.clis.find((c) => c.agent === 'claude')).toMatchObject({ binary: null, found: false });
    rmSync(home, { recursive: true, force: true });
  });

  it('clearBinary forgets a located binary and detection is honest again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const bin = join(home, 'codex');
    writeFileSync(bin, '#!/bin/sh\necho 0.42.0\n');
    chmodSync(bin, 0o755);
    const t = makeTestApp({ fixture: 'empty', detect: fakeDetect(home) });
    const { app, sender } = t;
    await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'codex', path: bin });
    expect(app.repos.discovery.cli('codex')).toMatchObject({ binary: bin, found: true });

    const r = await app.bus.dispatch(sender, 'detect.clearBinary', { agent: 'codex' });
    expect(r).toMatchObject({ ok: true, value: { cli: { agent: 'codex', binary: null, found: false } } });
    expect(app.repos.settings.kv.get<string>(cliBinaryKey('codex'))).toBeUndefined();
    expect(app.repos.discovery.cli('codex')?.found).toBe(false);
    app.publisher.flush();
    expect(
      t.win
        .batches()
        .at(-1)
        ?.deltas.some((d) => d.op === 'discovery.set'),
    ).toBe(true);
    expect(await app.bus.dispatch(sender, 'detect.clearBinary', { agent: 'shell' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    rmSync(home, { recursive: true, force: true });
  });
});
