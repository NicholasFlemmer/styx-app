import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../services/credential-vault';

const calls: string[][] = [];
vi.mock('execa', () => ({
  execa: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  }),
}));

describe('SSH target test', () => {
  it('runs a command every server shell knows, Windows included (cmd.exe has no `true`)', async () => {
    const { SshAdapter } = await import('./ssh');
    const keys = utils.generateKeyPairSync('ed25519', { comment: 'styx-test' });
    const dir = mkdtempSync(join(tmpdir(), 'styx-ssh-'));
    const keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, keys.private, { mode: 0o600 });
    const ssh = new SshAdapter({ vault: new MemoryVault() } as never, { socketDir: dir });
    const c = await ssh.connect(
      { method: 'ssh', host: 'localhost', user: 'nic', keyPath, port: 2222 },
      't-win',
    );
    const r = await ssh.test({
      id: 't-win',
      provider: 'ssh',
      env: 'prod',
      credentialRef: c.credentialRef,
      config: c.config,
    } as never);
    expect(r.ok).toBe(true);
    expect(calls.at(-1)?.at(-1)).toBe('exit 0');
    expect(calls.at(-1)).toContain('nic@localhost');
  });
});
