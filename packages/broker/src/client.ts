import { connect, type Socket } from 'node:net';
import { onNdjson, writeNdjson } from './ndjson';
import { methods, notifications, RpcResponse, type MethodName, type NotificationName, type ParamsIn, type Result, type SessionBrief, PROTOCOL_VERSION } from './protocol';
import type { z } from 'zod';

export class BrokerClientError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

export interface BrokerClientOptions {
  endpoint: string;
  sessionId: string;
  token: string;
  client: 'mcp' | 'shim' | 'cli' | 'hook';
  pid?: number;
}

/** Used by `styx mcp`, the shims, and hooks. One connection per process. */
export class BrokerClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<NotificationName, ((p: unknown) => void)[]>();
  session: SessionBrief | null = null;

  constructor(private readonly opts: BrokerClientOptions) {}

  static fromEnv(client: BrokerClientOptions['client'], env: NodeJS.ProcessEnv = process.env): BrokerClient {
    const endpoint = env['STYX_BROKER'];
    const sessionId = env['STYX_SESSION_ID'];
    const token = env['STYX_TOKEN'];
    if (!endpoint || !sessionId || !token) throw new Error('Not inside a Styx session (STYX_BROKER / STYX_SESSION_ID / STYX_TOKEN missing).');
    return new BrokerClient({ endpoint, sessionId, token, client });
  }

  async connect(): Promise<SessionBrief> {
    await new Promise<void>((resolve, reject) => {
      const s = connect(this.opts.endpoint);
      s.once('connect', () => resolve());
      s.once('error', reject);
      this.socket = s;
    });
    const s = this.socket as Socket;
    s.on('close', () => {
      for (const p of this.pending.values()) p.reject(new BrokerClientError(-1, 'broker connection closed'));
      this.pending.clear();
    });
    onNdjson(s, (msg) => this.onMessage(msg));
    const res = await this.call('hello', { v: PROTOCOL_VERSION, sessionId: this.opts.sessionId, token: this.opts.token, client: this.opts.client, pid: this.opts.pid ?? process.pid });
    this.session = res.session;
    return res.session;
  }

  async call<M extends MethodName>(method: M, params: ParamsIn<M>, opts: { timeoutMs?: number } = {}): Promise<Result<M>> {
    const s = this.socket;
    if (!s) throw new Error('not connected');
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (opts.timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new BrokerClientError(-2, `timeout waiting for ${method}`));
        }, opts.timeoutMs).unref?.();
      }
    });
    writeNdjson(s, { jsonrpc: '2.0', id, method, params });
    const raw = await p;
    const parsed = methods[method].result.safeParse(raw);
    if (!parsed.success) throw new BrokerClientError(-3, `invalid result for ${method}`);
    return parsed.data as Result<M>;
  }

  onNotification<N extends NotificationName>(name: N, fn: (params: z.infer<(typeof notifications)[N]>) => void): () => void {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn as (p: unknown) => void);
    this.listeners.set(name, arr);
    return () => this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn));
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private onMessage(msg: unknown): void {
    const res = RpcResponse.safeParse(msg);
    if (res.success && typeof res.data.id === 'number') {
      const p = this.pending.get(res.data.id);
      if (!p) return;
      this.pending.delete(res.data.id);
      if (res.data.error) p.reject(new BrokerClientError(res.data.error.code, res.data.error.message, res.data.error.data));
      else p.resolve(res.data.result);
      return;
    }
    const n = msg as { method?: string; params?: unknown };
    if (n.method && n.method in notifications) {
      const schema = notifications[n.method as NotificationName];
      const parsed = schema.safeParse(n.params ?? {});
      if (parsed.success) for (const fn of this.listeners.get(n.method as NotificationName) ?? []) fn(parsed.data);
    }
  }
}
