import { connect, createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { onNdjson, writeNdjson } from './ndjson';
import {
  ErrorCode,
  methods,
  RpcRequest,
  type MethodName,
  type NotificationName,
  type Params,
  type Result,
  type RpcError,
  type SessionBrief,
  PROTOCOL_VERSION,
  type notifications,
} from './protocol';
import type { z } from 'zod';

/** True when something accepts connections at the socket path; a refused or missing socket is stale. */
export const isLive = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect(path);
    const done = (live: boolean) => {
      s.destroy();
      resolve(live);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });

export class BrokerError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ConnectionContext {
  session: SessionBrief;
  client: 'mcp' | 'shim' | 'cli' | 'hook';
  pid: number;
  connectionId: number;
}

export type MethodHandler<M extends MethodName> = (
  params: Params<M>,
  ctx: ConnectionContext,
  req: { id: string | number; hold: HoldHandle },
) => Promise<Result<M>>;

/** Lets a handler defer the reply (e.g. request_access waits for the user) and resolve it later from anywhere. */
/** Marks this request as held under `key`; reply later with `BrokerServer.resolveHeld(key, result)`. */
export type HoldHandle = (key: string) => void;

/**
 * Methods the server meters itself, by bucket: grant requests (`request`, 5/min — the host also charges
 * `exec_authorize` to it when a shim call opens a request) and agent questions (`ask`, larger: plan/decision
 * prompts are a normal part of a session but still must not flood the inbox).
 */
export type RateBucket = 'request' | 'ask' | 'peer';

const RATE_LIMIT_MESSAGE: Record<RateBucket, string> = {
  request: 'too many access requests; try again in a minute',
  ask: 'too many questions; try again in a minute',
  peer: 'too many messages to other agents; try again in a minute',
};
export const RATE_LIMITED_METHODS: Readonly<Partial<Record<MethodName, RateBucket>>> = {
  request_access: 'request',
  ask_user: 'ask',
  // A remembered command is something Styx will run later: never a free, unbounded write.
  remember_command: 'ask',
  // Its own bucket: without one, two agents can fill each other's context windows for free.
  send_message: 'peer',
};

/**
 * The socket directory must be a real directory (not a symlink) owned by this user with mode 0700, or another local
 * user could pre-create it and race the socket (L2). POSIX only; Windows pipes carry their own ACL.
 */
export function assertPrivateDir(dir: string): void {
  if (process.platform === 'win32') return;
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && st.uid !== uid)
    throw new Error(`${dir} is owned by uid ${st.uid}, expected ${uid}`);
  if ((st.mode & 0o777) !== 0o700)
    throw new Error(`${dir} has mode ${(st.mode & 0o777).toString(8)}, expected 0700`);
}

export interface BrokerServerOptions {
  /** Returns the session when sessionId + token match; null otherwise. Compare hashes, never store raw tokens. */
  authenticate: (sessionId: string, token: string) => Promise<SessionBrief | null>;
  /** Grant requests per session per minute (`request` bucket: request_access + host-metered exec_authorize). */
  rateLimitPerMinute?: number;
  /** `ask_user` calls per session per minute (`ask` bucket). */
  askRateLimitPerMinute?: number;
  /** Override which methods the server meters itself (and in which bucket). */
  rateLimitedMethods?: Readonly<Partial<Record<MethodName, RateBucket>>>;
  peerRateLimitPerMinute?: number;
  now?: () => number;
  onLog?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}

interface Conn {
  id: number;
  socket: Socket;
  ctx: ConnectionContext | null;
}

/** NDJSON JSON-RPC 2.0 server on a Unix socket / named pipe. Connections bind to one session after `hello`. */
export class BrokerServer {
  private server: Server | null = null;
  private readonly conns = new Map<number, Conn>();
  private readonly handlers = new Map<MethodName, MethodHandler<MethodName>>();
  private readonly held = new Map<string, { conn: Conn; id: string | number; method: MethodName }>();
  private readonly buckets = new Map<string, number[]>();
  private nextConn = 1;
  private readonly now: () => number;

  constructor(private readonly opts: BrokerServerOptions) {
    this.now = opts.now ?? Date.now;
  }

  on<M extends MethodName>(method: M, handler: MethodHandler<M>): this {
    this.handlers.set(method, handler as MethodHandler<MethodName>);
    return this;
  }

  async listen(path: string): Promise<void> {
    const posix = process.platform !== 'win32';
    if (posix) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      assertPrivateDir(dirname(path));
      // Only a stale socket (nothing answering) is removed. A live one belongs to another Styx instance; unlinking it
      // would leave that app listening on a path that no longer exists, so every new shim and MCP client of it fails.
      if (existsSync(path)) {
        if (await isLive(path))
          throw new BrokerError(ErrorCode.internal, `another broker is listening at ${path}`);
        unlinkSync(path);
      }
    }
    this.server = createServer((socket) => this.accept(socket));
    // The socket is created 0600 from the start (umask 077) instead of chmod'ing after bind, so there is no window
    // in which another local user can connect (L2).
    const prevUmask = posix ? process.umask(0o077) : null;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject);
        this.server?.listen(path, () => {
          if (posix) chmodSync(path, 0o600);
          resolve();
        });
      });
    } finally {
      if (prevUmask !== null) process.umask(prevUmask);
    }
  }

  async close(): Promise<void> {
    for (const c of this.conns.values()) c.socket.destroy();
    this.conns.clear();
    this.held.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Push a notification to every connection bound to the session. */
  notify<N extends NotificationName>(
    sessionId: string,
    method: N,
    params: z.infer<(typeof notifications)[N]>,
  ): void {
    for (const c of this.conns.values()) {
      if (c.ctx?.session.sessionId === sessionId) writeNdjson(c.socket, { jsonrpc: '2.0', method, params });
    }
  }

  /** Resolve a request that a handler put on hold (e.g. when the user grants from the sheet). */
  resolveHeld(key: string, result: unknown): boolean {
    const h = this.held.get(key);
    if (!h) return false;
    this.held.delete(key);
    const parsed = methods[h.method].result.safeParse(result);
    if (!parsed.success) {
      writeNdjson(h.conn.socket, {
        jsonrpc: '2.0',
        id: h.id,
        error: { code: ErrorCode.internal, message: 'invalid held result' },
      });
      return true;
    }
    writeNdjson(h.conn.socket, { jsonrpc: '2.0', id: h.id, result: parsed.data });
    return true;
  }

  rejectHeld(key: string, error: RpcError): boolean {
    const h = this.held.get(key);
    if (!h) return false;
    this.held.delete(key);
    writeNdjson(h.conn.socket, { jsonrpc: '2.0', id: h.id, error });
    return true;
  }

  heldKeys(): string[] {
    return [...this.held.keys()];
  }

  /** Drop every connection for a session (session stop / token rotation). */
  disconnectSession(sessionId: string): void {
    for (const c of [...this.conns.values()]) if (c.ctx?.session.sessionId === sessionId) c.socket.destroy();
  }

  connectionCount(): number {
    return this.conns.size;
  }

  private accept(socket: Socket): void {
    const conn: Conn = { id: this.nextConn++, socket, ctx: null };
    this.conns.set(conn.id, socket && conn);
    socket.on('close', () => {
      this.conns.delete(conn.id);
      for (const [k, h] of this.held) if (h.conn === conn) this.held.delete(k);
    });
    socket.on('error', () => socket.destroy());
    onNdjson(
      socket,
      (msg) => void this.dispatch(conn, msg),
      () =>
        writeNdjson(socket, {
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCode.parse, message: 'parse error' },
        }),
    );
  }

  private async dispatch(conn: Conn, msg: unknown): Promise<void> {
    const req = RpcRequest.safeParse(msg);
    if (!req.success) {
      writeNdjson(conn.socket, {
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCode.invalidRequest, message: 'invalid request' },
      });
      return;
    }
    const { id, method, params } = req.data;
    const reply = (result: unknown) => writeNdjson(conn.socket, { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string, data?: unknown) =>
      writeNdjson(conn.socket, {
        jsonrpc: '2.0',
        id,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
      });

    if (!(method in methods)) return fail(ErrorCode.methodNotFound, `unknown method ${method}`);
    const m = method as MethodName;
    const parsed = methods[m].params.safeParse(params ?? {});
    if (!parsed.success) return fail(ErrorCode.invalidParams, 'invalid params', parsed.error.issues);

    if (m === 'hello') {
      if (conn.ctx) {
        // A bound connection never re-binds: a second hello could swap the session under held requests (L3).
        fail(ErrorCode.invalidRequest, 'already authenticated');
        conn.socket.end(() => conn.socket.destroy());
        return;
      }
      const p = parsed.data as Params<'hello'>;
      if (p.v !== PROTOCOL_VERSION)
        return fail(ErrorCode.invalidRequest, `unsupported protocol version ${p.v}`);
      const session = await this.opts.authenticate(p.sessionId, p.token);
      if (!session) {
        fail(ErrorCode.unauthenticated, 'unauthenticated');
        conn.socket.destroy();
        return;
      }
      if (conn.ctx) {
        // Two hellos raced through `authenticate`; the first bound the connection, the second is an attack or a bug.
        fail(ErrorCode.invalidRequest, 'already authenticated');
        conn.socket.end(() => conn.socket.destroy());
        return;
      }
      conn.ctx = { session, client: p.client, pid: p.pid, connectionId: conn.id };
      this.opts.onLog?.('info', 'broker hello', {
        sessionId: session.sessionId,
        client: p.client,
        pid: p.pid,
      });
      return reply({ ok: true, session } satisfies Result<'hello'>);
    }

    if (!conn.ctx) return fail(ErrorCode.unauthenticated, 'hello first');
    const bucket = (this.opts.rateLimitedMethods ?? RATE_LIMITED_METHODS)[m];
    if (bucket && !this.allow(conn.ctx.session.sessionId, bucket))
      return fail(ErrorCode.rateLimited, RATE_LIMIT_MESSAGE[bucket]);

    const handler = this.handlers.get(m);
    if (!handler) return fail(ErrorCode.methodNotFound, `no handler for ${m}`);

    let heldKey: string | null = null;
    const hold: HoldHandle = (key) => {
      heldKey = key;
      this.held.set(key, { conn, id, method: m });
    };
    try {
      const result = await handler(parsed.data as never, conn.ctx, { id, hold });
      if (heldKey !== null) return; // reply comes later via resolveHeld
      const out = methods[m].result.safeParse(result);
      if (!out.success) return fail(ErrorCode.internal, 'handler returned invalid result');
      reply(out.data);
    } catch (e) {
      if (heldKey !== null) this.held.delete(heldKey);
      if (e instanceof BrokerError) return fail(e.code, e.message, e.data);
      this.opts.onLog?.('warn', 'broker handler failed', { method: m, error: (e as Error).message });
      fail(ErrorCode.internal, 'internal error');
    }
  }

  /** Consumes one slot of the session's per-minute bucket; false when exhausted. Public so the host can meter other grant-creating paths. */
  allow(sessionId: string, bucket: RateBucket = 'request'): boolean {
    const limit =
      bucket === 'ask'
        ? (this.opts.askRateLimitPerMinute ?? 30)
        : bucket === 'peer'
          ? (this.opts.peerRateLimitPerMinute ?? 20)
          : (this.opts.rateLimitPerMinute ?? 5);
    const key = `${bucket}:${sessionId}`;
    const t = this.now();
    const arr = (this.buckets.get(key) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= limit) {
      this.buckets.set(key, arr);
      return false;
    }
    arr.push(t);
    this.buckets.set(key, arr);
    return true;
  }
}
