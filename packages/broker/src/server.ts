import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { onNdjson, writeNdjson } from './ndjson';
import { ErrorCode, methods, RpcRequest, type MethodName, type NotificationName, type Params, type Result, type RpcError, type SessionBrief, PROTOCOL_VERSION, type notifications } from './protocol';
import type { z } from 'zod';

export class BrokerError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

export interface ConnectionContext {
  session: SessionBrief;
  client: 'mcp' | 'shim' | 'cli' | 'hook';
  pid: number;
  connectionId: number;
}

export type MethodHandler<M extends MethodName> = (params: Params<M>, ctx: ConnectionContext, req: { id: string | number; hold: HoldHandle }) => Promise<Result<M>>;

/** Lets a handler defer the reply (e.g. request_access waits for the user) and resolve it later from anywhere. */
/** Marks this request as held under `key`; reply later with `BrokerServer.resolveHeld(key, result)`. */
export type HoldHandle = (key: string) => void;

export interface BrokerServerOptions {
  /** Returns the session when sessionId + token match; null otherwise. Compare hashes, never store raw tokens. */
  authenticate: (sessionId: string, token: string) => Promise<SessionBrief | null>;
  /** request_access calls allowed per session per minute (spec: blunt prompt-injection spam). */
  rateLimitPerMinute?: number;
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
    if (process.platform !== 'win32') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) unlinkSync(path);
    }
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(path, () => {
        if (process.platform !== 'win32') chmodSync(path, 0o600);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.conns.values()) c.socket.destroy();
    this.conns.clear();
    this.held.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Push a notification to every connection bound to the session. */
  notify<N extends NotificationName>(sessionId: string, method: N, params: z.infer<(typeof notifications)[N]>): void {
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
      writeNdjson(h.conn.socket, { jsonrpc: '2.0', id: h.id, error: { code: ErrorCode.internal, message: 'invalid held result' } });
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
      () => writeNdjson(socket, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.parse, message: 'parse error' } }),
    );
  }

  private async dispatch(conn: Conn, msg: unknown): Promise<void> {
    const req = RpcRequest.safeParse(msg);
    if (!req.success) {
      writeNdjson(conn.socket, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.invalidRequest, message: 'invalid request' } });
      return;
    }
    const { id, method, params } = req.data;
    const reply = (result: unknown) => writeNdjson(conn.socket, { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string, data?: unknown) => writeNdjson(conn.socket, { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

    if (!(method in methods)) return fail(ErrorCode.methodNotFound, `unknown method ${method}`);
    const m = method as MethodName;
    const parsed = methods[m].params.safeParse(params ?? {});
    if (!parsed.success) return fail(ErrorCode.invalidParams, 'invalid params', parsed.error.issues);

    if (m === 'hello') {
      const p = parsed.data as Params<'hello'>;
      if (p.v !== PROTOCOL_VERSION) return fail(ErrorCode.invalidRequest, `unsupported protocol version ${p.v}`);
      const session = await this.opts.authenticate(p.sessionId, p.token);
      if (!session) {
        fail(ErrorCode.unauthenticated, 'unauthenticated');
        conn.socket.destroy();
        return;
      }
      conn.ctx = { session, client: p.client, pid: p.pid, connectionId: conn.id };
      this.opts.onLog?.('info', 'broker hello', { sessionId: session.sessionId, client: p.client, pid: p.pid });
      return reply({ ok: true, session } satisfies Result<'hello'>);
    }

    if (!conn.ctx) return fail(ErrorCode.unauthenticated, 'hello first');
    if (m === 'request_access' && !this.allow(conn.ctx.session.sessionId)) return fail(ErrorCode.rateLimited, 'too many access requests; try again in a minute');

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

  private allow(sessionId: string): boolean {
    const limit = this.opts.rateLimitPerMinute ?? 5;
    const t = this.now();
    const arr = (this.buckets.get(sessionId) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= limit) {
      this.buckets.set(sessionId, arr);
      return false;
    }
    arr.push(t);
    this.buckets.set(sessionId, arr);
    return true;
  }
}
