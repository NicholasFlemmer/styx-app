import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute, relative, sep } from 'node:path';
import { fill, copy, type MessagePayload } from '@styx/core';
import type { StreamInput } from '../agents/types';
import { logger } from './logger';

/**
 * ADR-0010 `stream` runner: Claude Code (`claude -p --input-format stream-json --output-format stream-json`) and,
 * when its CLI advertises the flags, cursor-agent (`--print --output-format stream-json`).
 *
 * Transport decision (Phase 7 spike): **child_process pipes, not node-pty.** A pty echoes stdin back into stdout,
 * rewrites `\n` as `\r\n`, lets the CLI detect a TTY and switch to its interactive renderer, and its 5 s "quiet"
 * heuristics are useless when every line is already a typed event. Plain pipes give byte-exact NDJSON both ways: one
 * JSON object per `\n`-terminated line on stdout, one `{type:'user'}` line per turn on stdin. The xterm pane still
 * gets a readable rendering (`render` effects) so the terminal shows progress.
 */

// --- Parser -----------------------------------------------------------------

export type StreamEffect =
  | {
      type: 'init';
      chatId: string | null;
      model: string | null;
      permissionMode: string | null;
      /** `slash_commands` minus `terminal_slash_commands` (sorted, deduped): what the composer's `/` picker offers. */
      slashCommands: string[];
    }
  | { type: 'transcript'; body: string; payload: MessagePayload }
  /** A `tool_result` for an earlier `tool_use`: patches the matching `tool` transcript line. */
  | { type: 'toolResult'; toolUseId: string; ok: boolean; detail: string | null }
  /** From `result`: running totals for the CLI session (null when the CLI did not report them). */
  | { type: 'usage'; costUsd: number | null; numTurns: number | null; durationMs: number | null }
  | { type: 'session'; event: 'activity' | 'quiet' }
  /**
   * `--include-partial-messages`: one text / thinking block streaming live. `key` is `<messageId>:<index>`; the block
   * starts empty, grows by deltas, stops, and is reconciled by `streamFinal` (the complete block from the `assistant`
   * event that follows) so a dropped delta never leaves a truncated row.
   */
  | { type: 'streamStart'; key: string; kind: StreamBlockKind }
  | { type: 'streamDelta'; key: string; text: string }
  | { type: 'streamStop'; key: string }
  | { type: 'streamFinal'; key: string; body: string }
  /** `message_delta.usage.output_tokens` for the message in flight (a running total, not a delta). */
  | { type: 'streamUsage'; outputTokens: number }
  | { type: 'note'; note: string }
  | { type: 'rescan' }
  | {
      type: 'permission';
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: 'render'; text: string }
  | { type: 'error'; message: string };

export type StreamBlockKind = 'text' | 'thinking';

/** Which live blocks of one streamed message have been announced, per kind and in block order (see `assistant`). */
interface StreamedMessage {
  keys: Record<StreamBlockKind, string[]>;
  used: Record<StreamBlockKind, number>;
}

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/** `/Users/me/sdk/bin/gcloud …` or `~/.local/bin/gh …`: a shimmed cloud CLI reached by path, so the shim was skipped. */
const CLOUD_CLI_BY_PATH =
  /(?:^|[\s;&|(`])(?:\/|~\/|\.\/)[^\s'"`]*\/(gcloud|aws|gh|vercel|supabase|ssh)(?=[\s;&|)`]|$)/;
export const cloudCliByFullPath = (command: string): string | null => {
  const m = CLOUD_CLI_BY_PATH.exec(command);
  return m?.[1] ?? null;
};
const FILE_TOOLS = /^(Read|Edit|Write|MultiEdit|NotebookEdit|NotebookRead)$/;
const HINT_MAX = 100;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

/**
 * The slash commands a chat turn may run (claude 2.1.263 `system/init`): `slash_commands` (skills, plugins and
 * built-ins such as compact, model, context) without the `terminal_slash_commands` that only the interactive TUI
 * understands (doctor, color, reload-plugins…). Sorted and deduped; empty when the CLI reports none.
 */
export const chatSlashCommands = (all: unknown, terminalOnly: unknown): string[] => {
  const terminal = new Set(strList(terminalOnly));
  return [...new Set(strList(all).filter((c) => !terminal.has(c)))].sort();
};

const firstLine = (s: string, max = 200): string => {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const crlf = (s: string): string => `${s.replace(/\r?\n/g, '\r\n')}\r\n`;

/** Relative, `/`-separated path for a tool's `file_path`; absolute paths outside the worktree stay absolute. */
export const relPath = (worktree: string, p: string): string => {
  if (!isAbsolute(p)) return p.split(sep).join('/');
  const r = relative(worktree, p);
  return r.startsWith('..') ? p : r.split(sep).join('/');
};

/**
 * The one-line hint shown next to a tool name: the command for Bash, the worktree-relative path for file tools, the
 * pattern for Grep/Glob, the description (or prompt) for subagents, the url for WebFetch; otherwise the first string
 * input. Always first line, at most 100 chars.
 */
export const toolHint = (worktree: string, name: string, input: Json): string => {
  const path = str(input['file_path']) ?? str(input['notebook_path']);
  if (name === 'Bash') return firstLine(str(input['command']) ?? '', HINT_MAX);
  if (FILE_TOOLS.test(name)) return path ? relPath(worktree, path) : '';
  if (name === 'Grep' || name === 'Glob') return firstLine(str(input['pattern']) ?? '', HINT_MAX);
  if (name === 'Agent' || name === 'Task')
    return firstLine(str(input['description']) ?? str(input['prompt']) ?? '', HINT_MAX);
  if (name === 'WebFetch') return firstLine(str(input['url']) ?? '', HINT_MAX);
  const first = Object.values(input).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return first ? firstLine(first, HINT_MAX) : '';
};

/** `tool_result.content` is a string or a list of content blocks; only the text is kept. */
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => str(obj(b)?.['text']) ?? '')
    .filter((t) => t.length > 0)
    .join('\n');
};

/**
 * Turns one stream-json event into transcript messages, session-machine events and xterm text. Stateless apart
 * from the tool_use ids of pending edits (so the matching tool_result triggers a hunk rescan), the chat id, and the
 * live blocks of the message currently streaming (`--include-partial-messages`).
 */
export class StreamParser {
  private readonly pendingEdits = new Set<string>();
  chatId: string | null = null;
  /** `message_start`'s message id (or a counter when the CLI omits it); every block key is prefixed with it. */
  private currentMessageId: string | null = null;
  private messageCounter = 0;
  /** Blocks between `content_block_start` and `content_block_stop`, by key. */
  private readonly liveBlocks = new Map<string, StreamBlockKind>();
  /** Streamed text / thinking keys per message id, consumed by the complete `assistant` event(s) of that message. */
  private readonly streamed = new Map<string, StreamedMessage>();

  constructor(private readonly worktreePath: string) {}

  parseLine(line: string): StreamEffect[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      // Non-JSON output (a warning, a login hint…) is shown in the terminal only.
      return [{ type: 'render', text: crlf(trimmed) }];
    }
    return this.parseEvent(raw);
  }

  parseEvent(raw: unknown): StreamEffect[] {
    const e = obj(raw);
    if (!e) return [];
    switch (e['type']) {
      case 'system':
        return this.system(e);
      case 'assistant':
        return this.assistant(e);
      case 'user':
        return this.user(e);
      case 'result':
        return this.result(e);
      case 'control_request':
        return this.controlRequest(e);
      case 'rate_limit_event':
        return this.rateLimit(e);
      case 'stream_event':
        return this.streamEvent(e);
      default:
        // `control_response`, `tool_progress`… carry nothing the transcript needs.
        return [];
    }
  }

  private system(e: Json): StreamEffect[] {
    if (e['subtype'] === 'compact_boundary') {
      const meta = obj(e['compact_metadata']);
      const trigger = str(meta?.['trigger']);
      const pre = num(meta?.['pre_tokens']);
      const detail = [trigger, pre !== null ? `${pre} tokens` : null].filter((x) => x !== null).join(' · ');
      return [
        { type: 'transcript', body: copy.chat.controls.compacted, payload: { kind: 'system' } },
        { type: 'render', text: crlf(`· ${copy.chat.controls.compacted}${detail ? ` (${detail})` : ''}`) },
      ];
    }
    if (e['subtype'] !== 'init') return [];
    const chatId = str(e['session_id']) ?? str(e['chat_id']) ?? str(e['chatId']);
    const model = str(e['model']);
    const permissionMode = str(e['permissionMode']) ?? str(e['permission_mode']);
    const slashCommands = chatSlashCommands(e['slash_commands'], e['terminal_slash_commands']);
    this.chatId = chatId;
    return [
      { type: 'init', chatId, model, permissionMode, slashCommands },
      { type: 'session', event: 'activity' },
      { type: 'render', text: crlf(`· session started${model ? ` · ${model}` : ''}`) },
    ];
  }

  /**
   * The complete message. Text and thinking blocks that streamed live (same message id, consumed per kind in block
   * order — the CLI may split one message into one `assistant` event per block) become `streamFinal` instead of new
   * transcript rows; the note and the terminal rendering still come from the final text.
   */
  private assistant(e: Json): StreamEffect[] {
    const message = obj(e['message']);
    const content = message ? message['content'] : e['content'];
    const out: StreamEffect[] = [{ type: 'session', event: 'activity' }];
    const rec = this.streamedRecordFor(e, message);
    const nextKey = (kind: StreamBlockKind): string | undefined =>
      rec ? rec.keys[kind][rec.used[kind]++] : undefined;
    /** Every final text (note + render) vs the texts that still need a transcript row. */
    const texts: string[] = [];
    const unstreamed: string[] = [];
    const edits: string[] = [];
    if (typeof content === 'string') {
      texts.push(content);
      unstreamed.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = obj(block);
        if (!b) continue;
        if (b['type'] === 'text') {
          const t = (str(b['text']) ?? '').trim();
          const key = nextKey('text');
          if (key !== undefined) out.push({ type: 'streamFinal', key, body: t });
          else if (t) unstreamed.push(t);
          if (t) texts.push(t);
        } else if (b['type'] === 'thinking') {
          const t = str(b['thinking']) ?? '';
          const key = nextKey('thinking');
          if (key !== undefined) out.push({ type: 'streamFinal', key, body: t });
          else if (t.trim())
            out.push({
              type: 'transcript',
              body: t,
              payload: { kind: 'thinking', status: 'done', durationMs: null },
            });
        } else if (b['type'] === 'tool_use') {
          const name = str(b['name']) ?? 'tool';
          const input = obj(b['input']) ?? {};
          const id = str(b['id']);
          const hint = toolHint(this.worktreePath, name, input);
          const line = `${name}${hint ? ` ${hint}` : ''}`;
          if (EDIT_TOOLS.test(name)) {
            const p = str(input['file_path']) ?? str(input['notebook_path']);
            if (p) edits.push(relPath(this.worktreePath, p));
            if (id) this.pendingEdits.add(id);
          }
          out.push({
            type: 'transcript',
            body: line,
            payload: { kind: 'tool', tool: name, hint, toolUseId: id, status: 'running', detail: null },
          });
          out.push({ type: 'render', text: crlf(`▸ ${line}`) });
          const bypassed = name === 'Bash' ? cloudCliByFullPath(str(input['command']) ?? '') : null;
          if (bypassed !== null) {
            const warning = fill(copy.chat.controls.bypassWarning, { cli: bypassed });
            out.push({ type: 'transcript', body: warning, payload: { kind: 'system' } });
            out.push({ type: 'render', text: crlf(`! ${warning}`) });
          }
        }
      }
    }
    if (unstreamed.length > 0)
      out.push({ type: 'transcript', body: unstreamed.join('\n\n'), payload: { kind: 'agent' } });
    if (texts.length > 0) {
      const body = texts.join('\n\n');
      out.push({ type: 'note', note: firstLine(body) });
      out.push({ type: 'render', text: crlf(body) });
    }
    if (edits.length > 0) {
      const files = [...new Set(edits)].map((path) => ({ path, added: 0, removed: 0 }));
      out.push({
        type: 'transcript',
        body: files.map((f) => f.path).join(', '),
        payload: { kind: 'file-list', files },
      });
    }
    return out;
  }

  private user(e: Json): StreamEffect[] {
    const message = obj(e['message']);
    const content = message ? message['content'] : e['content'];
    const out: StreamEffect[] = [{ type: 'session', event: 'activity' }];
    if (!Array.isArray(content)) return out;
    let rescan = false;
    for (const block of content) {
      const b = obj(block);
      if (!b || b['type'] !== 'tool_result') continue;
      const id = str(b['tool_use_id']);
      if (id && this.pendingEdits.delete(id)) rescan = true;
      const isError = b['is_error'] === true;
      const text = isError ? resultText(b['content']) : '';
      const detail = text ? firstLine(text, 160) : null;
      if (id) out.push({ type: 'toolResult', toolUseId: id, ok: !isError, detail });
      if (detail) out.push({ type: 'render', text: crlf(`  ! ${detail}`) });
    }
    if (rescan) out.push({ type: 'rescan' });
    return out;
  }

  private result(e: Json): StreamEffect[] {
    const out: StreamEffect[] = [];
    const isError =
      e['is_error'] === true || (typeof e['subtype'] === 'string' && e['subtype'].startsWith('error'));
    const text = str(e['result']) ?? str(e['error']) ?? '';
    const ms = num(e['duration_ms']);
    if (isError) {
      const message = text || String(e['subtype'] ?? 'error');
      out.push({ type: 'error', message });
      out.push({ type: 'render', text: crlf(`! ${firstLine(message, 200)}`) });
    } else {
      out.push({
        type: 'render',
        text: crlf(`— done${ms !== null ? ` in ${(ms / 1000).toFixed(1)}s` : ''}`),
      });
    }
    out.push({
      type: 'usage',
      costUsd: num(e['total_cost_usd']),
      numTurns: num(e['num_turns']),
      durationMs: ms,
    });
    if (this.pendingEdits.size > 0) {
      this.pendingEdits.clear();
      out.push({ type: 'rescan' });
    }
    // The turn is over: any block still open is stopped (main finalises its row) and the streamed records go.
    for (const key of this.liveBlocks.keys()) out.push({ type: 'streamStop', key });
    this.liveBlocks.clear();
    this.streamed.clear();
    this.currentMessageId = null;
    out.push({ type: 'session', event: 'quiet' });
    return out;
  }

  // --- partial messages (`--include-partial-messages`) ---------------------

  /**
   * `{type:'stream_event', event, parent_tool_use_id}`: the Messages API streaming events of the message in flight.
   * Subagent output (`parent_tool_use_id` set) is not streamed — its complete `assistant` events still land as today.
   */
  private streamEvent(e: Json): StreamEffect[] {
    if (typeof e['parent_tool_use_id'] === 'string') return [];
    const ev = obj(e['event']);
    if (!ev) return [];
    switch (ev['type']) {
      case 'message_start': {
        const id = str(obj(ev['message'])?.['id']) ?? this.nextMessageId();
        this.currentMessageId = id;
        this.record(id);
        return [];
      }
      case 'content_block_start': {
        const index = num(ev['index']);
        const block = obj(ev['content_block']);
        const kind = block?.['type'];
        if (index === null || !block || (kind !== 'text' && kind !== 'thinking')) return [];
        const id = this.currentMessageId ?? this.nextMessageId();
        this.currentMessageId = id;
        const key = `${id}:${index}`;
        this.liveBlocks.set(key, kind);
        this.record(id).keys[kind].push(key);
        const out: StreamEffect[] = [{ type: 'streamStart', key, kind }];
        // The API starts blocks empty; any text already there is treated as the first delta.
        const initial = str(block[kind]);
        if (initial) out.push({ type: 'streamDelta', key, text: initial });
        return out;
      }
      case 'content_block_delta': {
        const key = this.liveKey(ev);
        const delta = obj(ev['delta']);
        if (key === null || !delta) return [];
        const text =
          delta['type'] === 'text_delta'
            ? str(delta['text'])
            : delta['type'] === 'thinking_delta'
              ? str(delta['thinking'])
              : null; // signature_delta / input_json_delta carry nothing the transcript shows
        return text ? [{ type: 'streamDelta', key, text }] : [];
      }
      case 'content_block_stop': {
        const key = this.liveKey(ev);
        if (key === null) return [];
        this.liveBlocks.delete(key);
        return [{ type: 'streamStop', key }];
      }
      case 'message_delta': {
        const tokens = num(obj(ev['usage'])?.['output_tokens']);
        return tokens === null ? [] : [{ type: 'streamUsage', outputTokens: tokens }];
      }
      case 'message_stop': {
        // Every block should have stopped already; stragglers are stopped here so no row streams forever.
        const out: StreamEffect[] = [...this.liveBlocks.keys()].map((key) => ({ type: 'streamStop', key }));
        this.liveBlocks.clear();
        return out;
      }
      default:
        return [];
    }
  }

  private nextMessageId(): string {
    this.messageCounter += 1;
    return `msg-${this.messageCounter}`;
  }

  private record(id: string): StreamedMessage {
    let rec = this.streamed.get(id);
    if (!rec) {
      rec = { keys: { text: [], thinking: [] }, used: { text: 0, thinking: 0 } };
      this.streamed.set(id, rec);
    }
    return rec;
  }

  /** The key of a live block addressed by `event.index` within the current message; null when not streaming. */
  private liveKey(ev: Json): string | null {
    const index = num(ev['index']);
    if (index === null || this.currentMessageId === null) return null;
    const key = `${this.currentMessageId}:${index}`;
    return this.liveBlocks.has(key) ? key : null;
  }

  /**
   * The streamed record an `assistant` event reconciles: matched by `message.id`; a message without an id (never
   * a subagent's) falls back to the message currently streaming. Unknown ids were not streamed.
   */
  private streamedRecordFor(e: Json, message: Json | null): StreamedMessage | undefined {
    const id = str(message?.['id']);
    if (id !== null) return this.streamed.get(id);
    if (typeof e['parent_tool_use_id'] === 'string' || this.currentMessageId === null) return undefined;
    return this.streamed.get(this.currentMessageId);
  }

  private controlRequest(e: Json): StreamEffect[] {
    const requestId = str(e['request_id']);
    const request = obj(e['request']);
    if (!requestId || !request || request['subtype'] !== 'can_use_tool') return [];
    const toolName = str(request['tool_name']) ?? 'tool';
    const input = obj(request['input']) ?? {};
    return [
      { type: 'permission', requestId, toolName, input },
      { type: 'render', text: crlf(`? permission: ${toolName}`) },
    ];
  }

  /** `rate_limit_info: {status, rateLimitType, resetsAt}`; only a non-`allowed` status is worth a terminal line. */
  private rateLimit(e: Json): StreamEffect[] {
    const info = obj(e['rate_limit_info']);
    const status = str(info?.['status']) ?? 'unknown';
    if (status === 'allowed') return [];
    const kind = str(info?.['rateLimitType']);
    const resetsAt = num(info?.['resetsAt']);
    const resets = resetsAt !== null ? new Date(resetsAt * (resetsAt < 1e12 ? 1000 : 1)).toISOString() : null;
    return [
      {
        type: 'render',
        text: crlf(
          `· rate limit: ${status}${kind ? ` (${kind})` : ''}${resets ? ` · resets ${resets}` : ''}`,
        ),
      },
    ];
  }
}

/** A base64 image block placed before the text of a user turn (Messages API shape). */
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** The stdin line for one user turn (Claude Code stream-json input): image blocks first, then the text. */
export const userTurnLine = (text: string, blocks: readonly ImageBlock[] = []): string =>
  `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [...blocks, { type: 'text', text }] },
  })}\n`;

/** The stdin line answering a `can_use_tool` control request. */
export const permissionResponseLine = (
  requestId: string,
  allow: boolean,
  input: Record<string, unknown>,
  message?: string,
): string =>
  `${JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: allow
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: message ?? 'Denied in Styx' },
    },
  })}\n`;

// --- Runner -----------------------------------------------------------------

export interface StreamSpawnOptions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input: StreamInput;
  worktreePath: string;
  firstMessage: string | null;
}

export interface StreamEvents {
  effect: [id: string, effect: StreamEffect];
  exit: [id: string, exitCode: number | null];
}

export interface StreamRunnerLike extends EventEmitter<StreamEvents> {
  spawn(opts: StreamSpawnOptions): Promise<{ pid: number }>;
  /** One user turn; `blocks` (images) only reach a stdin runner — an argv runner is text-only and drops them. */
  send(id: string, text: string, blocks?: readonly ImageBlock[]): void;
  /**
   * Answers a `can_use_tool` request. `updatedInput` replaces the echoed tool input on allow (AskUserQuestion answers
   * travel that way); `message` is the deny reason.
   */
  respondPermission(
    id: string,
    requestId: string,
    allow: boolean,
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): void;
  /** Control requests on stdin (Claude Code): live model / permission-mode switches and turn interrupt. */
  setModel(id: string, model: string | null): void;
  setPermissionMode(id: string, mode: string): void;
  interrupt(id: string): void;
  kill(id: string): void;
  has(id: string): boolean;
  killAll(): void;
}

interface Entry {
  opts: StreamSpawnOptions;
  proc: ChildProcess | null;
  parser: StreamParser;
  buffer: string;
  /** Pending `can_use_tool` inputs by request id (echoed back as `updatedInput` on allow). */
  permissions: Map<string, Record<string, unknown>>;
  killed: boolean;
}

export type SpawnFn = typeof spawnChild;

export class StreamRunner extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly spawnFn: SpawnFn = spawnChild) {
    super();
  }

  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    const entry: Entry = {
      opts,
      proc: null,
      parser: new StreamParser(opts.worktreePath),
      buffer: '',
      permissions: new Map(),
      killed: false,
    };
    this.entries.set(opts.id, entry);
    const args =
      opts.input.kind === 'argv' && opts.firstMessage ? [...opts.args, opts.firstMessage] : opts.args;
    const pid = await this.start(entry, args);
    if (opts.input.kind === 'stdin' && opts.firstMessage) this.send(opts.id, opts.firstMessage);
    return { pid };
  }

  private start(entry: Entry, args: string[]): Promise<number> {
    const { opts } = entry;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    Object.assign(env, { NO_COLOR: '1', TERM: 'dumb' }, opts.env);
    const proc = this.spawnFn(opts.command, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    entry.proc = proc;
    entry.buffer = '';
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onStdout(entry, chunk));
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
        logger.warn('stream runner error', { id: opts.id, error: err.message });
        if (!started) {
          this.entries.delete(opts.id);
          reject(err);
        }
      });
      proc.once('close', (code) => this.onClose(entry, proc, code));
    });
  }

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
    for (const effect of entry.parser.parseLine(line)) {
      if (effect.type === 'permission') entry.permissions.set(effect.requestId, effect.input);
      this.emit('effect', entry.opts.id, effect);
    }
  }

  private onClose(entry: Entry, proc: ChildProcess, code: number | null): void {
    if (entry.proc !== proc) return;
    if (entry.buffer.trim()) this.dispatch(entry, entry.buffer);
    entry.buffer = '';
    entry.proc = null;
    if (entry.opts.input.kind === 'argv' && !entry.killed) {
      // One process per turn: the exit ends the turn, not the session.
      this.emit('effect', entry.opts.id, { type: 'session', event: 'quiet' });
      return;
    }
    this.entries.delete(entry.opts.id);
    this.emit('exit', entry.opts.id, code);
  }

  send(id: string, text: string, blocks: readonly ImageBlock[] = []): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.opts.input.kind === 'stdin') {
      entry.proc?.stdin?.write(userTurnLine(text, blocks));
      return;
    }
    if (blocks.length > 0)
      logger.warn('stream runner: argv input is text-only, image blocks dropped', { id, count: blocks.length });
    if (entry.proc) {
      // A turn is still running: cursor-agent has no stdin protocol, so the message waits for the next turn.
      logger.warn('stream runner: turn in progress, message dropped', { id });
      return;
    }
    const chatId = entry.parser.chatId;
    const args = chatId
      ? [...entry.opts.args, entry.opts.input.resumeFlag, chatId, text]
      : [...entry.opts.args, text];
    void this.start(entry, args).catch((e: Error) => {
      this.emit('effect', id, { type: 'error', message: e.message });
      this.entries.delete(id);
      this.emit('exit', id, null);
    });
  }

  respondPermission(
    id: string,
    requestId: string,
    allow: boolean,
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const input = updatedInput ?? entry.permissions.get(requestId) ?? {};
    entry.permissions.delete(requestId);
    entry.proc?.stdin?.write(permissionResponseLine(requestId, allow, input, message));
  }

  /** `{type:'control_request', request_id, request:{subtype, ...}}` on stdin; the CLI answers with a control_response. */
  private sendControl(id: string, request: Record<string, unknown>): void {
    const entry = this.entries.get(id);
    if (!entry?.proc?.stdin || entry.opts.input.kind !== 'stdin') return;
    const requestId = `styx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    entry.proc.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`,
    );
  }

  setModel(id: string, model: string | null): void {
    this.sendControl(id, { subtype: 'set_model', model });
  }

  setPermissionMode(id: string, mode: string): void {
    this.sendControl(id, { subtype: 'set_permission_mode', mode });
  }

  interrupt(id: string): void {
    this.sendControl(id, { subtype: 'interrupt' });
  }

  kill(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.killed = true;
    if (entry.proc) {
      entry.proc.stdin?.end();
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
