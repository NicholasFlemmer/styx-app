import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { makeCredentialRef } from '../services/credential-vault';
import { StyxSshAgent } from './ssh-agent';
import type { AdapterDeps, ConnectInput, GrantInfo, IssuedCredential, ProviderAdapter, Scope, TargetInfo, TestResult } from './types';
import { hasVerb } from './types';

export interface SshAdapterOptions {
  socketDir?: string;
  onSign?: (grantId: string, info: { keyType: string; comment: string }) => void;
  platform?: NodeJS.Platform;
}

/** SSH host: key path (and optional passphrase) in the vault; each grant runs an in-process agent on its own socket. */
export class SshAdapter implements ProviderAdapter {
  readonly provider = 'ssh' as const;
  readonly authMethod = 'ssh' as const;
  readonly tools = ['ssh', 'scp', 'rsync', 'sftp'];
  private readonly agents = new Map<string, StyxSshAgent>();

  constructor(private readonly deps: AdapterDeps, private readonly opts: SshAdapterOptions = {}) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method !== 'ssh') throw new Error('SSH connect expects host/user/key');
    await readFile(input.keyPath, 'utf8'); // key must be readable now; it is read again per grant, never copied
    const ref = makeCredentialRef('ssh', targetId, 'ssh-key-path');
    await this.deps.vault.set(ref, JSON.stringify({ keyPath: input.keyPath, ...(input.passphrase ? { passphrase: input.passphrase } : {}) }));
    return { credentialRef: ref, config: { host: input.host, user: input.user, port: input.port ?? 22 }, label: `SSH ${input.user}@${input.host}` };
  }

  private async secret(target: TargetInfo): Promise<{ keyPath: string; passphrase?: string }> {
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return JSON.parse(raw) as { keyPath: string; passphrase?: string };
  }

  private socketPath(grantId: string): string {
    if ((this.opts.platform ?? process.platform) === 'win32') return `\\\\.\\pipe\\styx-agent-${grantId}`;
    return join(this.opts.socketDir ?? join(tmpdir(), `styx-${process.getuid?.() ?? 0}`), `agent-${grantId}.sock`);
  }

  async test(target: TargetInfo): Promise<TestResult> {
    const probe: GrantInfo = { id: `test-${Date.now()}`, scope: ['read'], duration: 'once', expiresAt: null };
    try {
      const issued = await this.issue(probe, target);
      try {
        const host = String(target.config['host']);
        const user = String(target.config['user']);
        const port = String(target.config['port'] ?? 22);
        const r = await execa('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', '-p', port, `${user}@${host}`, 'true'], { env: { ...process.env, ...issued.env }, reject: false, timeout: 15_000 });
        return r.exitCode === 0 ? { ok: true, identity: `${user}@${host}` } : { ok: false, error: String(r.stderr ?? '').trim() || `ssh exited ${r.exitCode}` };
      } finally {
        await this.revoke(issued);
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const { keyPath, passphrase } = await this.secret(target);
    const pem = await readFile(keyPath, 'utf8');
    const agent = new StyxSshAgent((info) => this.opts.onSign?.(grant.id, info));
    const socketPath = this.socketPath(grant.id);
    await agent.start(socketPath, pem, passphrase);
    this.agents.set(grant.id, agent);
    const env: Record<string, string> = { SSH_AUTH_SOCK: socketPath, GIT_SSH_COMMAND: 'ssh -o IdentitiesOnly=no' };
    if (typeof target.config['host'] === 'string') env['STYX_SSH_HOST'] = `${String(target.config['user'] ?? '')}@${target.config['host']}`;
    return { kind: 'ssh-agent', socketPath, env, expiresAt: grant.expiresAt, scoped: true, handle: grant.id };
  }

  async revoke(issued: IssuedCredential): Promise<void> {
    if (issued.kind !== 'ssh-agent') return;
    const a = this.agents.get(issued.handle);
    if (a) {
      await a.stop();
      this.agents.delete(issued.handle);
    }
  }

  async revokeAll(): Promise<void> {
    for (const [id, a] of this.agents) {
      await a.stop();
      this.agents.delete(id);
    }
  }

  issuesScoped(): boolean {
    // The forwarded agent socket signs anything the remote host asks for; a "read" grant still opens a full login.
    return false;
  }

  scopeOfCommand(argv: string[], tool = 'ssh'): Scope[] {
    // scp/sftp/rsync move files in both directions: always a write; `rsync --delete` removes remote files.
    if (tool !== 'ssh') return hasVerb(argv, /^--delete(-[a-z]+)?$/) ? ['delete'] : ['write'];
    // ssh [-opts] user@host [command…] — classify the remote command only.
    const hostIdx = argv.findIndex((a) => !a.startsWith('-') && a.includes('@'));
    const remote = (hostIdx >= 0 ? argv.slice(hostIdx + 1) : argv.filter((a) => !a.startsWith('-')).slice(1)).join(' ');
    if (/\b(rm -rf|rm -r|rm -fr|dropdb|DROP |truncate|mkfs|shred)\b/i.test(remote)) return ['delete'];
    // Fail closed: shell metacharacters, command chains, pipes, redirects, or substitutions could hide anything
    // behind a benign-looking first word (`ls; rm …`), so they can never classify as read.
    if (/[;&|$`\n><]/.test(remote) || /\(|\{/.test(remote)) return ['write'];
    if (/\b(deploy|systemctl restart|docker compose up|pm2 (restart|reload))\b/.test(remote)) return ['deploy'];
    // A bare `ssh host` is an interactive login: anything can happen in it.
    if (remote === '') return ['write'];
    if (/^(ls|cat|tail|head|df|uptime|true|hostname|whoami)\b/.test(remote)) return ['read'];
    return ['write'];
  }
}
