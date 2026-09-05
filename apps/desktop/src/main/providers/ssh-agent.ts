import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertPrivateDir } from '@styx/broker';
import { AgentProtocol, utils } from 'ssh2';

interface ParsedKey {
  type: string;
  comment: string;
  getPublicSSH(): Buffer;
  sign(data: Buffer, algo?: string): Buffer | Error;
}

/**
 * In-process ssh-agent holding one key in memory for the grant's lifetime. The agent process gets `SSH_AUTH_SOCK`,
 * never the key file. Every sign request is reported (→ grant_uses / audit "used").
 */
export class StyxSshAgent {
  private server: Server | null = null;
  private key: ParsedKey | null = null;
  private zeroed = false;

  constructor(private readonly onSign: (info: { keyType: string; comment: string }) => void) {}

  async start(socketPath: string, privateKey: string | Buffer, passphrase?: string): Promise<void> {
    const parsed = utils.parseKey(privateKey, passphrase) as unknown as ParsedKey | ParsedKey[] | Error;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || key instanceof Error) throw new Error(`Cannot parse SSH key: ${(key as Error | undefined)?.message ?? 'unknown'}`);
    this.key = key;
    const posix = process.platform !== 'win32';
    if (posix) {
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
      assertPrivateDir(dirname(socketPath)); // owned by us, 0700, not a symlink (L2)
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
    this.server = createServer((sock) => this.handle(sock));
    const prevUmask = posix ? process.umask(0o077) : null; // socket is born 0600; no chmod window
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject);
        this.server?.listen(socketPath, () => {
          if (posix) chmodSync(socketPath, 0o600);
          resolve();
        });
      });
    } finally {
      if (prevUmask !== null) process.umask(prevUmask);
    }
  }

  private handle(sock: Socket): void {
    const proto = new AgentProtocol(false);
    sock.pipe(proto).pipe(sock);
    sock.on('error', () => sock.destroy());
    proto.on('identities', (req) => {
      if (!this.key || this.zeroed) return proto.failureReply(req);
      proto.getIdentitiesReply(req, [this.key as never]);
    });
    proto.on('sign', (req, pubKey: { type: string }, data: Buffer, flags?: { hash?: string }) => {
      if (!this.key || this.zeroed) return proto.failureReply(req);
      const sig = this.key.sign(data, flags?.hash);
      if (sig instanceof Error) return proto.failureReply(req);
      this.onSign({ keyType: pubKey.type, comment: this.key.comment });
      proto.signReply(req, sig);
    });
  }

  publicKey(): string | null {
    return this.key ? `${this.key.type} ${this.key.getPublicSSH().toString('base64')} ${this.key.comment}`.trim() : null;
  }

  async stop(): Promise<void> {
    this.zeroed = true;
    this.key = null;
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
