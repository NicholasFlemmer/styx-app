import { describe, expect, it } from 'vitest';
import { mergePaths, parseLoginEnv, PtyService } from './pty-service';

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
    await pty.spawn({ id: 's1', cwd: process.cwd(), shell: '/bin/sh', args: ['-c', 'echo __hello__; exit 3'] });
    const code = await exited;
    expect(code).toBe(3);
    expect(chunks.join('')).toContain('__hello__');
  });

  it('resolves a login PATH', async () => {
    const pty = new PtyService();
    const p = await pty.resolveLoginPath();
    expect(p.length).toBeGreaterThan(0);
    // The login env is cached; `maxAgeMs` forces a fresh shell (#89).
    const env = await pty.resolveLoginEnv();
    expect(env.path).toBe(p);
    expect(await pty.resolveLoginEnv()).toBe(env);
    expect(await pty.resolveLoginEnv({ maxAgeMs: -1 })).not.toBe(env);
  });
});

describe('parseLoginEnv / mergePaths (#89)', () => {
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
