import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { GIT_DOWNLOAD_URL } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { GitSetupService } from './git-setup-service';

const rig = (opts: { platform: NodeJS.Platform; path?: string; installed?: boolean }) => {
  const pty = new EventEmitter();
  const events: unknown[] = [];
  const spawned: { file: string; args: string[] }[] = [];
  const opened: string[] = [];
  const activity: unknown[] = [];
  const svc = new GitSetupService({
    git: {
      available: async () =>
        opts.installed ? { installed: true, version: '2.47.0' } : { installed: false, version: null },
    },
    terminals: {
      spawnCommand: vi.fn(async (o: { file: string; args: string[] }) => {
        spawned.push({ file: o.file, args: o.args });
        return 'term-1';
      }),
    },
    // An EventEmitter is all the service uses of the pty: `on` / `off` for the install terminal's exit.
    pty: pty as never,
    publisher: { sendEvent: (name: string, payload: unknown) => events.push([name, payload]) } as never,
    activity: { append: (a: unknown) => activity.push(a) } as never,
    openExternal: async (url) => {
      opened.push(url);
    },
    loginPath: async () => opts.path ?? '',
    shell: () => '/bin/zsh',
    platform: opts.platform,
    home: '/home/me',
  });
  return { svc, pty, events, spawned, opened, activity };
};

/** A PATH holding the named (empty, executable) tools. */
const pathWith = (...tools: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'styx-tools-'));
  for (const t of tools) writeFileSync(join(dir, t), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
};

describe('GitSetupService', () => {
  it('macOS: status names Apple’s installer; Install runs it in a terminal and reports running → exited', async () => {
    const { svc, pty, events, spawned, activity } = rig({ platform: 'darwin' });
    expect(await svc.status()).toEqual({
      installed: false,
      version: null,
      installCommand: 'xcode-select --install',
    });
    expect(await svc.install()).toEqual({ terminalId: 'term-1', command: 'xcode-select --install' });
    expect(spawned).toEqual([{ file: '/bin/zsh', args: ['-ilc', 'xcode-select --install'] }]);
    pty.emit('exit', 'someone-else', 0);
    pty.emit('exit', 'term-1', 0);
    expect(events).toEqual([
      ['git.install', { terminalId: 'term-1', status: 'running' }],
      ['git.install', { terminalId: 'term-1', status: 'exited', exitCode: 0 }],
    ]);
    expect(activity).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'Linux: the first package manager the shell has; none → the download page, nothing run',
    async () => {
      const withDnf = rig({ platform: 'linux', path: pathWith('dnf') });
      expect((await withDnf.svc.status()).installCommand).toBe('sudo dnf install -y git');
      const bare = rig({ platform: 'linux', path: pathWith() });
      expect((await bare.svc.status()).installCommand).toBeNull();
      expect(await bare.svc.install()).toEqual({ terminalId: null, command: null });
      expect(bare.opened).toEqual([GIT_DOWNLOAD_URL]);
      expect(bare.spawned).toEqual([]);
    },
  );

  it('a stopped installer is reported with its code and logs nothing; Download opens the page instead', async () => {
    const { svc, pty, events, opened, activity, spawned } = rig({ platform: 'darwin', installed: false });
    await svc.install();
    pty.emit('exit', 'term-1', 1);
    expect(events.at(-1)).toEqual(['git.install', { terminalId: 'term-1', status: 'exited', exitCode: 1 }]);
    expect(activity).toEqual([]);
    expect(await svc.install(true)).toEqual({ terminalId: null, command: null });
    expect(opened).toEqual([GIT_DOWNLOAD_URL]);
    expect(spawned).toHaveLength(1);
  });

  it('reports git as installed with its version', async () => {
    const { svc } = rig({ platform: 'darwin', installed: true });
    expect(await svc.status()).toMatchObject({ installed: true, version: '2.47.0' });
  });
});
