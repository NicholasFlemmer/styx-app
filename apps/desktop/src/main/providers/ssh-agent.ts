import { createServer, type Server, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
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
/** SSH_AGENTC_EXTENSION: the client asks the agent for a named extension. */
const SSH_AGENTC_EXTENSION = 27;
/** A framed SSH_AGENT_FAILURE (length 1, type 5) — the correct answer to an extension we do not implement. */
const AGENT_FAILURE = Buffer.from([0, 0, 0, 1, 5]);
/** OpenSSH refuses agent messages above 256 KiB; anything larger is a malformed or hostile peer. */
const MAX_AGENT_MESSAGE = 256 * 1024;

/**
 * Answers `session-bind@openssh.com` before ssh2 can mangle it.
 *
 * Every OpenSSH >= 8.9 client sends SSH_AGENTC_EXTENSION (type 27) as its FIRST message, before asking for
 * identities. ssh2's `AgentProtocol` has no case for it: it replies FAILURE but advances its cursor by only the
 * 5-byte header, so the extension body stays in the buffer and is re-parsed as a new message. The stream
 * desyncs and the REQUEST_IDENTITIES that follows is never answered — the client logs "agent refused
 * operation", falls back to `~/.ssh/*`, and the grant's key is never offered at all. That made every SSH grant
 * fail on macOS 13+ and current Linux regardless of the key, which is why `ssh-add -l` looked fine by hand
 * (it never sends session-bind).
 *
 * So we frame-split the client stream ourselves, reply FAILURE to extension requests (declining an extension is
 * a legitimate answer that OpenSSH proceeds past), and forward every other message untouched.
 */
class SessionBindFilter extends Transform {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly reply: (b: Buffer) => void) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > MAX_AGENT_MESSAGE) {
        cb(new Error(`bad agent message length ${len}`));
        return;
      }
      if (this.buf.length < 4 + len) break;
      const frame = this.buf.subarray(0, 4 + len);
      const type = frame[4];
      this.buf = this.buf.subarray(4 + len);
      if (type === SSH_AGENTC_EXTENSION) this.reply(AGENT_FAILURE);
      else out.push(Buffer.from(frame));
    }
    cb(null, out.length === 0 ? undefined : Buffer.concat(out));
  }
}

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
    const filter = new SessionBindFilter((b) => sock.write(b));
    sock.pipe(filter).pipe(proto).pipe(sock);
    filter.on('error', () => sock.destroy());
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
