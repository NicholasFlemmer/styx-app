import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../services/credential-vault';

const calls: string[][] = [];
const envs: Record<string, string | undefined>[] = [];
vi.mock('execa', () => ({
  execa: vi.fn(async (_file: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
    calls.push(args);
    envs.push(opts.env);
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
    // The grant's own config (user, port, agent), as an agent's ssh gets it; `--` keeps the host from being an option.
    const args = calls.at(-1) ?? [];
    expect(args.slice(0, 1)).toEqual(['-F']);
    expect(args.slice(-3)).toEqual(['--', 'localhost', 'exit 0']);
    expect(args).toContain('BatchMode=yes');
  });

  it('tests a password target through the master connection it signs in, like an agent command', async () => {
    const { SshAdapter } = await import('./ssh');
    const dir = mkdtempSync(join(tmpdir(), 'styx-ssh-'));
    const typed: string[] = [];
    const ssh = new SshAdapter({ vault: new MemoryVault() } as never, {
      socketDir: dir,
      platform: 'darwin',
      controlSsh: async () => 0,
      sshPath: '/usr/bin/ssh',
      spawnTerminal: async (_f, args) => {
        const control = (args.find((a) => a.startsWith('ControlPath=')) ?? '').slice('ControlPath='.length);
        let data: (d: string) => void = () => undefined;
        setTimeout(() => data("nic@localhost's password: "), 5);
        return {
          onData: (cb) => (data = cb),
          onExit: () => undefined,
          write: (d) => {
            typed.push(d);
            writeFileSync(control, '');
          },
          kill: () => undefined,
        };
      },
    });
    const c = await ssh.connect(
      { method: 'ssh', auth: 'password', host: 'localhost', user: 'nic', password: 'pw!' },
      't-pw',
    );
    const r = await ssh.test({
      id: 't-pw',
      provider: 'ssh',
      env: 'prod',
      credentialRef: c.credentialRef,
      config: c.config,
    } as never);
    expect(r.ok).toBe(true);
    expect(typed).toEqual(['pw!\r']);
    expect(calls.at(-1)).toContain('BatchMode=yes'); // the test command itself never prompts
    expect(JSON.stringify(envs.at(-1))).not.toContain('pw!');
  });
});
