import { fixtures } from '@styx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp } from '../test-support';
import { PtyService, type PtySpawnOptions } from './pty-service';

/** Records what a terminal is started with; `defaultShell` is the real one, for the platform under test. */
class RecordingPty extends PtyService {
  readonly spawned: PtySpawnOptions[] = [];
  override async spawn(opts: PtySpawnOptions): Promise<{ pid: number }> {
    this.spawned.push(opts);
    return { pid: 1 };
  }
}

const { ids } = fixtures;

describe('TerminalService · Shell (Windows) (issue #4)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, 'powershell.exe'],
    ['wsl', 'wsl.exe'],
    ['powershell', 'powershell.exe'],
  ] as const)('Windows: a terminal on a project set to %s starts %s', async (setting, file) => {
    vi.stubEnv('STYX_WIN_SHELL', '');
    const pty = new RecordingPty('win32');
    const t = makeTestApp({ pty });
    const acme = ids.project.acmeShop;
    t.app.repos.projects.setSettings(acme, setting === undefined ? {} : { shellWindows: setting }, null);
    await t.app.terminals.spawn(ids.worktree.acmeMain);
    expect(pty.spawned.at(-1)?.shell).toBe(file);
  });

  it('STYX_WIN_SHELL still overrides the project setting', async () => {
    vi.stubEnv('STYX_WIN_SHELL', 'powershell');
    const pty = new RecordingPty('win32');
    const t = makeTestApp({ pty });
    t.app.repos.projects.setSettings(ids.project.acmeShop, { shellWindows: 'wsl' }, null);
    await t.app.terminals.spawn(ids.worktree.acmeMain);
    expect(pty.spawned.at(-1)?.shell).toBe('powershell.exe');
  });

  it.each(['darwin', 'linux'] as const)('%s: the setting is ignored, the login shell runs', async (platform) => {
    vi.stubEnv('SHELL', '/bin/zsh');
    const pty = new RecordingPty(platform);
    const t = makeTestApp({ pty });
    t.app.repos.projects.setSettings(ids.project.acmeShop, { shellWindows: 'wsl' }, null);
    await t.app.terminals.spawn(ids.worktree.acmeMain);
    expect(pty.spawned.at(-1)?.shell).toBe('/bin/zsh');
  });
});
