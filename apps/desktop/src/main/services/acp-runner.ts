import type { ChildProcess } from 'node:child_process';
import { killTree, spawnCli } from './spawn-cli';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  AGENT_LABEL,
  copy,
  fill,
  permissionModeSchema,
  type ModelInfo,
  type PermissionMode,
} from '@styx/core';
import type { McpServerEntry } from '../agents/types';
import { logger } from './logger';
import {
  toolHint,
  type ImageBlock,
  type SpawnFn,
  type StreamBlockKind,
  type StreamEffect,
  type StreamEvents,
  type StreamRunnerLike,
  type StreamSpawnOptions,
} from './stream-runner';

/** Handshake steps (initialize, session/new, session/load) must answer within this. */
const HANDSHAKE_MS = 30_000;

/**
 * ADR-0017 stream backend for the Agent Client Protocol (`gemini --acp`, `agent acp`): newline-delimited JSON-RPC 2.0
 * over child_process pipes, one process per session, registered on the RunnerMux for `acp` launches.
 *
 * Styx is the ACP *client*: it sends `initialize` → `session/new` | `session/load` → `session/prompt`, answers the
 * agent's `session/request_permission` requests, and turns `session/update` notifications into the same
 * `StreamEffect`s the Claude runner emits (streamed text and thoughts, tool rows with results, usage, quiet). The
 * styx MCP server travels in-band (`session/new.mcpServers`), so nothing is written into the worktree on this
 * path. File-system and terminal client capabilities are not advertised; a request for them is answered with a
 * JSON-RPC "method not found" so the agent uses its own tools.
 *
 * Protocol version 1 is what the shipping CLIs speak (Gemini CLI 0.39, Cursor agent); v2 shapes that differ only in
 * field names (`capabilities`/`info`, mode as a config option, `plan_update`) are accepted where the cost is a
 * line. Neither CLI was installed on the verifying machine: the mapping is verified against the protocol spec and
 * the fake agent in `acp-runner.test.ts` / `e2e/fixtures/bin/gemini` (see the ADR).
 */

// --- Wire schemas (compact: method + the fields Styx reads) ----------------

const rpcIdSchema = z.union([z.number(), z.string()]);
/** `code` is optional: an agent that answers with `{message}` alone must still reject the pending request. */
const rpcErrorSchema = z.object({
  code: z.number().optional(),
  message: z.string(),
  data: z.unknown().optional(),
});
/** Any JSON-RPC 2.0 message: a request (id + method), a notification (method only) or a response (id + result | error). */
const rpcMessageSchema = z.object({
  id: rpcIdSchema.nullable().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
});

/** v1 `{id, name}`; v2 `{methodId, name}`. */
const authMethodSchema = z.object({ id: z.string().optional(), methodId: z.string().optional() });
const initializeResultSchema = z.object({
  protocolVersion: z.number().optional(),
  agentCapabilities: z
    .object({
      loadSession: z.boolean().optional(),
      promptCapabilities: z.object({ image: z.boolean().optional() }).optional(),
    })
    .optional(),
  authMethods: z.array(authMethodSchema).optional(),
});

const sessionModeSchema = z.object({ id: z.string(), name: z.string().optional() });
const configOptionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  currentValue: z.unknown().optional(),
  options: z
    .array(
      z.object({
        value: z.string(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
const sessionResultSchema = z.object({
  /** Absent from a `session/load` result: the id is the one that was loaded. */
  sessionId: z.string().optional(),
  modes: z.object({ currentModeId: z.string(), availableModes: z.array(sessionModeSchema) }).optional(),
  configOptions: z.array(configOptionSchema).optional(),
  /** Gemini CLI's model list (the pre-config-options ACP extension, switched with `session/set_model`). */
  models: z
    .object({
      currentModelId: z.string().optional(),
      availableModels: z.array(
        z.object({
          modelId: z.string(),
          name: z.string().optional(),
          description: z.string().nullable().optional(),
        }),
      ),
    })
    .optional(),
});
const configOptionsResultSchema = z.object({ configOptions: z.array(configOptionSchema).optional() });
const promptResultSchema = z.object({ stopReason: z.string().optional() });

const contentBlockSchema = z.object({ type: z.string(), text: z.string().optional() });
const toolCallContentSchema = z.object({ type: z.string(), content: contentBlockSchema.optional() });
const toolCallFields = {
  toolCallId: z.string(),
  title: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  content: z.array(toolCallContentSchema).nullable().optional(),
  locations: z
    .array(z.object({ path: z.string() }))
    .nullable()
    .optional(),
  rawInput: z.unknown().optional(),
};
const toolCallSchema = z.object(toolCallFields);
/** A tool call with every field optional (a permission subject may carry only the id). */
const toolCallPartialSchema = toolCallSchema.partial();
type ToolCallLike = z.infer<typeof toolCallPartialSchema>;
const planEntrySchema = z.object({ content: z.string(), status: z.string().optional() });
const sessionUpdateSchema = z.discriminatedUnion('sessionUpdate', [
  z.object({ sessionUpdate: z.literal('agent_message_chunk'), content: contentBlockSchema }),
  z.object({ sessionUpdate: z.literal('agent_thought_chunk'), content: contentBlockSchema }),
  z.object({ sessionUpdate: z.literal('user_message_chunk'), content: contentBlockSchema }),
  z.object({ sessionUpdate: z.literal('tool_call'), ...toolCallFields }),
  z.object({ sessionUpdate: z.literal('tool_call_update'), ...toolCallFields }),
  z.object({ sessionUpdate: z.literal('plan'), entries: z.array(planEntrySchema) }),
  z.object({
    sessionUpdate: z.literal('plan_update'),
    plan: z.object({ entries: z.array(planEntrySchema).optional() }),
  }),
  z.object({
    sessionUpdate: z.literal('available_commands_update'),
    availableCommands: z.array(z.object({ name: z.string() })),
  }),
  z.object({ sessionUpdate: z.literal('current_mode_update'), currentModeId: z.string() }),
  z.object({ sessionUpdate: z.literal('config_option_update'), configOptions: z.array(configOptionSchema) }),
  z.object({
    sessionUpdate: z.literal('usage_update'),
    used: z.number().optional(),
    size: z.number().optional(),
    cost: z.object({ amount: z.number() }).optional(),
  }),
]);
const sessionNotificationSchema = z.object({ sessionId: z.string().optional(), update: sessionUpdateSchema });

const permissionOptionSchema = z.object({ optionId: z.string(), kind: z.string() });
const permissionRequestSchema = z.object({
  title: z.string().optional(),
  /** v1 puts the tool call here; v2 under `subject.toolCall`. */
  toolCall: toolCallPartialSchema.optional(),
  subject: z.object({ toolCall: toolCallPartialSchema.optional() }).optional(),
  options: z.array(permissionOptionSchema),
});

// --- Mapping ---------------------------------------------------------------

export interface AcpMode {
  id: string;
  name?: string | undefined;
}

/** Gemini CLI approval modes (`--approval-mode`): default asks, auto_edit passes edits, yolo passes everything. */
const GEMINI_MODES: Readonly<Record<PermissionMode, string>> = {
  default: 'default',
  acceptEdits: 'auto_edit',
  plan: 'plan',
  bypassPermissions: 'yolo',
  dontAsk: 'yolo',
  auto: 'yolo',
};
/** Cursor agent modes: agent (tools, asks through request_permission), plan (read-only), ask (Q&A only, unused). */
const CURSOR_MODES: Readonly<Record<PermissionMode, string>> = {
  default: 'agent',
  acceptEdits: 'agent',
  plan: 'plan',
  bypassPermissions: 'agent',
  dontAsk: 'agent',
  auto: 'agent',
};
/** For an agent with its own ids: the closest mode by id or name, tried in priority order. */
const MODE_HINTS: Readonly<Record<PermissionMode, readonly RegExp[]>> = {
  default: [/default/, /agent/, /normal/, /ask/],
  acceptEdits: [/edit/, /default/, /agent/, /normal/],
  plan: [/plan/],
  bypassPermissions: [/yolo/, /bypass/, /danger/, /full/, /auto/, /agent/],
  dontAsk: [/yolo/, /bypass/, /danger/, /full/, /auto/, /agent/],
  auto: [/auto/, /yolo/, /bypass/, /agent/],
};

/**
 * The agent mode a Styx permission mode maps to, from the modes the agent advertised: Gemini's table first, then
 * Cursor's, then the closest by name (`exact: false`, noted in the transcript). Null when nothing fits.
 */
export const resolveAcpMode = (
  mode: PermissionMode,
  available: readonly AcpMode[],
): { id: string; exact: boolean } | null => {
  const ids = new Set(available.map((m) => m.id));
  for (const table of [GEMINI_MODES, CURSOR_MODES]) {
    const id = table[mode];
    if (ids.has(id)) return { id, exact: true };
  }
  for (const re of MODE_HINTS[mode]) {
    const hit = available.find((m) => re.test(`${m.id} ${m.name ?? ''}`.toLowerCase()));
    if (hit) return { id: hit.id, exact: false };
  }
  return null;
};

/**
 * An `authenticate` method Styx may call without a browser: Gemini's API-key and Vertex methods when their env is
 * set, Cursor's `cursor_login` (its documented ACP step; it reuses the `agent login` credentials). Google sign-in
 * and anything unknown are interactive: the user signs in with the CLI first.
 */
export const pickAuthMethod = (
  methods: readonly { id: string }[],
  env: Readonly<Record<string, string | undefined>>,
): string | null => {
  const has = (id: string) => methods.some((m) => m.id === id);
  if (has('gemini-api-key') && env['GEMINI_API_KEY']) return 'gemini-api-key';
  if (has('vertex-ai') && (env['GOOGLE_API_KEY'] || env['GOOGLE_CLOUD_PROJECT'])) return 'vertex-ai';
  if (has('cursor_login')) return 'cursor_login';
  return null;
};

/** ACP tool kinds → the tool names the renderer's rows and main's edit auto-approval already understand. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  execute: 'Bash',
  edit: 'Edit',
  read: 'Read',
  search: 'Grep',
  fetch: 'WebFetch',
  delete: 'Bash',
  move: 'Bash',
  think: 'Task',
};
const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

/** `session/new.mcpServers` stdio entry: env as the spec's `{name, value}` pairs. */
export const acpMcpServer = (
  mcp: McpServerEntry,
): {
  type: 'stdio';
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
} => ({
  type: 'stdio',
  name: 'styx',
  command: mcp.command,
  args: mcp.args,
  env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })),
});

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const crlf = (s: string): string => `${s.replace(/\r?\n/g, '\r\n')}\r\n`;
const firstLine = (s: string, max = 200): string => {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const contentText = (content: z.infer<typeof toolCallContentSchema>[] | null | undefined): string =>
  (content ?? [])
    .map((c) => (c.type === 'content' && c.content?.type === 'text' ? (c.content.text ?? '') : ''))
    .filter((t) => t.length > 0)
    .join('\n');
const PLAN_GLYPH: Readonly<Record<string, string>> = {
  completed: '☑',
  in_progress: '▸',
  cancelled: '✕',
};

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}
/** A message already worded for the user (copy.acpRunner), shown as-is instead of wrapped as a handshake failure. */
class UserFacingError extends Error {}

/** ACP's `auth_required`: code -32000 with `data.reason`, or an auth-worded message from an older build. */
const isAuthRequired = (e: unknown): boolean =>
  e instanceof RpcError &&
  (obj(e.data)?.['reason'] === 'auth_required' || e.code === -32000 || /auth/i.test(e.message));

const modelInfo = (
  id: string,
  name: string | undefined,
  description: string | null | undefined,
  isDefault: boolean,
): ModelInfo => ({
  id,
  label: name ?? id,
  description: description ?? null,
  efforts: [],
  defaultEffort: null,
  isDefault,
  hidden: false,
});

// --- Runner ----------------------------------------------------------------

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface LiveBlock {
  key: string;
  kind: StreamBlockKind;
  text: string;
}
interface QueuedPrompt {
  text: string;
  blocks: readonly ImageBlock[];
}
interface PendingPermission {
  rpcId: number | string;
  options: { optionId: string; kind: string }[];
}
interface ToolRow {
  /** Display name for the transcript row (may come from the agent's own title). */
  name: string;
  /** Name derived from the ACP kind alone (never agent text); what a permission ask is filed under. */
  kindName: string;
  input: Json;
  edit: boolean;
}
type ModelSwitch = { via: 'config'; configId: string } | { via: 'set_model' } | null;

interface Entry {
  opts: StreamSpawnOptions;
  proc: ChildProcess | null;
  buffer: string;
  nextId: number;
  pending: Map<number, PendingRequest>;
  // negotiated at initialize / session start
  imageInput: boolean;
  loadSession: boolean;
  authMethods: { id: string }[];
  sessionId: string | null;
  modes: AcpMode[];
  /**
   * v2 agents expose the mode as a config option (category `mode`) instead of a `modes` block: the switch then goes
   * through `session/set_config_option` rather than `session/set_mode`.
   */
  modeConfigId: string | null;
  modesViaConfig: boolean;
  currentModeId: string | null;
  modelSwitch: ModelSwitch;
  models: ModelInfo[];
  currentModelId: string | null;
  slashCommands: string[];
  styxMode: PermissionMode;
  // turn state
  ready: boolean;
  queue: QueuedPrompt[];
  inFlight: boolean;
  promptSeq: number;
  blockSeq: number;
  block: LiveBlock | null;
  turnStartedAt: number;
  turns: number;
  lastText: string;
  tools: Map<string, ToolRow>;
  pendingEdits: Set<string>;
  permissions: Map<string, PendingPermission>;
  killed: boolean;
}

export class AcpRunner extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly spawnFn: SpawnFn = spawnCli,
    private readonly clientVersion: string = '0.0.0',
  ) {
    super();
  }

  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    const entry: Entry = {
      opts,
      proc: null,
      buffer: '',
      nextId: 1,
      pending: new Map(),
      imageInput: false,
      loadSession: false,
      authMethods: [],
      sessionId: null,
      modes: [],
      modeConfigId: null,
      modesViaConfig: false,
      currentModeId: null,
      modelSwitch: null,
      models: [],
      currentModelId: null,
      slashCommands: [],
      styxMode: opts.session?.permissionMode ?? 'default',
      ready: false,
      queue: [],
      inFlight: false,
      promptSeq: 0,
      blockSeq: 0,
      block: null,
      turnStartedAt: 0,
      turns: 0,
      lastText: '',
      tools: new Map(),
      pendingEdits: new Set(),
      permissions: new Map(),
      killed: false,
    };
    this.entries.set(opts.id, entry);
    const pid = await this.start(entry);
    // The handshake runs on; its failure ends the process (→ `exit`) after an `error` effect.
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
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onStdout(entry, chunk));
    proc.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) this.effect(entry, { type: 'render', text: crlf(text) });
    });
    proc.stdin?.on('error', () => undefined);
    return new Promise<number>((resolve, reject) => {
      let started = false;
      proc.once('spawn', () => {
        started = true;
        resolve(proc.pid ?? 0);
      });
      proc.once('error', (err: NodeJS.ErrnoException) => {
        logger.warn('acp runner error', { id: opts.id, error: err.message });
        if (!started) {
          this.entries.delete(opts.id);
          reject(err);
        }
      });
      proc.once('close', (code) => this.onClose(entry, proc, code));
    });
  }

  // --- handshake -----------------------------------------------------------

  private label(entry: Entry): string {
    return entry.opts.session ? AGENT_LABEL[entry.opts.session.agent] : entry.opts.command;
  }

  private async handshake(entry: Entry): Promise<void> {
    const { opts } = entry;
    try {
      const init = initializeResultSchema.parse(
        await this.requestWithin(entry, HANDSHAKE_MS, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'styx', title: 'Styx', version: this.clientVersion },
        }),
      );
      entry.loadSession = init.agentCapabilities?.loadSession === true;
      entry.imageInput = init.agentCapabilities?.promptCapabilities?.image === true;
      entry.authMethods = (init.authMethods ?? []).flatMap((m) => {
        const id = m.id ?? m.methodId;
        return id === undefined ? [] : [{ id }];
      });
      this.adoptSession(entry, await this.openSession(entry));
      const wanted = opts.session?.model ?? null;
      if (
        wanted !== null &&
        entry.modelSwitch !== null &&
        entry.currentModelId !== null &&
        wanted !== entry.currentModelId
      )
        await this.applyModel(entry, wanted);
      await this.applyMode(entry, entry.styxMode);
      entry.ready = true;
      if (opts.firstMessage) entry.queue.unshift({ text: opts.firstMessage, blocks: [] });
      if (entry.queue.length === 0) this.effect(entry, { type: 'session', event: 'quiet' });
      this.pump(entry);
    } catch (e) {
      if (entry.proc === null || entry.killed) return;
      const message =
        e instanceof UserFacingError
          ? e.message
          : fill(copy.acpRunner.handshakeFailed, { cli: this.label(entry), message: (e as Error).message });
      this.effect(entry, { type: 'error', message });
      this.effect(entry, { type: 'render', text: crlf(`! ${message}`) });
      this.kill(opts.id);
    }
  }

  /** `session/load` (resume) or `session/new`; an `auth_required` answer is retried once after `authenticate`. */
  private async openSession(entry: Entry): Promise<z.infer<typeof sessionResultSchema>> {
    try {
      return await this.startOrLoad(entry);
    } catch (e) {
      if (!isAuthRequired(e)) throw e;
      const cli = this.label(entry);
      const method = pickAuthMethod(entry.authMethods, { ...process.env, ...entry.opts.env });
      if (method === null) throw new UserFacingError(fill(copy.acpRunner.signInFirst, { cli }));
      try {
        await this.request(entry, 'authenticate', { methodId: method });
      } catch (err) {
        throw new UserFacingError(fill(copy.acpRunner.authFailed, { cli, message: (err as Error).message }));
      }
      return await this.startOrLoad(entry);
    }
  }

  private async startOrLoad(entry: Entry): Promise<z.infer<typeof sessionResultSchema>> {
    const settings = entry.opts.session;
    const cwd = entry.opts.worktreePath;
    const mcpServers = settings ? [acpMcpServer(settings.mcp)] : [];
    const resume = settings?.resumeSessionId ?? null;
    if (resume !== null && entry.loadSession) {
      try {
        const loaded = sessionResultSchema.parse(
          await this.requestWithin(entry, HANDSHAKE_MS, 'session/load', {
            sessionId: resume,
            cwd,
            mcpServers,
          }),
        );
        return { ...loaded, sessionId: resume };
      } catch (e) {
        if (isAuthRequired(e)) throw e;
        // The earlier conversation is gone (agent restarted, id expired): start clean rather than fail the launch.
        this.line(
          entry,
          fill(copy.acpRunner.resumeFailed, { cli: this.label(entry), message: (e as Error).message }),
        );
      }
    }
    return sessionResultSchema.parse(
      await this.requestWithin(entry, HANDSHAKE_MS, 'session/new', { cwd, mcpServers }),
    );
  }

  private adoptSession(entry: Entry, r: z.infer<typeof sessionResultSchema>): void {
    entry.sessionId = r.sessionId ?? null;
    if (r.modes) {
      entry.modes = r.modes.availableModes;
      entry.currentModeId = r.modes.currentModeId;
    }
    this.adoptConfigOptions(entry, r.configOptions ?? [], true);
    if (r.models && entry.modelSwitch === null) {
      entry.modelSwitch = { via: 'set_model' };
      entry.currentModelId = r.models.currentModelId ?? null;
      entry.models = r.models.availableModels.map((m) =>
        modelInfo(m.modelId, m.name, m.description, m.modelId === entry.currentModelId),
      );
    }
    this.emitInit(entry);
    this.line(entry, `session started${entry.currentModelId ? ` · ${entry.currentModelId}` : ''}`);
    if (entry.models.length > 0) this.effect(entry, { type: 'catalogue', models: entry.models });
  }

  /**
   * Config options (session/new, set_config_option, config_option_update): the `mode` category stands in for
   * `session/set_mode` on agents without a modes block; the `model` category is the model catalogue. `isDefault`
   * is the current value at session start and is kept across later updates.
   */
  private adoptConfigOptions(
    entry: Entry,
    options: z.infer<typeof configOptionSchema>[],
    initial: boolean,
  ): void {
    const byCategory = (category: string, idRe: RegExp) =>
      options.find(
        (o) =>
          o.options !== undefined &&
          (o.category === category || (o.category === undefined && idRe.test(o.id))),
      );
    const mode = byCategory('mode', /^mode$/);
    if (mode?.options) {
      entry.modeConfigId = mode.id;
      if (entry.modes.length === 0) {
        entry.modes = mode.options.map((o) => ({ id: o.value, name: o.name }));
        entry.modesViaConfig = true;
      }
      if (typeof mode.currentValue === 'string') entry.currentModeId = mode.currentValue;
    }
    const model = byCategory('model', /^models?$/);
    if (model?.options) {
      entry.modelSwitch = { via: 'config', configId: model.id };
      const current = typeof model.currentValue === 'string' ? model.currentValue : null;
      const wasDefault = new Map(entry.models.map((m) => [m.id, m.isDefault]));
      const next = model.options.map((o) =>
        modelInfo(
          o.value,
          o.name,
          o.description,
          initial ? o.value === current : (wasDefault.get(o.value) ?? false),
        ),
      );
      entry.currentModelId = current;
      const changed = JSON.stringify(next) !== JSON.stringify(entry.models);
      entry.models = next;
      if (changed && !initial) this.effect(entry, { type: 'catalogue', models: next });
    }
  }

  private emitInit(entry: Entry): void {
    this.effect(entry, {
      type: 'init',
      chatId: entry.sessionId,
      model: entry.currentModelId ?? entry.opts.session?.model ?? null,
      permissionMode: entry.styxMode,
      slashCommands: entry.slashCommands,
    });
  }

  private modeName(entry: Entry, id: string): string {
    return entry.modes.find((m) => m.id === id)?.name ?? id;
  }

  private async applyMode(entry: Entry, mode: PermissionMode): Promise<void> {
    entry.styxMode = mode;
    if (entry.sessionId === null || entry.modes.length === 0) return; // the agent has no modes to map onto
    const label = copy.session.permissionModes[mode];
    const resolved = resolveAcpMode(mode, entry.modes);
    if (resolved === null) {
      this.system(
        entry,
        fill(copy.acpRunner.noMode, {
          mode: label,
          current: this.modeName(entry, entry.currentModeId ?? ''),
        }),
      );
      return;
    }
    if (resolved.id === entry.currentModeId) return;
    // Recorded before the round trip so a second switch issued meanwhile compares against the mode in flight.
    const previous = entry.currentModeId;
    entry.currentModeId = resolved.id;
    try {
      if (entry.modesViaConfig && entry.modeConfigId !== null) {
        const r = configOptionsResultSchema.parse(
          await this.request(entry, 'session/set_config_option', {
            sessionId: entry.sessionId,
            configId: entry.modeConfigId,
            type: 'id',
            value: resolved.id,
          }),
        );
        this.adoptConfigOptions(entry, r.configOptions ?? [], false);
      } else {
        await this.request(entry, 'session/set_mode', { sessionId: entry.sessionId, modeId: resolved.id });
      }
      if (!resolved.exact)
        this.system(
          entry,
          fill(copy.acpRunner.modeMapped, { mode: label, agentMode: this.modeName(entry, resolved.id) }),
        );
    } catch (e) {
      if (entry.currentModeId === resolved.id) entry.currentModeId = previous;
      this.system(entry, fill(copy.acpRunner.modeFailed, { mode: label, message: (e as Error).message }));
    }
  }

  private async applyModel(entry: Entry, model: string | null): Promise<void> {
    if (entry.sessionId === null) return;
    const target = model ?? entry.models.find((m) => m.isDefault)?.id ?? null;
    if (entry.modelSwitch === null || target === null) {
      this.system(entry, copy.acpRunner.noModelSwitch);
      return;
    }
    try {
      if (entry.modelSwitch.via === 'config') {
        const r = configOptionsResultSchema.parse(
          await this.request(entry, 'session/set_config_option', {
            sessionId: entry.sessionId,
            configId: entry.modelSwitch.configId,
            type: 'id',
            value: target,
          }),
        );
        this.adoptConfigOptions(entry, r.configOptions ?? [], false);
      } else {
        await this.request(entry, 'session/set_model', { sessionId: entry.sessionId, modelId: target });
      }
      entry.currentModelId = target;
    } catch (e) {
      this.line(entry, (e as Error).message, '!');
    }
  }

  // --- turns ---------------------------------------------------------------

  private pump(entry: Entry): void {
    if (!entry.ready || entry.inFlight) return;
    const next = entry.queue.shift();
    if (!next) return;
    void this.prompt(entry, next);
  }

  /** One `session/prompt`; ACP has no steer, so a message typed mid-turn waits in the queue for the next turn. */
  private async prompt(entry: Entry, turn: QueuedPrompt): Promise<void> {
    if (entry.sessionId === null) return;
    entry.inFlight = true;
    entry.promptSeq += 1;
    entry.blockSeq = 0;
    entry.turnStartedAt = Date.now();
    entry.lastText = '';
    this.effect(entry, { type: 'session', event: 'activity' });
    // A `/command` the agent advertised is sent as-is: the agent runs it (Claude parity: the composer's `/` picker).
    const prompt: Json[] = [{ type: 'text', text: turn.text }];
    if (turn.blocks.length > 0) {
      if (entry.imageInput)
        for (const b of turn.blocks)
          prompt.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type });
      else this.system(entry, fill(copy.acpRunner.imagesDropped, { n: turn.blocks.length }));
    }
    let failure: string | null = null;
    let stopReason: string | null = null;
    try {
      const r = promptResultSchema.parse(
        await this.request(entry, 'session/prompt', { sessionId: entry.sessionId, prompt }),
      );
      stopReason = r.stopReason ?? null;
    } catch (e) {
      failure = (e as Error).message;
    }
    if (entry.proc === null) return; // the process went away mid-turn: `exit` already told main
    this.closeBlock(entry);
    const ms = Date.now() - entry.turnStartedAt;
    if (failure !== null) {
      const message = fill(copy.acpRunner.promptFailed, { message: failure });
      this.effect(entry, { type: 'error', message });
      this.effect(entry, { type: 'render', text: crlf(`! ${firstLine(message, 200)}`) });
    } else if (stopReason === 'cancelled') {
      this.line(entry, copy.chat.controls.interrupted, '—');
    } else {
      const why = stopReason !== null && stopReason !== 'end_turn' ? ` (${stopReason})` : '';
      this.effect(entry, { type: 'render', text: crlf(`— done${why} in ${(ms / 1000).toFixed(1)}s`) });
    }
    if (entry.lastText) this.effect(entry, { type: 'note', note: firstLine(entry.lastText) });
    entry.turns += 1;
    this.effect(entry, { type: 'usage', costUsd: null, numTurns: entry.turns, durationMs: ms });
    if (entry.pendingEdits.size > 0) {
      entry.pendingEdits.clear();
      this.effect(entry, { type: 'rescan' });
    }
    entry.inFlight = false;
    this.effect(entry, { type: 'session', event: 'quiet' });
    this.pump(entry);
  }

  /** Text and thought chunks stream into one live block per kind; a kind change (or a tool call) closes the block. */
  private appendBlock(entry: Entry, kind: StreamBlockKind, text: string): void {
    if (entry.block !== null && entry.block.kind !== kind) this.closeBlock(entry);
    if (entry.block === null) {
      entry.blockSeq += 1;
      entry.block = { key: `acp-${entry.promptSeq}:${entry.blockSeq}`, kind, text: '' };
      this.effect(entry, { type: 'streamStart', key: entry.block.key, kind });
    }
    entry.block.text += text;
    this.effect(entry, { type: 'streamDelta', key: entry.block.key, text });
    this.effect(entry, { type: 'session', event: 'activity' });
  }

  private closeBlock(entry: Entry): void {
    const block = entry.block;
    if (block === null) return;
    entry.block = null;
    const body = block.kind === 'text' ? block.text.trim() : block.text;
    this.effect(entry, { type: 'streamStop', key: block.key });
    this.effect(entry, { type: 'streamFinal', key: block.key, body });
    if (block.kind === 'text' && body) {
      entry.lastText = body;
      this.effect(entry, { type: 'render', text: crlf(body) });
    }
  }

  // --- notifications -------------------------------------------------------

  private onNotification(entry: Entry, method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const parsed = sessionNotificationSchema.safeParse(params);
    if (!parsed.success) {
      logger.debug('acp: session/update not understood', {
        id: entry.opts.id,
        kind: obj(obj(params)?.['update'])?.['sessionUpdate'],
      });
      return;
    }
    const u = parsed.data.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        // Outside a turn these are replayed history (`session/load`): Styx keeps its own transcript.
        if (entry.inFlight && u.content.type === 'text' && u.content.text)
          this.appendBlock(entry, 'text', u.content.text);
        return;
      case 'agent_thought_chunk':
        if (entry.inFlight && u.content.type === 'text' && u.content.text)
          this.appendBlock(entry, 'thinking', u.content.text);
        return;
      case 'user_message_chunk':
        return; // Styx's own prompt echoed back (or replayed history)
      case 'tool_call':
        if (entry.inFlight) this.toolCall(entry, u);
        return;
      case 'tool_call_update':
        if (!entry.inFlight) return;
        if (!entry.tools.has(u.toolCallId))
          this.toolCall(entry, u); // upsert: an update for a call never announced
        else if (u.status === 'completed' || u.status === 'failed') this.toolDone(entry, u);
        return;
      case 'plan':
        this.plan(entry, u.entries);
        return;
      case 'plan_update':
        this.plan(entry, u.plan.entries ?? []);
        return;
      case 'available_commands_update':
        entry.slashCommands = [
          ...new Set(u.availableCommands.map((c) => `/${c.name.replace(/^\//, '')}`)),
        ].sort();
        this.emitInit(entry);
        return;
      case 'current_mode_update':
        entry.currentModeId = u.currentModeId;
        this.effect(entry, {
          type: 'note',
          note: fill(copy.chat.controls.modeChanged, { mode: this.modeName(entry, u.currentModeId) }),
        });
        return;
      case 'config_option_update':
        this.adoptConfigOptions(entry, u.configOptions, false);
        return;
      case 'usage_update':
        this.effect(entry, {
          type: 'usage',
          costUsd: u.cost?.amount ?? null,
          numTurns: null,
          durationMs: null,
          tokensUsed: u.used ?? null,
          contextWindow: u.size ?? null,
        });
        return;
    }
  }

  /** Name, input and edit flag for a tool call or a permission subject, in the Claude tool vocabulary. */
  private toolRow(u: ToolCallLike): ToolRow {
    const kind = u.kind ?? null;
    const fallback = u.name ?? u.title ?? null;
    const name =
      (kind !== null ? TOOL_NAMES[kind] : undefined) ?? (fallback ? firstLine(fallback, 40) : 'tool');
    const input: Json = { ...(obj(u.rawInput) ?? {}) };
    if (u.title !== undefined && input['title'] === undefined) input['title'] = u.title;
    const paths = (u.locations ?? []).map((l) => l.path);
    if (paths.length > 0) {
      if (typeof input['file_path'] !== 'string') input['file_path'] = paths[0];
      input['locations'] = paths;
    }
    if (kind === 'execute' && typeof input['command'] !== 'string' && u.title !== undefined)
      input['command'] = u.title;
    const kindName = (kind !== null ? TOOL_NAMES[kind] : undefined) ?? 'tool';
    return { name, kindName, input, edit: kind !== null && EDIT_KINDS.has(kind) };
  }

  private hintOf(entry: Entry, row: ToolRow, title: string | undefined): string {
    return toolHint(entry.opts.worktreePath, row.name, row.input) || (title ? firstLine(title, 100) : '');
  }

  private toolCall(entry: Entry, u: z.infer<typeof toolCallSchema>): void {
    const row = this.toolRow(u);
    entry.tools.set(u.toolCallId, row);
    if (row.edit) entry.pendingEdits.add(u.toolCallId);
    this.closeBlock(entry); // text said so far lands before the tool row
    const hint = this.hintOf(entry, row, u.title);
    const line = `${row.name}${hint ? ` ${hint}` : ''}`;
    this.effect(entry, {
      type: 'transcript',
      body: line,
      payload: {
        kind: 'tool',
        tool: row.name,
        hint,
        toolUseId: u.toolCallId,
        status: 'running',
        detail: null,
      },
    });
    this.effect(entry, { type: 'render', text: crlf(`▸ ${line}`) });
    this.effect(entry, { type: 'session', event: 'activity' });
    if (u.status === 'completed' || u.status === 'failed') this.toolDone(entry, u);
  }

  private toolDone(entry: Entry, u: z.infer<typeof toolCallSchema>): void {
    const ok = u.status === 'completed';
    const text = contentText(u.content);
    const detail = text ? firstLine(text, 160) : null;
    this.effect(entry, { type: 'toolResult', toolUseId: u.toolCallId, ok, detail });
    if (!ok && detail) this.effect(entry, { type: 'render', text: crlf(`  ! ${detail}`) });
    if (entry.pendingEdits.delete(u.toolCallId)) this.effect(entry, { type: 'rescan' });
    entry.tools.delete(u.toolCallId);
  }

  private plan(entry: Entry, entries: z.infer<typeof planEntrySchema>[]): void {
    if (entries.length === 0) return;
    this.closeBlock(entry);
    const lines = entries.map((e) => `- ${PLAN_GLYPH[e.status ?? ''] ?? '☐'} ${e.content}`);
    const body = `**${copy.acpRunner.plan}**\n${lines.join('\n')}`;
    this.effect(entry, { type: 'transcript', body, payload: { kind: 'agent' } });
    this.effect(entry, { type: 'render', text: crlf(`${copy.acpRunner.plan}\n${lines.join('\n')}`) });
  }

  // --- agent → client requests --------------------------------------------

  private onRequest(entry: Entry, rpcId: number | string, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      this.onPermissionRequest(entry, rpcId, params);
      return;
    }
    // fs/* and terminal/* were not advertised in clientCapabilities; anything else is unknown to Styx.
    this.respond(entry, rpcId, undefined, { code: -32601, message: `Styx does not provide ${method}` });
  }

  private onPermissionRequest(entry: Entry, rpcId: number | string, params: unknown): void {
    const parsed = permissionRequestSchema.safeParse(params);
    if (!parsed.success) {
      this.respond(entry, rpcId, undefined, { code: -32602, message: 'invalid params' });
      return;
    }
    const p = parsed.data;
    const call: ToolCallLike = p.toolCall ?? p.subject?.toolCall ?? {};
    const known = call.toolCallId !== undefined ? entry.tools.get(call.toolCallId) : undefined;
    const row = known ?? this.toolRow({ ...call, title: call.title ?? p.title });
    const requestId = String(rpcId);
    entry.permissions.set(requestId, { rpcId, options: p.options });
    // The permission's tool name is derived from the ACP `kind` only: a title or MCP tool name the agent chose
    // ("Write", say) must never be able to pass for a Styx edit and reach the auto-approve toggle.
    const toolName = row.edit ? 'Edit' : row.kindName;
    this.effect(entry, {
      type: 'permission',
      requestId,
      toolName,
      input: { ...row.input, styxEdit: row.edit },
    });
    const hint = this.hintOf(entry, row, call.title ?? p.title);
    this.effect(entry, { type: 'render', text: crlf(`? permission: ${row.name}${hint ? ` ${hint}` : ''}`) });
  }

  /**
   * Allow picks the agent's `allow_once` option (`allow_always` when main asked for it with `updatedInput.always`);
   * deny picks `reject_once`, never `reject_always`. An agent that offered no fitting option gets `cancelled`.
   */
  respondPermission(
    id: string,
    requestId: string,
    allow: boolean,
    _message?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    const entry = this.entries.get(id);
    const perm = entry?.permissions.get(requestId);
    if (!entry || !perm) return;
    entry.permissions.delete(requestId);
    const wanted = allow
      ? updatedInput?.['always'] === true
        ? ['allow_always', 'allow_once']
        : ['allow_once']
      : ['reject_once'];
    const option = wanted.map((k) => perm.options.find((o) => o.kind === k)).find((o) => o !== undefined);
    this.respond(entry, perm.rpcId, {
      outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' },
    });
  }

  // --- transport -----------------------------------------------------------

  private onStdout(entry: Entry, chunk: string): void {
    entry.buffer += chunk;
    let nl = entry.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = entry.buffer.slice(0, nl);
      entry.buffer = entry.buffer.slice(nl + 1);
      this.dispatch(entry, line);
      nl = entry.buffer.indexOf('\n');
    }
  }

  private dispatch(entry: Entry, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      // Non-JSON output (a warning, a login hint…) is shown in the terminal only.
      this.effect(entry, { type: 'render', text: crlf(trimmed) });
      return;
    }
    const msg = rpcMessageSchema.safeParse(raw);
    if (!msg.success) return;
    const m = msg.data;
    if (m.method !== undefined) {
      if (m.id !== undefined && m.id !== null) this.onRequest(entry, m.id, m.method, m.params);
      else this.onNotification(entry, m.method, m.params);
      return;
    }
    if (typeof m.id !== 'number') return;
    const pending = entry.pending.get(m.id);
    if (!pending) return;
    entry.pending.delete(m.id);
    if (m.error) pending.reject(new RpcError(m.error.code ?? -32603, m.error.message, m.error.data));
    else pending.resolve(m.result);
  }

  private write(entry: Entry, message: Json): boolean {
    const stdin = entry.proc?.stdin;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    return true;
  }

  /** A handshake step that never answers (first-run prompt, TTY wait) errors the session instead of hanging it. */
  private requestWithin(entry: Entry, ms: number, method: string, params: Json): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${method} did not answer within ${Math.round(ms / 1000)} s`)),
        ms,
      );
      t.unref?.();
      this.request(entry, method, params).then(
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
  }

  private request(entry: Entry, method: string, params: Json): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = entry.nextId++;
      entry.pending.set(id, { method, resolve, reject });
      if (!this.write(entry, { id, method, params })) {
        entry.pending.delete(id);
        reject(new Error('agent is not running'));
      }
    });
  }

  private notify(entry: Entry, method: string, params: Json): void {
    this.write(entry, { method, params });
  }

  private respond(
    entry: Entry,
    id: number | string,
    result: unknown,
    error?: { code: number; message: string },
  ): void {
    this.write(entry, error ? { id, error } : { id, result });
  }

  private onClose(entry: Entry, proc: ChildProcess, code: number | null): void {
    if (entry.proc !== proc) return;
    if (entry.buffer.trim()) this.dispatch(entry, entry.buffer);
    entry.buffer = '';
    entry.proc = null;
    for (const p of entry.pending.values())
      p.reject(new Error(`${this.label(entry)} exited during ${p.method}`));
    entry.pending.clear();
    entry.permissions.clear();
    this.entries.delete(entry.opts.id);
    this.emit('exit', entry.opts.id, code);
  }

  private effect(entry: Entry, effect: StreamEffect): void {
    this.emit('effect', entry.opts.id, effect);
  }

  /** A terminal-only line. */
  private line(entry: Entry, text: string, glyph = '·'): void {
    this.effect(entry, { type: 'render', text: crlf(`${glyph} ${text}`) });
  }

  /** A system row in the transcript plus its terminal line. */
  private system(entry: Entry, text: string): void {
    this.effect(entry, { type: 'transcript', body: text, payload: { kind: 'system' } });
    this.line(entry, text);
  }

  // --- StreamRunnerLike -----------------------------------------------------

  /** Only an agent whose `initialize` said `promptCapabilities.image` takes image blocks. */
  acceptsImages(id: string): boolean {
    return this.entries.get(id)?.imageInput === true;
  }

  send(id: string, text: string, blocks: readonly ImageBlock[] = []): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.queue.push({ text, blocks });
    this.pump(entry);
  }

  setModel(id: string, model: string | null): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.ready) return;
    void this.applyModel(entry, model);
  }

  setPermissionMode(id: string, mode: string): void {
    const entry = this.entries.get(id);
    const parsed = permissionModeSchema.safeParse(mode);
    if (!entry || !parsed.success) return;
    if (!entry.ready) {
      entry.styxMode = parsed.data; // applied by the handshake
      return;
    }
    void this.applyMode(entry, parsed.data);
  }

  /** ACP has no effort setting; the session keeps the value for a CLI that gains one. */
  setEffort(id: string, _effort: string | null): void {
    const entry = this.entries.get(id);
    if (entry) this.line(entry, copy.acpRunner.noEffort);
  }

  /** `session/cancel`; a permission still waiting on the user is answered `cancelled` as the spec asks. */
  interrupt(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.sessionId === null) return;
    for (const perm of entry.permissions.values())
      this.respond(entry, perm.rpcId, { outcome: { outcome: 'cancelled' } });
    entry.permissions.clear();
    this.notify(entry, 'session/cancel', { sessionId: entry.sessionId });
  }

  kill(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.killed = true;
    if (entry.proc) {
      entry.proc.stdin?.end();
      killTree(entry.proc);
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
