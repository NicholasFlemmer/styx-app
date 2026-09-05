import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute, relative, sep } from 'node:path';
import type { MessagePayload } from '@styx/core';
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
  | { type: 'init'; chatId: string | null; model: string | null }
  | { type: 'transcript'; body: string; payload: MessagePayload }
  | { type: 'session'; event: 'activity' | 'quiet' }
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

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

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
 * Turns one stream-json event into transcript messages, session-machine events and xterm text. Stateless apart
 * from the tool_use ids of pending edits (so the matching tool_result triggers a hunk rescan) and the chat id.
 */
export class StreamParser {
  private readonly pendingEdits = new Set<string>();
  chatId: string | null = null;

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
      default:
        return [];
    }
  }

  private system(e: Json): StreamEffect[] {
    if (e['subtype'] !== 'init') return [];
    const chatId = str(e['session_id']) ?? str(e['chat_id']) ?? str(e['chatId']);
    const model = str(e['model']);
    this.chatId = chatId;
    return [
      { type: 'init', chatId, model },
      { type: 'session', event: 'activity' },
      { type: 'render', text: crlf(`· session started${model ? ` · ${model}` : ''}`) },
    ];
  }

  private assistant(e: Json): StreamEffect[] {
    const message = obj(e['message']);
    const content = message ? message['content'] : e['content'];
    const out: StreamEffect[] = [{ type: 'session', event: 'activity' }];
    const texts: string[] = [];
    const edits: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = obj(block);
        if (!b) continue;
        if (b['type'] === 'text') {
          const t = str(b['text']);
          if (t && t.trim()) texts.push(t.trim());
        } else if (b['type'] === 'tool_use') {
          const name = str(b['name']) ?? 'tool';
          const input = obj(b['input']) ?? {};
          const id = str(b['id']);
          if (EDIT_TOOLS.test(name)) {
            const p = str(input['file_path']) ?? str(input['notebook_path']);
            if (p) edits.push(relPath(this.worktreePath, p));
            if (id) this.pendingEdits.add(id);
            out.push({
              type: 'render',
              text: crlf(`▸ ${name} ${p ? relPath(this.worktreePath, p) : ''}`.trimEnd()),
            });
          } else {
            const hint =
              str(input['command']) ??
              str(input['pattern']) ??
              str(input['file_path']) ??
              str(input['description']) ??
              '';
            out.push({ type: 'render', text: crlf(`▸ ${name}${hint ? ` ${firstLine(hint, 100)}` : ''}`) });
          }
        }
      }
    }
    if (texts.length > 0) {
      const body = texts.join('\n\n');
      out.push({ type: 'transcript', body, payload: { kind: 'agent' } });
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
      if (b['is_error'] === true) {
        const text = typeof b['content'] === 'string' ? b['content'] : '';
        if (text) out.push({ type: 'render', text: crlf(`  ! ${firstLine(text, 160)}`) });
      }
    }
    if (rescan) out.push({ type: 'rescan' });
    return out;
  }

  private result(e: Json): StreamEffect[] {
    const out: StreamEffect[] = [];
    const isError =
      e['is_error'] === true || (typeof e['subtype'] === 'string' && e['subtype'].startsWith('error'));
    const text = str(e['result']) ?? str(e['error']) ?? '';
    if (isError) {
      const message = text || String(e['subtype'] ?? 'error');
      out.push({ type: 'error', message });
      out.push({ type: 'render', text: crlf(`! ${firstLine(message, 200)}`) });
    } else {
      const ms = typeof e['duration_ms'] === 'number' ? e['duration_ms'] : null;
      out.push({
        type: 'render',
        text: crlf(`— done${ms !== null ? ` in ${(ms / 1000).toFixed(1)}s` : ''}`),
      });
    }
    if (this.pendingEdits.size > 0) {
      this.pendingEdits.clear();
      out.push({ type: 'rescan' });
    }
    out.push({ type: 'session', event: 'quiet' });
    return out;
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
}

/** The stdin line for one user turn (Claude Code stream-json input). */
export const userTurnLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;

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
  send(id: string, text: string): void;
  respondPermission(id: string, requestId: string, allow: boolean, message?: string): void;
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

  send(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.opts.input.kind === 'stdin') {
      entry.proc?.stdin?.write(userTurnLine(text));
      return;
    }
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

  respondPermission(id: string, requestId: string, allow: boolean, message?: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const input = entry.permissions.get(requestId) ?? {};
    entry.permissions.delete(requestId);
    entry.proc?.stdin?.write(permissionResponseLine(requestId, allow, input, message));
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
