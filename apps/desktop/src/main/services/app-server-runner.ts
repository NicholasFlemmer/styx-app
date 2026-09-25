import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  copy,
  effortSchema,
  fill,
  permissionModeSchema,
  type Effort,
  type MessagePayload,
  type PermissionMode,
} from '@styx/core';
import { z } from 'zod';
import { codexPolicy } from '../agents/codex';
import {
  AppServerClient,
  CLIENT_CAPABILITIES,
  CLIENT_INFO,
  codexLimits,
  codexRateLimitsSchema,
  METHOD_NOT_FOUND,
  modelCatalogue,
  windowLabel,
  type JsonRpcId,
} from './app-server-client';
import { logger } from './logger';
import {
  cloudCliByFullPath,
  relPath,
  toolHint,
  type ImageBlock,
  type StreamEvents,
  type StreamRunnerLike,
  type StreamSpawnOptions,
} from './stream-runner';

/** Handshake steps (initialize, thread start) must answer within this; otherwise the session errors out. */
const HANDSHAKE_MS = 30_000;
const withDeadline = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)),
      ms,
    );
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: Error) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/**
 * Stream backend for Codex `codex app-server` (ADR-0016; docs/research/agent-parity.md §2.4, §5): JSON-RPC 2.0 over
 * child_process pipes, registered on the RunnerMux for `app-server` launches. One process per session: `initialize`
 * → `model/list` → `thread/start` (or `thread/resume` on a relaunch) → `turn/start` per user message, `turn/steer`
 * while a turn is running. Notifications become the same `StreamEffect`s the Claude runner emits, so the chat pane,
 * board and state machine work unchanged; server → client requests (approvals, questions) become `permission`
 * effects the session service turns into asks and answers through `respondPermission`.
 */

// --- Incoming message shapes (only what the runner consumes; loose on purpose) ----

const itemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('userMessage'), id: z.string() }),
  z.object({ type: z.literal('agentMessage'), id: z.string(), text: z.string().default('') }),
  z.object({
    type: z.literal('reasoning'),
    id: z.string(),
    summary: z.array(z.string()).default([]),
    content: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal('commandExecution'),
    id: z.string(),
    command: z.string().default(''),
    cwd: z.string().default(''),
    status: z.string().default('inProgress'),
    aggregatedOutput: z.string().nullish(),
    exitCode: z.number().nullish(),
  }),
  z.object({
    type: z.literal('fileChange'),
    id: z.string(),
    changes: z.array(z.object({ path: z.string(), diff: z.string().default('') })).default([]),
    status: z.string().default('inProgress'),
  }),
  z.object({
    type: z.literal('mcpToolCall'),
    id: z.string(),
    server: z.string().default(''),
    tool: z.string().default(''),
    status: z.string().default('inProgress'),
    arguments: z.unknown().optional(),
    error: z.object({ message: z.string() }).nullish(),
  }),
  z.object({ type: z.literal('webSearch'), id: z.string(), query: z.string().default('') }),
  z.object({ type: z.literal('plan'), id: z.string(), text: z.string().default('') }),
  z.object({ type: z.literal('contextCompaction'), id: z.string() }),
]);
type Item = z.infer<typeof itemSchema>;

/** `item/started` / `item/completed`: the item is parsed apart so an unknown item type is ignored, not the event. */
const itemEventSchema = z.object({ item: z.unknown(), turnId: z.string().optional() });
const parseItem = (raw: unknown): Item | null => {
  const r = itemSchema.safeParse(raw);
  return r.success ? r.data : null;
};
const deltaSchema = z.object({ itemId: z.string(), delta: z.string() });
const summaryPartSchema = z.object({ itemId: z.string(), summaryIndex: z.number().optional() });
const turnSchema = z.object({
  id: z.string(),
  status: z.string().default('inProgress'),
  error: z.object({ message: z.string() }).nullish(),
  durationMs: z.number().nullish(),
});
const turnEventSchema = z.object({ turn: turnSchema });
const tokenUsageSchema = z.object({
  tokenUsage: z.object({
    total: z.object({ totalTokens: z.number() }),
    modelContextWindow: z.number().nullish(),
  }),
});
const errorNotificationSchema = z.object({
  error: z.object({ message: z.string() }),
  willRetry: z.boolean().default(false),
});
const mcpStatusSchema = z.object({
  name: z.string(),
  status: z.string().default(''),
  error: z.string().nullish(),
});
const threadResponseSchema = z.object({ thread: z.object({ id: z.string() }), model: z.string().nullish() });
const turnResponseSchema = z.object({ turn: z.object({ id: z.string() }) });

const commandApprovalSchema = z.object({
  itemId: z.string(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  reason: z.string().nullish(),
});
const fileChangeApprovalSchema = z.object({ itemId: z.string(), reason: z.string().nullish() });
const userInputOptionSchema = z.union([
  z.object({ label: z.string(), description: z.string().nullish() }),
  z.string(),
]);
const userInputSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string().default(''),
      question: z.string(),
      isSecret: z.boolean().default(false),
      options: z.array(userInputOptionSchema).nullish(),
    }),
  ),
});
const permissionsApprovalSchema = z.object({
  reason: z.string().nullish(),
  permissions: z.record(z.string(), z.unknown()).default({}),
});

// --- Helpers -----------------------------------------------------------------

const crlf = (s: string): string => `${s.replace(/\r?\n/g, '\r\n')}\r\n`;
const firstLine = (s: string, max = 200): string => {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const lastLines = (s: string, n: number): string => {
  const lines = s.replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
};
const HINT_MAX = 100;
const OUTPUT_TAIL_LINES = 30;
const RATE_LIMIT_NOTE_PERCENT = 80;
export const CODEX_SLASH_COMMANDS = ['/compact', '/review'] as const;

/** `+n −m` of a unified diff (added / removed lines, headers excluded). */
const diffCounts = (diff: string): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
};

/** `resetsAt` is epoch seconds; shown as local HH:MM. */
const resetLabel = (secs: number | null | undefined): string => {
  if (secs === null || secs === undefined) return '';
  const d = new Date(secs * (secs < 1e12 ? 1000 : 1));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The rate-limit note for a window worth mentioning (above 80% used), else null. */
export const rateLimitNote = (
  w:
    | {
        usedPercent: number;
        windowDurationMins?: number | null | undefined;
        resetsAt?: number | null | undefined;
      }
    | null
    | undefined,
): string | null => {
  if (!w || w.usedPercent <= RATE_LIMIT_NOTE_PERCENT) return null;
  return fill(copy.codexRunner.rateLimit, {
    window: windowLabel(w.windowDurationMins),
    percent: Math.round(w.usedPercent),
    resets: resetLabel(w.resetsAt),
  });
};

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// --- Process abstraction (injectable for tests) ------------------------------

export interface AppServerProcess {
  pid?: number | undefined;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(): boolean;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  once(event: 'close', listener: (code: number | null) => void): this;
}

export type AppServerSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide: boolean;
  },
) => AppServerProcess;

const defaultSpawn: AppServerSpawn = (command, args, options) => spawnChild(command, [...args], options);

// --- Runner ------------------------------------------------------------------

type PendingServerRequest = { id: JsonRpcId } & (
  | { kind: 'command' }
  | { kind: 'fileChange' }
  | { kind: 'userInput'; questions: { id: string; question: string }[] }
  | { kind: 'permissions'; permissions: Record<string, unknown> }
);

interface Settings {
  model: string | null;
  effort: Effort | null;
  mode: PermissionMode;
  roots: string[];
  resumeSessionId: string | null;
}

interface Entry {
  opts: StreamSpawnOptions;
  settings: Settings;
  proc: AppServerProcess | null;
  client: AppServerClient | null;
  threadId: string | null;
  /** The turn in progress (`turn/started` … `turn/completed`); steering and interrupt need it. */
  turnId: string | null;
  /** Messages sent before the thread existed; flushed after `thread/start`. */
  queued: { text: string; blocks: readonly ImageBlock[] }[];
  /** Server requests waiting on an ask, by JSON-RPC id as a string. */
  pending: Map<string, PendingServerRequest>;
  /** Live stream keys (agent text by item id, reasoning by `<id>:thinking`). */
  live: Set<string>;
  /** Reasoning items that received at least one summary part (a later part is separated by a blank line). */
  reasoningParts: Map<string, number>;
  /** Worktree-relative paths per fileChange item (the approval request names only the item). */
  fileChanges: Map<string, string[]>;
  /** Commands per commandExecution item (a `writeStdin` approval names only the item). */
  commands: Map<string, string>;
  tokens: { total: number | null; contextWindow: number | null };
  turns: number;
  imageDir: string | null;
  images: number;
  killed: boolean;
}

const effortOrNull = (v: string | null): Effort | null => {
  const r = effortSchema.safeParse(v);
  return r.success ? r.data : null;
};

const modeOrDefault = (v: string): PermissionMode => {
  const r = permissionModeSchema.safeParse(v);
  return r.success ? r.data : 'default';
};

/** `RequestPermissionProfile` has nullable members; `GrantedPermissionProfile` wants them absent instead. */
const stripNulls = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

export class AppServerRunner extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly spawnFn: AppServerSpawn = defaultSpawn) {
    super();
  }

  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    const s = opts.session;
    const entry: Entry = {
      opts,
      settings: {
        model: s?.model ?? null,
        effort: s?.effort ?? null,
        mode: s?.permissionMode ?? 'default',
        // The worktree only (docs/adr/0016): the project's main checkout is not a writable root.
        roots: [opts.worktreePath],
        resumeSessionId: s?.resumeSessionId ?? null,
      },
      proc: null,
      client: null,
      threadId: null,
      turnId: null,
      queued: [],
      pending: new Map(),
      live: new Set(),
      reasoningParts: new Map(),
      fileChanges: new Map(),
      commands: new Map(),
      tokens: { total: null, contextWindow: null },
      turns: 0,
      imageDir: null,
      images: 0,
      killed: false,
    };
    this.entries.set(opts.id, entry);
    const pid = await this.start(entry);
    void this.handshake(entry);
    return { pid };
  }

  private start(entry: Entry): Promise<number> {
    const { opts } = entry;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    Object.assign(env, { NO_COLOR: '1', TERM: 'dumb' }, opts.env);
    const proc = this.spawnFn(opts.command, opts.args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    entry.proc = proc;
    if (proc.stdin && proc.stdout) {
      entry.client = new AppServerClient(proc.stdin, proc.stdout, {
        onNotification: (method, params) => this.onNotification(entry, method, params),
        onRequest: (id, method, params) => this.onServerRequest(entry, id, method, params),
        onText: (line) => this.emit('effect', opts.id, { type: 'render', text: crlf(line) }),
      });
    }
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) this.emit('effect', opts.id, { type: 'render', text: crlf(text) });
    });
    proc.stdin?.on('error', () => undefined);
    return new Promise<number>((resolve, reject) => {
      let started = false;
      proc.once('spawn', () => {
        started = true;
        resolve(proc.pid ?? 0);
      });
      proc.once('error', (err: NodeJS.ErrnoException) => {
        logger.warn('app-server runner error', { id: opts.id, error: err.message });
        if (!started) {
          this.entries.delete(opts.id);
          reject(err);
        }
      });
      proc.once('close', (code) => this.onClose(entry, proc, code));
    });
  }

  private onClose(entry: Entry, proc: AppServerProcess, code: number | null): void {
    if (entry.proc !== proc) return;
    entry.proc = null;
    entry.client?.close('app-server exited');
    entry.client = null;
    for (const key of entry.live) this.emit('effect', entry.opts.id, { type: 'streamStop', key });
    entry.live.clear();
    entry.pending.clear();
    if (entry.imageDir !== null) {
      try {
        rmSync(entry.imageDir, { recursive: true, force: true });
      } catch {
        // best effort: a temp dir
      }
      entry.imageDir = null;
    }
    this.entries.delete(entry.opts.id);
    this.emit('exit', entry.opts.id, code);
  }

  // --- Handshake --------------------------------------------------------------

  private async handshake(entry: Entry): Promise<void> {
    const { opts, settings } = entry;
    const client = entry.client;
    if (!client) return;
    try {
      // A CLI that never answers (first-run prompt, wrong build) must not leave the session "working" for good.
      await withDeadline(
        client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES }),
        HANDSHAKE_MS,
        'initialize',
      );
      client.notify('initialized');
      try {
        const models = modelCatalogue(await client.request('model/list', { includeHidden: true }));
        if (models.length > 0) this.emit('effect', opts.id, { type: 'catalogue', models });
      } catch (e) {
        logger.warn('codex app-server: model/list failed', { id: opts.id, error: (e as Error).message });
      }
      const policy = codexPolicy(settings.mode, settings.roots);
      const threadParams = {
        cwd: opts.worktreePath,
        ...(settings.model !== null ? { model: settings.model } : {}),
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandbox: policy.sandboxMode,
        ...(settings.effort !== null ? { config: { model_reasoning_effort: settings.effort } } : {}),
      };
      let thread: z.infer<typeof threadResponseSchema> | null = null;
      if (settings.resumeSessionId !== null) {
        try {
          thread = threadResponseSchema.parse(
            await client.request('thread/resume', { threadId: settings.resumeSessionId, ...threadParams }),
          );
        } catch (e) {
          logger.warn('codex app-server: thread/resume failed, starting a new thread', {
            id: opts.id,
            error: (e as Error).message,
          });
          thread = null;
        }
      }
      if (thread === null)
        thread = threadResponseSchema.parse(
          await withDeadline(client.request('thread/start', threadParams), HANDSHAKE_MS, 'thread/start'),
        );
      if (!this.entries.has(opts.id)) return; // killed while starting
      entry.threadId = thread.thread.id;
      const model = thread.model ?? settings.model;
      this.emit('effect', opts.id, {
        type: 'init',
        chatId: thread.thread.id,
        model,
        permissionMode: settings.mode,
        slashCommands: [...CODEX_SLASH_COMMANDS],
      });
      this.emit('effect', opts.id, { type: 'session', event: 'activity' });
      this.emit('effect', opts.id, {
        type: 'render',
        text: crlf(`· session started${model ? ` · ${model}` : ''}`),
      });
      if (opts.firstMessage) this.startTurn(entry, this.buildInput(entry, opts.firstMessage, []));
      const queued = entry.queued.splice(0);
      for (const q of queued) this.send(opts.id, q.text, q.blocks);
    } catch (e) {
      const message = (e as Error).message;
      logger.warn('codex app-server: handshake failed', { id: opts.id, error: message });
      this.emit('effect', opts.id, { type: 'error', message });
      this.emit('effect', opts.id, { type: 'render', text: crlf(`! ${firstLine(message)}`) });
      this.kill(opts.id);
    }
  }

  // --- Turns ------------------------------------------------------------------

  private turnSettings(entry: Entry): Record<string, unknown> {
    const { settings } = entry;
    const policy = codexPolicy(settings.mode, settings.roots);
    return {
      ...(settings.model !== null ? { model: settings.model } : {}),
      ...(settings.effort !== null ? { effort: settings.effort } : {}),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      approvalsReviewer: policy.approvalsReviewer,
    };
  }

  private buildInput(entry: Entry, text: string, blocks: readonly ImageBlock[]): unknown[] {
    const input: unknown[] = [];
    for (const b of blocks) {
      const path = this.writeImage(entry, b);
      if (path !== null) input.push({ type: 'localImage', path });
    }
    input.push({ type: 'text', text, text_elements: [] });
    return input;
  }

  /** Codex takes images by path: the block's bytes land in a per-session temp dir (removed on exit). */
  private writeImage(entry: Entry, block: ImageBlock): string | null {
    try {
      if (entry.imageDir === null) {
        entry.imageDir = join(tmpdir(), `styx-${entry.opts.id}`);
        mkdirSync(entry.imageDir, { recursive: true, mode: 0o700 });
      }
      entry.images += 1;
      const ext = IMAGE_EXT[block.source.media_type] ?? 'bin';
      const path = join(entry.imageDir, `image-${entry.images}.${ext}`);
      writeFileSync(path, Buffer.from(block.source.data, 'base64'));
      return path;
    } catch (e) {
      logger.warn('codex app-server: could not write image', {
        id: entry.opts.id,
        error: (e as Error).message,
      });
      return null;
    }
  }

  private startTurn(entry: Entry, input: unknown[]): void {
    const { client, threadId } = entry;
    if (!client || threadId === null) return;
    this.emit('effect', entry.opts.id, { type: 'session', event: 'activity' });
    client
      .request('turn/start', { threadId, input, ...this.turnSettings(entry) })
      .then((r) => {
        const parsed = turnResponseSchema.safeParse(r);
        if (parsed.success) entry.turnId = parsed.data.turn.id;
      })
      .catch((e: Error) => this.turnFailed(entry, e.message));
  }

  /** A message while a turn is running steers it (Codex has this; Claude drops the input); a stale turn id restarts. */
  private steer(entry: Entry, input: unknown[], expectedTurnId: string): void {
    const { client, threadId } = entry;
    if (!client || threadId === null) return;
    this.emit('effect', entry.opts.id, { type: 'session', event: 'activity' });
    client.request('turn/steer', { threadId, input, expectedTurnId }).catch((e: Error) => {
      logger.info('codex app-server: steer failed, starting a turn', { id: entry.opts.id, error: e.message });
      this.startTurn(entry, input);
    });
  }

  private turnFailed(entry: Entry, message: string): void {
    this.emit('effect', entry.opts.id, { type: 'error', message });
    this.emit('effect', entry.opts.id, { type: 'render', text: crlf(`! ${firstLine(message)}`) });
    this.emit('effect', entry.opts.id, { type: 'session', event: 'quiet' });
  }

  /** Codex takes images (as local paths Styx writes for it). */
  acceptsImages(id: string): boolean {
    return this.entries.has(id);
  }

  send(id: string, text: string, blocks: readonly ImageBlock[] = []): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.threadId === null || !entry.client) {
      entry.queued.push({ text, blocks });
      return;
    }
    const trimmed = text.trim();
    if (trimmed === '/compact') {
      this.emit('effect', id, { type: 'render', text: crlf(`· ${copy.codexRunner.compacting}`) });
      entry.client
        .request('thread/compact/start', { threadId: entry.threadId })
        .catch((e: Error) => this.turnFailed(entry, e.message));
      return;
    }
    if (trimmed === '/review') {
      this.emit('effect', id, { type: 'render', text: crlf(`· ${copy.codexRunner.reviewing}`) });
      this.emit('effect', id, { type: 'session', event: 'activity' });
      entry.client
        .request('review/start', { threadId: entry.threadId, target: { type: 'uncommittedChanges' } })
        .then((r) => {
          const parsed = turnResponseSchema.safeParse(r);
          if (parsed.success) entry.turnId = parsed.data.turn.id;
        })
        .catch((e: Error) => this.turnFailed(entry, e.message));
      return;
    }
    const input = this.buildInput(entry, text, blocks);
    if (entry.turnId !== null) this.steer(entry, input, entry.turnId);
    else this.startTurn(entry, input);
  }

  // --- Server requests → asks ---------------------------------------------------

  private onServerRequest(entry: Entry, id: JsonRpcId, method: string, params: unknown): void {
    const { client } = entry;
    if (!client) return;
    const requestId = String(id);
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = commandApprovalSchema.safeParse(params);
        if (!p.success) return client.respondError(id, -32602, 'invalid params');
        entry.pending.set(requestId, { id, kind: 'command' });
        const command = p.data.command ?? entry.commands.get(p.data.itemId) ?? '';
        this.permission(entry, requestId, 'Bash', {
          command,
          cwd: p.data.cwd ?? entry.opts.worktreePath,
          ...(p.data.reason ? { description: p.data.reason } : {}),
        });
        return;
      }
      case 'item/fileChange/requestApproval': {
        const p = fileChangeApprovalSchema.safeParse(params);
        if (!p.success) return client.respondError(id, -32602, 'invalid params');
        entry.pending.set(requestId, { id, kind: 'fileChange' });
        const paths = entry.fileChanges.get(p.data.itemId) ?? [];
        this.permission(entry, requestId, 'Edit', {
          file_path: paths[0] ?? '',
          ...(paths.length > 1 ? { paths } : {}),
          ...(p.data.reason ? { reason: p.data.reason } : {}),
        });
        return;
      }
      case 'item/tool/requestUserInput': {
        const p = userInputSchema.safeParse(params);
        if (!p.success) return client.respondError(id, -32602, 'invalid params');
        entry.pending.set(requestId, {
          id,
          kind: 'userInput',
          questions: p.data.questions.map((q) => ({ id: q.id, question: q.question })),
        });
        this.permission(entry, requestId, 'AskUserQuestion', {
          questions: p.data.questions.map((q) => ({
            question: q.question,
            header: q.header,
            multiSelect: false,
            options: (q.options ?? []).map((o) =>
              typeof o === 'string'
                ? { label: o, description: null }
                : { label: o.label, description: o.description ?? null },
            ),
            secret: q.isSecret,
          })),
        });
        return;
      }
      case 'item/permissions/requestApproval': {
        const p = permissionsApprovalSchema.safeParse(params);
        if (!p.success) return client.respondError(id, -32602, 'invalid params');
        entry.pending.set(requestId, { id, kind: 'permissions', permissions: p.data.permissions });
        this.permission(entry, requestId, 'Permissions', {
          reason: p.data.reason ?? '',
          permissions: p.data.permissions,
        });
        return;
      }
      case 'mcpServer/elicitation/request':
        // Third-party MCP forms have no renderer in Styx: declined straight away, the tool sees a cancel.
        client.respond(id, { action: 'cancel', content: null, _meta: null });
        return;
      default:
        client.respondError(id, METHOD_NOT_FOUND, fill(copy.codexRunner.unsupported, { method }));
        return;
    }
  }

  private permission(
    entry: Entry,
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    this.emit('effect', entry.opts.id, { type: 'permission', requestId, toolName, input });
    this.emit('effect', entry.opts.id, { type: 'render', text: crlf(`? permission: ${toolName}`) });
  }

  respondPermission(
    id: string,
    requestId: string,
    allow: boolean,
    _message?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    const entry = this.entries.get(id);
    const req = entry?.pending.get(requestId);
    if (!entry?.client || !req) return;
    entry.pending.delete(requestId);
    switch (req.kind) {
      case 'command':
      case 'fileChange': {
        const decision = !allow
          ? 'decline'
          : updatedInput?.['always'] === true
            ? 'acceptForSession'
            : 'accept';
        entry.client.respond(req.id, { decision });
        return;
      }
      case 'userInput': {
        // Styx answers by question text; Codex wants them by question id, one string each.
        const given = updatedInput?.['answers'];
        const byText =
          given !== null && typeof given === 'object' && !Array.isArray(given)
            ? (given as Record<string, unknown>)
            : {};
        const answers: Record<string, { answers: string[] }> = {};
        if (allow)
          for (const q of req.questions) {
            const a = byText[q.question];
            answers[q.id] = { answers: typeof a === 'string' && a !== '' ? [a] : [] };
          }
        entry.client.respond(req.id, { answers });
        return;
      }
      case 'permissions': {
        entry.client.respond(req.id, {
          permissions: allow ? stripNulls(req.permissions) : {},
          scope: 'turn',
        });
        return;
      }
    }
  }

  // --- Notifications → effects ---------------------------------------------------

  private onNotification(entry: Entry, method: string, params: unknown): void {
    const id = entry.opts.id;
    switch (method) {
      case 'turn/started': {
        const p = turnEventSchema.safeParse(params);
        if (p.success) entry.turnId = p.data.turn.id;
        this.emit('effect', id, { type: 'session', event: 'activity' });
        return;
      }
      case 'turn/completed':
        this.turnCompleted(entry, params);
        return;
      case 'item/started': {
        const p = itemEventSchema.safeParse(params);
        const item = p.success ? parseItem(p.data.item) : null;
        if (item !== null) this.itemStarted(entry, item);
        return;
      }
      case 'item/completed': {
        const p = itemEventSchema.safeParse(params);
        const item = p.success ? parseItem(p.data.item) : null;
        if (item !== null) this.itemCompleted(entry, item);
        return;
      }
      case 'item/agentMessage/delta': {
        const p = deltaSchema.safeParse(params);
        if (!p.success) return;
        this.streamDelta(entry, p.data.itemId, 'text', p.data.delta);
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const p = deltaSchema.safeParse(params);
        if (!p.success) return;
        this.streamDelta(entry, `${p.data.itemId}:thinking`, 'thinking', p.data.delta);
        return;
      }
      case 'item/reasoning/summaryPartAdded': {
        const p = summaryPartSchema.safeParse(params);
        if (!p.success) return;
        const n = entry.reasoningParts.get(p.data.itemId) ?? 0;
        entry.reasoningParts.set(p.data.itemId, n + 1);
        if (n > 0 && entry.live.has(`${p.data.itemId}:thinking`))
          this.emit('effect', id, { type: 'streamDelta', key: `${p.data.itemId}:thinking`, text: '\n\n' });
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const p = deltaSchema.safeParse(params);
        if (p.success)
          this.emit('effect', id, { type: 'render', text: p.data.delta.replace(/\r?\n/g, '\r\n') });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const p = tokenUsageSchema.safeParse(params);
        if (!p.success) return;
        entry.tokens = {
          total: p.data.tokenUsage.total.totalTokens,
          contextWindow: p.data.tokenUsage.modelContextWindow ?? entry.tokens.contextWindow,
        };
        return;
      }
      case 'account/rateLimits/updated': {
        const p = codexRateLimitsSchema.safeParse(params);
        if (!p.success) return;
        // The Usage page keeps the whole report; the chat only hears about a window that is nearly used up.
        const limits = codexLimits(p.data, Date.now());
        if (limits !== null) this.emit('effect', id, { type: 'limits', limits });
        const note = rateLimitNote(p.data.rateLimits.primary) ?? rateLimitNote(p.data.rateLimits.secondary);
        if (note !== null) {
          this.emit('effect', id, { type: 'note', note });
          this.emit('effect', id, { type: 'render', text: crlf(`· ${note}`) });
        }
        return;
      }
      case 'error': {
        const p = errorNotificationSchema.safeParse(params);
        if (!p.success) return;
        const message = p.data.willRetry
          ? fill(copy.codexRunner.willRetry, { message: p.data.error.message })
          : p.data.error.message;
        this.emit('effect', id, { type: 'error', message });
        this.emit('effect', id, { type: 'render', text: crlf(`! ${firstLine(message)}`) });
        return;
      }
      case 'mcpServer/startupStatus/updated': {
        const p = mcpStatusSchema.safeParse(params);
        if (!p.success || p.data.name !== 'styx') return;
        const error = p.data.error ?? (p.data.status === 'failed' ? p.data.status : null);
        if (error === null) return;
        const message = fill(copy.codexRunner.mcpStartupFailed, { error });
        this.emit('effect', id, { type: 'error', message });
        this.emit('effect', id, { type: 'render', text: crlf(`! ${message}`) });
        return;
      }
      default:
        // thread/status/changed (asks drive needs-you), thread/started, settings, diffs, plans-in-progress…
        return;
    }
  }

  private streamDelta(entry: Entry, key: string, kind: 'text' | 'thinking', text: string): void {
    const id = entry.opts.id;
    if (!entry.live.has(key)) {
      entry.live.add(key);
      this.emit('effect', id, { type: 'streamStart', key, kind });
    }
    if (text !== '') this.emit('effect', id, { type: 'streamDelta', key, text });
  }

  private toolRow(entry: Entry, itemId: string, tool: string, hint: string): void {
    const id = entry.opts.id;
    const line = `${tool}${hint ? ` ${hint}` : ''}`;
    const payload: MessagePayload = {
      kind: 'tool',
      tool,
      hint,
      toolUseId: itemId,
      status: 'running',
      detail: null,
    };
    this.emit('effect', id, { type: 'transcript', body: line, payload });
    this.emit('effect', id, { type: 'render', text: crlf(`▸ ${line}`) });
  }

  private itemStarted(entry: Entry, item: Item): void {
    const id = entry.opts.id;
    switch (item.type) {
      case 'commandExecution': {
        entry.commands.set(item.id, item.command);
        this.emit('effect', id, { type: 'session', event: 'activity' });
        this.toolRow(
          entry,
          item.id,
          'Bash',
          toolHint(entry.opts.worktreePath, 'Bash', { command: item.command }),
        );
        const bypassed = cloudCliByFullPath(item.command);
        if (bypassed !== null) {
          const warning = fill(copy.chat.controls.bypassWarning, { cli: bypassed });
          this.emit('effect', id, { type: 'transcript', body: warning, payload: { kind: 'system' } });
          this.emit('effect', id, { type: 'render', text: crlf(`! ${warning}`) });
        }
        return;
      }
      case 'fileChange': {
        const paths = [...new Set(item.changes.map((c) => relPath(entry.opts.worktreePath, c.path)))];
        entry.fileChanges.set(item.id, paths);
        this.emit('effect', id, { type: 'session', event: 'activity' });
        this.toolRow(entry, item.id, 'Edit', firstLine(paths.join(', '), HINT_MAX));
        if (item.changes.length > 0) {
          const files = item.changes.map((c) => ({
            path: relPath(entry.opts.worktreePath, c.path),
            ...diffCounts(c.diff),
          }));
          this.emit('effect', id, {
            type: 'transcript',
            body: files.map((f) => f.path).join(', '),
            payload: { kind: 'file-list', files },
          });
        }
        return;
      }
      case 'mcpToolCall': {
        this.emit('effect', id, { type: 'session', event: 'activity' });
        const args =
          item.arguments !== null && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
            ? (item.arguments as Record<string, unknown>)
            : {};
        const name = `mcp__${item.server}__${item.tool}`;
        this.toolRow(entry, item.id, name, toolHint(entry.opts.worktreePath, name, args));
        return;
      }
      case 'webSearch':
        this.emit('effect', id, { type: 'session', event: 'activity' });
        this.toolRow(entry, item.id, 'WebSearch', firstLine(item.query, HINT_MAX));
        return;
      default:
        // userMessage (Styx already appended the user row), agentMessage / reasoning (their deltas open the
        // stream), plan (complete text arrives on completion), contextCompaction (noted on completion).
        return;
    }
  }

  private itemCompleted(entry: Entry, item: Item): void {
    const id = entry.opts.id;
    switch (item.type) {
      case 'agentMessage': {
        const text = item.text.trim();
        if (entry.live.delete(item.id)) {
          this.emit('effect', id, { type: 'streamStop', key: item.id });
          this.emit('effect', id, { type: 'streamFinal', key: item.id, body: text });
        } else if (text) {
          this.emit('effect', id, { type: 'transcript', body: text, payload: { kind: 'agent' } });
        }
        if (text) {
          this.emit('effect', id, { type: 'note', note: firstLine(text) });
          this.emit('effect', id, { type: 'render', text: crlf(text) });
        }
        return;
      }
      case 'reasoning': {
        const key = `${item.id}:thinking`;
        const body = (item.summary.length > 0 ? item.summary : item.content).join('\n\n');
        entry.reasoningParts.delete(item.id);
        if (entry.live.delete(key)) {
          this.emit('effect', id, { type: 'streamStop', key });
          this.emit('effect', id, { type: 'streamFinal', key, body });
        } else if (body.trim()) {
          this.emit('effect', id, {
            type: 'transcript',
            body,
            payload: { kind: 'thinking', status: 'done', durationMs: null },
          });
        }
        return;
      }
      case 'commandExecution': {
        entry.commands.delete(item.id);
        const ok = item.status === 'completed' && item.exitCode === 0;
        const output = (item.aggregatedOutput ?? '').trim();
        const detail =
          output !== ''
            ? lastLines(output, OUTPUT_TAIL_LINES)
            : item.exitCode !== null && item.exitCode !== undefined
              ? `exit ${item.exitCode}`
              : item.status !== 'completed'
                ? item.status
                : null;
        this.emit('effect', id, { type: 'toolResult', toolUseId: item.id, ok, detail });
        this.emit('effect', id, {
          type: 'render',
          text: crlf(
            `  ${ok ? '✓' : '!'} ${item.status}${item.exitCode !== null && item.exitCode !== undefined ? ` · exit ${item.exitCode}` : ''}`,
          ),
        });
        return;
      }
      case 'fileChange': {
        entry.fileChanges.delete(item.id);
        const ok = item.status === 'completed';
        this.emit('effect', id, {
          type: 'toolResult',
          toolUseId: item.id,
          ok,
          detail: ok ? null : item.status,
        });
        this.emit('effect', id, { type: 'render', text: crlf(`  ${ok ? '✓' : '!'} ${item.status}`) });
        this.emit('effect', id, { type: 'rescan' });
        return;
      }
      case 'mcpToolCall': {
        const error = item.error?.message ?? null;
        const ok = error === null && item.status !== 'failed';
        const detail = error !== null ? firstLine(error, 160) : ok ? null : item.status;
        this.emit('effect', id, { type: 'toolResult', toolUseId: item.id, ok, detail });
        if (detail) this.emit('effect', id, { type: 'render', text: crlf(`  ! ${detail}`) });
        return;
      }
      case 'webSearch':
        this.emit('effect', id, { type: 'toolResult', toolUseId: item.id, ok: true, detail: null });
        return;
      case 'plan': {
        const text = item.text.trim();
        if (!text) return;
        this.emit('effect', id, { type: 'transcript', body: text, payload: { kind: 'agent' } });
        this.emit('effect', id, { type: 'note', note: firstLine(text) });
        this.emit('effect', id, { type: 'render', text: crlf(text) });
        return;
      }
      case 'contextCompaction':
        this.emit('effect', id, {
          type: 'transcript',
          body: copy.chat.controls.compacted,
          payload: { kind: 'system' },
        });
        this.emit('effect', id, { type: 'render', text: crlf(`· ${copy.chat.controls.compacted}`) });
        return;
      default:
        return;
    }
  }

  private turnCompleted(entry: Entry, params: unknown): void {
    const id = entry.opts.id;
    const p = turnEventSchema.safeParse(params);
    const turn = p.success ? p.data.turn : null;
    entry.turnId = null;
    entry.turns += 1;
    if (turn?.status === 'failed') {
      const message = turn.error?.message ?? 'turn failed';
      this.emit('effect', id, { type: 'error', message });
      this.emit('effect', id, { type: 'render', text: crlf(`! ${firstLine(message)}`) });
    } else {
      const ms = turn?.durationMs ?? null;
      this.emit('effect', id, {
        type: 'render',
        text: crlf(
          `— ${turn?.status === 'interrupted' ? 'interrupted' : 'done'}${ms !== null ? ` in ${(ms / 1000).toFixed(1)}s` : ''}`,
        ),
      });
    }
    // Any block still open is stopped so no row streams forever.
    for (const key of entry.live) this.emit('effect', id, { type: 'streamStop', key });
    entry.live.clear();
    entry.reasoningParts.clear();
    this.emit('effect', id, {
      type: 'usage',
      costUsd: null,
      numTurns: entry.turns,
      durationMs: turn?.durationMs ?? null,
      tokensUsed: entry.tokens.total,
      contextWindow: entry.tokens.contextWindow,
    });
    this.emit('effect', id, { type: 'session', event: 'quiet' });
  }

  // --- Controls -----------------------------------------------------------------

  setModel(id: string, model: string | null): void {
    const entry = this.entries.get(id);
    if (entry) entry.settings.model = model;
  }

  setPermissionMode(id: string, mode: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.settings.mode = modeOrDefault(mode);
  }

  setEffort(id: string, effort: string | null): void {
    const entry = this.entries.get(id);
    if (entry) entry.settings.effort = effortOrNull(effort);
  }

  interrupt(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.client || entry.threadId === null || entry.turnId === null) return;
    // Nothing the user stopped may still run on a later Allow: every open approval is declined first.
    for (const requestId of [...entry.pending.keys()]) this.respondPermission(id, requestId, false);
    entry.client
      .request('turn/interrupt', { threadId: entry.threadId, turnId: entry.turnId })
      .catch((e: Error) => logger.warn('codex app-server: interrupt failed', { id, error: e.message }));
  }

  kill(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.killed = true;
    if (entry.proc) {
      try {
        entry.proc.stdin?.end();
      } catch {
        // stdin already closed
      }
      entry.proc.kill();
      return;
    }
    this.entries.delete(id);
    this.emit('exit', id, null);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id);
  }
}
