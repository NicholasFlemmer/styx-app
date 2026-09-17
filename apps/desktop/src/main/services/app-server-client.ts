import { spawn as spawnChild } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { copy, effortSchema, fill, type AgentLimits, type Effort, type ModelInfo } from '@styx/core';
import { z } from 'zod';
import { logger } from './logger';

/**
 * Minimal JSON-RPC 2.0 client for `codex app-server` (newline-delimited over stdio; docs/research/agent-parity.md
 * §2.4). Three kinds of incoming line: a response to one of our requests (`id` + `result` | `error`), a server →
 * client request (`id` + `method`, which we must answer), and a notification (`method` only). Framing and the
 * pending-request table live here; what the messages mean is the runner's business.
 */

export type JsonRpcId = number | string;

export interface AppServerHandlers {
  onNotification(method: string, params: unknown): void;
  onRequest(id: JsonRpcId, method: string, params: unknown): void;
  /** A stdout line that is not JSON (a warning, a login hint…). */
  onText?(line: string): void;
}

const incomingSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});

/** A request the server answered with `error`; `code` is the JSON-RPC code when the server gave one. */
export class AppServerError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'AppServerError';
  }
}

export const METHOD_NOT_FOUND = -32601;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class AppServerClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<JsonRpcId, Pending>();
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly handlers: AppServerHandlers,
  ) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.onData(String(chunk)));
    stdout.on('end', () => this.flush());
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new AppServerError(method, 'app-server closed', null));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** The process is gone: every request still waiting fails with `reason`. */
  close(reason: string): void {
    this.closed = true;
    this.flush();
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new AppServerError(p.method, reason, null));
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (e) {
      logger.warn('app-server: write failed', { error: (e as Error).message });
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private flush(): void {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim()) this.onLine(rest);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.handlers.onText?.(trimmed);
      return;
    }
    const parsed = incomingSchema.safeParse(raw);
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.method !== undefined) {
      if (m.id !== undefined) this.handlers.onRequest(m.id, m.method, m.params);
      else this.handlers.onNotification(m.method, m.params);
      return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error !== undefined) p.reject(new AppServerError(p.method, m.error.message, m.error.code ?? null));
    else p.resolve(m.result);
  }
}

// --- Model catalogue ---------------------------------------------------------

const modelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().nullish(),
  hidden: z.boolean().optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).default([]),
  defaultReasoningEffort: z.string().nullish(),
  isDefault: z.boolean().optional(),
});
const modelListSchema = z.object({ data: z.array(modelSchema) });

const asEffort = (v: string | null | undefined): Effort | null => {
  const r = effortSchema.safeParse(v);
  return r.success ? r.data : null;
};

/** `model/list` → the CLI-agnostic catalogue the pickers read; efforts Styx does not know are dropped. */
export const modelCatalogue = (result: unknown): ModelInfo[] => {
  const r = modelListSchema.safeParse(result);
  if (!r.success) return [];
  return r.data.data.map((m) => ({
    id: m.id,
    label: m.displayName !== undefined && m.displayName !== '' ? m.displayName : m.id,
    description: m.description ?? null,
    efforts: m.supportedReasoningEfforts
      .map((e) => asEffort(e.reasoningEffort))
      .filter((e): e is Effort => e !== null),
    defaultEffort: asEffort(m.defaultReasoningEffort),
    isDefault: m.isDefault === true,
    hidden: m.hidden === true,
  }));
};

// --- Identity probe (Settings › Agents) ---------------------------------------

/** What `codex app-server` says about the signed-in account; labels only, never a token. */
export interface AppServerIdentity {
  authState: 'signed-in' | 'signed-out';
  account: string | null;
  models: ModelInfo[];
}

/** `Account`: `chatgpt {email, planType}` | `apiKey` | `amazonBedrock`; only the label fields are read. */
const accountReadSchema = z.object({
  account: z
    .object({ type: z.string(), email: z.string().nullish(), planType: z.string().nullish() })
    .nullable(),
});

/** `account/read` → the Agents-page label: `email · plan` for ChatGPT, `API key` otherwise; null = signed out. */
export const accountLabel = (result: unknown): { signedIn: boolean; account: string | null } => {
  const r = accountReadSchema.safeParse(result);
  if (!r.success || r.data.account === null) return { signedIn: false, account: null };
  const a = r.data.account;
  if (a.type === 'chatgpt') {
    const parts = [a.email ?? 'ChatGPT', a.planType ?? null].filter(
      (p): p is string => p !== null && p !== '',
    );
    return { signedIn: true, account: parts.join(' · ') };
  }
  if (a.type === 'apiKey') return { signedIn: true, account: 'API key' };
  return { signedIn: true, account: null };
};

// --- Rate limits (Usage page) --------------------------------------------------

/** One `RateLimitWindow` of `account/rateLimits/*`: `usedPercent` 0–100, `windowDurationMins`, `resetsAt` epoch seconds. */
const rateLimitWindowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullish(),
    resetsAt: z.number().nullish(),
  })
  .nullish();
/** `account/rateLimits/read` result and `account/rateLimits/updated` params share this shape. */
export const codexRateLimitsSchema = z.object({
  rateLimits: z.object({
    primary: rateLimitWindowSchema,
    secondary: rateLimitWindowSchema,
    planType: z.string().nullish(),
  }),
});
export type CodexRateLimits = z.infer<typeof codexRateLimitsSchema>;

/** "5 h" · "7 d" · "90 min" from a window's duration; empty when Codex gave none. */
export const windowLabel = (mins: number | null | undefined): string => {
  if (mins === null || mins === undefined) return '';
  if (mins % 1440 === 0) return fill(copy.codexRunner.windowDays, { n: mins / 1440 });
  if (mins % 60 === 0) return fill(copy.codexRunner.windowHours, { n: mins / 60 });
  return fill(copy.codexRunner.windowMinutes, { n: mins });
};

/** Codex reports resets in epoch seconds; tolerate milliseconds. */
const epochMs = (t: number): number => Math.round(t * (t < 1e12 ? 1000 : 1));

/**
 * `{rateLimits: {primary, secondary, planType}}` → the account's limits for the Usage page (primary first), or null
 * when the payload has no window. A window without a duration is labelled by position ("primary").
 */
export const codexLimits = (raw: unknown, now: number): AgentLimits | null => {
  const r = codexRateLimitsSchema.safeParse(raw);
  if (!r.success) return null;
  const { primary, secondary, planType } = r.data.rateLimits;
  const windows: AgentLimits['windows'] = [];
  for (const [w, fallback] of [
    [primary, 'primary'],
    [secondary, 'secondary'],
  ] as const) {
    if (!w) continue;
    const label = windowLabel(w.windowDurationMins) || fallback;
    windows.push({
      label,
      usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
      resetsAt: w.resetsAt === null || w.resetsAt === undefined ? null : epochMs(w.resetsAt),
    });
  }
  if (windows.length === 0) return null;
  return {
    agent: 'codex',
    plan: planType === null || planType === undefined || planType === '' ? null : planType,
    windows,
    updatedAt: now,
  };
};

export const CLIENT_INFO = { name: 'styx', title: 'Styx', version: '0.1.0' } as const;
export const CLIENT_CAPABILITIES = { experimentalApi: true, requestAttestation: false } as const;

export interface ShortLivedOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** A request bounded by the short-lived server's deadline and exit: null when either wins. */
export type BoundedRequest = <T>(p: Promise<T>) => Promise<T | null>;

/**
 * Runs `body` against a short-lived `codex app-server` (`initialize` → body → kill). Resolves null when the binary
 * has no working app-server (spawn failure, no `initialize` answer within the timeout); rejects when the server
 * answered `initialize` but `body` then failed, so the caller can say why.
 */
export async function withCodexAppServer<T>(
  bin: string,
  opts: ShortLivedOptions,
  body: (client: AppServerClient, bounded: BoundedRequest) => Promise<T | null>,
): Promise<T | null> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env))
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  env['NO_COLOR'] = '1';
  let proc: ReturnType<typeof spawnChild>;
  try {
    proc = spawnChild(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return null;
  }
  if (!proc.stdin || !proc.stdout) return null;
  proc.stderr?.on('data', () => undefined);
  proc.stdin.on('error', () => undefined);
  const client = new AppServerClient(proc.stdin, proc.stdout, {
    onNotification: () => undefined,
    onRequest: (id) => client.respondError(id, METHOD_NOT_FOUND, 'not supported during verification'),
  });
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), opts.timeoutMs ?? 15_000).unref?.();
  });
  const failed = new Promise<null>((resolve) => {
    proc.once('error', () => resolve(null));
    proc.once('close', () => {
      client.close('exited');
      resolve(null);
    });
  });
  const done = () => {
    client.close('verification finished');
    try {
      proc.stdin?.end();
      proc.kill();
    } catch {
      // already gone
    }
  };
  try {
    const init = await Promise.race([
      client
        .request('initialize', { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
        .then(() => true),
      timeout,
      failed,
    ]);
    if (init !== true) return null;
    client.notify('initialized');
    // Every step races the same deadline and the process's exit: an app-server that answers `initialize` and
    // then hangs must not leave the caller waiting for good.
    const bounded: BoundedRequest = (p) => Promise.race([p, timeout, failed]);
    return await body(client, bounded);
  } finally {
    done();
  }
}

/**
 * Asks a Codex build who it is signed in as and which models it offers, through a short-lived `codex app-server`
 * (`initialize` → `account/read` → `model/list`, then kill). Resolves null when the binary has no working
 * app-server, so the caller can fall back to `codex login status`; rejects when the server answered `initialize`
 * but then failed, so the row can say why.
 */
export const probeCodexAppServer = (
  bin: string,
  opts: ShortLivedOptions = {},
): Promise<AppServerIdentity | null> =>
  withCodexAppServer(bin, opts, async (client, bounded) => {
    const accountRes = await bounded(client.request('account/read', { refreshToken: false }));
    if (accountRes === null) return null;
    const account = accountLabel(accountRes);
    let models: ModelInfo[] = [];
    try {
      const listed = await bounded(client.request('model/list', { includeHidden: true }));
      if (listed !== null) models = modelCatalogue(listed);
    } catch (e) {
      logger.warn('codex app-server: model/list failed during verification', { error: (e as Error).message });
    }
    return { authState: account.signedIn ? 'signed-in' : 'signed-out', account: account.account, models };
  });

/**
 * Usage › Refresh: reads the account's rate limits through a short-lived app-server (`account/rateLimits/read`).
 * Null when the binary has no app-server or reported no window; only percentages, durations and reset times
 * cross this call, never a token.
 */
export const readCodexRateLimits = (
  bin: string,
  now: () => number,
  opts: ShortLivedOptions = {},
): Promise<AgentLimits | null> =>
  withCodexAppServer(bin, opts, async (client, bounded) => {
    const res = await bounded(client.request('account/rateLimits/read'));
    return res === null ? null : codexLimits(res, now());
  });
