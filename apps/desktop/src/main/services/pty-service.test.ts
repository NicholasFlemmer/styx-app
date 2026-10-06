import { describe, expect, it } from 'vitest';
import { mergePaths, parseLoginEnv, PtyService, fallbackShell } from './pty-service';

let available = true;
try {
  await import('node-pty');
} catch {
  available = false;
}

describe.skipIf(!available)('PtyService', () => {
  it('spawns a shell, echoes input, and reports exit', async () => {
    const pty = new PtyService();
    const chunks: string[] = [];
    pty.on('data', (_id, d) => chunks.push(d));
    const exited = new Promise<number>((resolve) => pty.on('exit', (_id, code) => resolve(code)));
    await pty.spawn({
      id: 's1',
      cwd: process.cwd(),
      // A POSIX shell, or cmd.exe by full path on Windows (node-pty resolves bare names on the login PATH only).
      ...(process.platform === 'win32'
        ? {
            shell: process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe',
            args: ['/c', 'echo __hello__& exit 3'],
          }
        : { shell: '/bin/sh', args: ['-c', 'echo __hello__; exit 3'] }),
    });
    const code = await exited;
    expect(code).toBe(3);
    expect(chunks.join('')).toContain('__hello__');
  });

  it('resolves a login PATH', async () => {
    const pty = new PtyService();
    const p = await pty.resolveLoginPath();
    expect(p.length).toBeGreaterThan(0);
    // The login env is cached; `maxAgeMs` forces a fresh shell (#98).
    const env = await pty.resolveLoginEnv();
    expect(env.path).toBe(p);
    expect(await pty.resolveLoginEnv()).toBe(env);
    expect(await pty.resolveLoginEnv({ maxAgeMs: -1 })).not.toBe(env);
  });
});

describe('parseLoginEnv / mergePaths (#98)', () => {
  it('reads the PATH line and absolute `command -v` answers keyed by base name; aliases and functions are dropped', () => {
    const out = [
      '__STYX_PATH__/opt/homebrew/bin:/Users/nic/.local/bin:/usr/bin',
      '/Users/nic/.local/bin/claude',
      'codex: aliased to /Users/nic/.codex/bin/codex',
      'gemini',
      '/Users/nic/.local/bin/agent',
      '',
    ].join('\n');
    expect(parseLoginEnv(out, 'darwin')).toEqual({
      path: '/opt/homebrew/bin:/Users/nic/.local/bin:/usr/bin',
      which: { claude: '/Users/nic/.local/bin/claude', agent: '/Users/nic/.local/bin/agent' },
    });
    expect(
      parseLoginEnv(
        '__STYX_PATH__C:\\Users\\nic\\.local\\bin;C:\\Windows\r\nC:\\Users\\nic\\.local\\bin\\claude.exe\r\n',
        'win32',
      ),
    ).toEqual({
      path: 'C:\\Users\\nic\\.local\\bin;C:\\Windows',
      which: { claude: 'C:\\Users\\nic\\.local\\bin\\claude.exe' },
    });
    expect(parseLoginEnv('garbage', 'darwin')).toEqual({ path: '', which: {} });
  });

  it('merges the login PATH first, then what the process had, without repeats (case-insensitive on Windows)', () => {
    expect(mergePaths('/a:/b', '/b:/c:', 'darwin')).toBe('/a:/b:/c');
    expect(mergePaths('C:\\A;C:\\B', 'c:\\b;C:\\C', 'win32')).toBe('C:\\A;C:\\B;C:\\C');
  });
});

describe('PtyService.kill on Windows', () => {
  it('a second kill before the exit never reaches conpty (it corrupts the heap and takes the app down)', async () => {
    const kills: (string | undefined)[] = [];
    let exit: (e: { exitCode: number; signal?: number }) => void = () => undefined;
    const fake = {
      pid: 1,
      onData: () => undefined,
      onExit: (cb: typeof exit) => {
        exit = cb;
      },
      kill: (signal?: string) => kills.push(signal),
      write: () => undefined,
      resize: () => undefined,
    };
    const pty = new PtyService('win32');
    // The native module is the one thing faked: spawn hands back the pty above.
    Object.assign(pty, { load: async () => ({ spawn: () => fake }) });
    await pty.spawn({ id: 'p1', cwd: process.cwd(), shell: 'cmd.exe', args: [] });
    pty.kill('p1');
    pty.kill('p1');
    expect(kills).toHaveLength(1);
    exit({ exitCode: 0 });
    // Once it has exited the id is free: a new pty under it can be killed again.
    await pty.spawn({ id: 'p1', cwd: process.cwd(), shell: 'cmd.exe', args: [] });
    pty.kill('p1');
    expect(kills).toHaveLength(2);
  });
});

describe('fallbackShell (no $SHELL)', () => {
  it('is zsh on a Mac, bash on Linux where there is one, else /bin/sh', () => {
    expect(fallbackShell('darwin', () => false)).toBe('/bin/zsh');
    expect(fallbackShell('linux', (p) => p === '/bin/bash')).toBe('/bin/bash');
    expect(fallbackShell('linux', (p) => p === '/usr/bin/bash')).toBe('/usr/bin/bash');
    expect(fallbackShell('linux', () => false)).toBe('/bin/sh');
  });
});
