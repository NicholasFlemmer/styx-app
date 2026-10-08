import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copy, fill } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { AcpRunner, acpMcpServer, pickAuthMethod, resolveAcpMode } from './acp-runner';
import type { SpawnFn, StreamEffect, StreamSessionSettings, StreamSpawnOptions } from './stream-runner';

/**
 * The Agent Client Protocol runner against a scripted agent on PassThrough pipes (no process, no CLI): the
 * handshake, one prompt with streamed chunks and a tool call, permission round-trips, mode mapping for Gemini-style
 * and Cursor-style ids, resume via session/load, cancel, kill and the client methods Styx does not provide. Neither
 * `gemini` nor `agent` is installed on the verifying machine, so the wire shapes come from the protocol docs
 * (ADR-0017).
 */

type Json = Record<string, unknown>;
const WT = '/tmp/wt';

/** An ACP agent on the far side of the pipes: records what Styx sent, answers when the test says so. */
class FakeAgent {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly proc: ChildProcess;
  readonly received: Json[] = [];
  killed = false;
  private readonly consumed = new Set<number>();
  private readonly waiters: { pred: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];
  private readonly emitter = new EventEmitter();

  constructor() {
    this.proc = Object.assign(this.emitter, {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      pid: 4242,
      kill: () => {
        this.killed = true;
        setImmediate(() => this.emitter.emit('close', null));
        return true;
      },
    }) as unknown as ChildProcess;
    let buf = '';
    this.stdin.on('data', (chunk: Buffer | string) => {
      buf += String(chunk);
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.onLine(JSON.parse(line) as Json);
        nl = buf.indexOf('\n');
      }
    });
    setImmediate(() => this.emitter.emit('spawn'));
  }

  private onLine(m: Json): void {
    this.received.push(m);
    const i = this.waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      this.consumed.add(this.received.length - 1);
      const [w] = this.waiters.splice(i, 1);
      w?.resolve(m);
    }
  }

  /** The next unconsumed message Styx sent that matches (already received, or the next one to arrive). */
  waitFor(pred: (m: Json) => boolean, what = 'message'): Promise<Json> {
    const idx = this.received.findIndex((m, i) => !this.consumed.has(i) && pred(m));
    if (idx >= 0) {
      this.consumed.add(idx);
      return Promise.resolve(this.received[idx] as Json);
    }
    return new Promise<Json>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), 3000);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }
  method(name: string): Promise<Json> {
    return this.waitFor((m) => m['method'] === name, name);
  }
  /** Styx's answer to a request the agent made. */
  answer(id: number): Promise<Json> {
    return this.waitFor((m) => m['id'] === id && m['method'] === undefined, `answer to ${id}`);
  }

  send(m: Json): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }
  respond(id: unknown, result: Json): void {
    this.send({ id, result });
  }
  fail(id: unknown, code: number, message: string, data?: Json): void {
    this.send({ id, error: { code, message, ...(data ? { data } : {}) } });
  }
  notify(method: string, params: Json): void {
    this.send({ method, params });
  }
  update(sessionId: string, update: Json): void {
    this.notify('session/update', { sessionId, update });
  }
  request(id: number, method: string, params: Json): void {
    this.send({ id, method, params });
  }
  close(code: number | null): void {
    this.emitter.emit('close', code);
  }
}

const GEMINI_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'auto_edit', name: 'Auto Edit' },
    { id: 'yolo', name: 'YOLO' },
    { id: 'plan', name: 'Plan' },
  ],
};
const CURSOR_MODES = {
  currentModeId: 'agent',
  availableModes: [
    { id: 'agent', name: 'Agent' },
    { id: 'plan', name: 'Plan' },
    { id: 'ask', name: 'Ask' },
  ],
};
const ALLOW_DENY = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

const settings = (over: Partial<StreamSessionSettings> = {}): StreamSessionSettings => ({
  agent: 'gemini',
  model: null,
  effort: null,
  permissionMode: 'default',
  autoApproveEdits: false,
  resumeSessionId: null,
  projectPath: WT,
  mcp: {
    command: '/shims/styx',
    args: ['mcp'],
    env: { STYX_SESSION_ID: 's1', STYX_BROKER: '/tmp/b.sock', STYX_TOKEN: 'tok-secret' },
  },
  ...over,
});

const opts = (
  over: Partial<Omit<StreamSpawnOptions, 'session'>> & { session?: Partial<StreamSessionSettings> } = {},
): StreamSpawnOptions => {
  const { session, ...rest } = over;
  return {
    id: 's1',
    command: '/opt/gemini',
    args: ['--acp'],
    cwd: WT,
    env: {},
    input: { kind: 'acp' },
    worktreePath: WT,
    firstMessage: 'hi',
    ...rest,
    session: settings(session),
  };
};

interface Harness {
  runner: AcpRunner;
  agent: FakeAgent;
  effects: StreamEffect[];
  exited: Promise<number | null>;
  spawned: { command: string; args: string[]; cwd: string | undefined }[];
  /** Effects of a type, in order. */
  of<T extends StreamEffect['type']>(type: T): Extract<StreamEffect, { type: T }>[];
  until(pred: () => boolean, what?: string): Promise<void>;
}

const harness = (): Harness => {
  const agent = new FakeAgent();
  const spawned: Harness['spawned'] = [];
  const spawnFn = ((command: string, args: string[], o: { cwd?: string }) => {
    spawned.push({ command, args, cwd: o.cwd });
    return agent.proc;
  }) as unknown as SpawnFn;
  const runner = new AcpRunner(spawnFn, '0.1.0-test');
  const effects: StreamEffect[] = [];
  runner.on('effect', (_id, e) => effects.push(e));
  const exited = new Promise<number | null>((resolve) => runner.on('exit', (_id, code) => resolve(code)));
  return {
    runner,
    agent,
    effects,
    exited,
    spawned,
    of: (type) => effects.filter((e): e is Extract<StreamEffect, { type: typeof type }> => e.type === type),
    until: (pred, what = 'condition') =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () =>
          pred()
            ? resolve()
            : Date.now() - t0 > 3000
              ? reject(new Error(`timeout waiting for ${what}`))
              : setTimeout(tick, 5);
        tick();
      }),
  };
};

interface AgentShape {
  loadSession?: boolean;
  image?: boolean;
  authMethods?: Json[];
  sessionId?: string;
  modes?: Json | null;
  configOptions?: Json[];
  models?: Json;
}

/** initialize → session/new, answered the way a v1 agent would. Returns the session/new request Styx sent. */
const handshake = async (agent: FakeAgent, shape: AgentShape = {}): Promise<Json> => {
  const init = await agent.method('initialize');
  agent.respond(init['id'], {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: shape.loadSession ?? true,
      promptCapabilities: { image: shape.image ?? false, audio: false, embeddedContext: false },
    },
    agentInfo: { name: 'fake', version: '0.0.0' },
    authMethods: shape.authMethods ?? [],
  });
  const created = await agent.method('session/new');
  agent.respond(created['id'], {
    sessionId: shape.sessionId ?? 'sess_1',
    ...(shape.modes === null ? {} : { modes: shape.modes ?? GEMINI_MODES }),
    ...(shape.configOptions ? { configOptions: shape.configOptions } : {}),
    ...(shape.models ? { models: shape.models } : {}),
  });
  return created;
};

const params = (m: Json): Json => m['params'] as Json;

describe('AcpRunner: handshake and session start', () => {
  it('initialize declines fs/terminal, session/new carries cwd and the styx MCP server with env pairs, init/catalogue follow', async () => {
    const h = harness();
    const { pid } = await h.runner.spawn(opts({ firstMessage: null }));
    expect(pid).toBe(4242);
    expect(h.spawned).toEqual([{ command: '/opt/gemini', args: ['--acp'], cwd: WT }]);

    const init = await h.agent.method('initialize');
    expect(params(init)).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'styx', title: 'Styx', version: '0.1.0-test' },
    });
    h.agent.respond(init['id'], { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });

    const created = await h.agent.method('session/new');
    expect(params(created)).toEqual({
      cwd: WT,
      mcpServers: [
        {
          type: 'stdio',
          name: 'styx',
          command: '/shims/styx',
          args: ['mcp'],
          env: [
            { name: 'STYX_SESSION_ID', value: 's1' },
            { name: 'STYX_BROKER', value: '/tmp/b.sock' },
            { name: 'STYX_TOKEN', value: 'tok-secret' },
          ],
        },
      ],
    });
    h.agent.respond(created['id'], {
      sessionId: 'sess_9',
      modes: GEMINI_MODES,
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-2.5-pro',
          options: [
            { value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { value: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'fast' },
          ],
        },
      ],
    });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'quiet');
    expect(h.of('init')).toEqual([
      {
        type: 'init',
        chatId: 'sess_9',
        model: 'gemini-2.5-pro',
        permissionMode: 'default',
        slashCommands: [],
      },
    ]);
    expect(h.of('catalogue')).toEqual([
      {
        type: 'catalogue',
        models: [
          {
            id: 'gemini-2.5-pro',
            label: 'Gemini 2.5 Pro',
            description: null,
            efforts: [],
            defaultEffort: null,
            isDefault: true,
            hidden: false,
          },
          {
            id: 'gemini-2.5-flash',
            label: 'Gemini 2.5 Flash',
            description: 'fast',
            efforts: [],
            defaultEffort: null,
            isDefault: false,
            hidden: false,
          },
        ],
      },
    ]);
    // Styx default → Gemini default, which is already current: no set_mode, and no prompt without a first message.
    expect(h.agent.received.map((m) => m['method'])).toEqual(['initialize', 'session/new']);
    expect(h.runner.has('s1')).toBe(true);
  });

  it('a first message becomes the first session/prompt; available_commands_update refreshes the slash list', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'fix the flaky test' }));
    const created = await handshake(h.agent);
    h.agent.update('sess_1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'memory' }, { name: 'help' }, { name: '/help' }],
    });
    const prompt = await h.agent.method('session/prompt');
    expect(params(prompt)).toEqual({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'fix the flaky test' }],
    });
    expect(params(created)['cwd']).toBe(WT);
    await h.until(() => h.of('init').length === 2, 'second init');
    expect(h.of('init')[1]).toEqual({
      type: 'init',
      chatId: 'sess_1',
      model: null,
      permissionMode: 'default',
      slashCommands: ['/help', '/memory'],
    });
  });

  it('resume: session/load with the earlier id when the agent advertises loadSession, session/new when it does not', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { resumeSessionId: 'sess_old' } }));
    const init = await h.agent.method('initialize');
    h.agent.respond(init['id'], { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    const load = await h.agent.method('session/load');
    expect(params(load)['sessionId']).toBe('sess_old');
    expect(params(load)['cwd']).toBe(WT);
    expect((params(load)['mcpServers'] as Json[])[0]?.['name']).toBe('styx');
    h.agent.respond(load['id'], { modes: CURSOR_MODES });
    await h.until(() => h.of('init').length === 1, 'init');
    expect(h.of('init')[0]?.chatId).toBe('sess_old');
    expect(h.agent.received.some((m) => m['method'] === 'session/new')).toBe(false);

    const h2 = harness();
    await h2.runner.spawn(opts({ id: 's2', firstMessage: null, session: { resumeSessionId: 'sess_old' } }));
    const init2 = await h2.agent.method('initialize');
    h2.agent.respond(init2['id'], { protocolVersion: 1, agentCapabilities: { loadSession: false } });
    const created = await h2.agent.method('session/new');
    h2.agent.respond(created['id'], { sessionId: 'sess_fresh' });
    await h2.until(() => h2.of('init').length === 1, 'init');
    expect(h2.of('init')[0]?.chatId).toBe('sess_fresh');
  });

  it('a session/load the agent refuses falls back to session/new with a terminal line', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { resumeSessionId: 'sess_gone' } }));
    await handshakeWithLoadFailure(h);
    await h.until(() => h.of('init').length === 1, 'init');
    expect(h.of('init')[0]?.chatId).toBe('sess_new');
    expect(h.of('render').some((e) => e.text.includes('starting a new one'))).toBe(true);
  });

  const handshakeWithLoadFailure = async (h: Harness) => {
    const init = await h.agent.method('initialize');
    h.agent.respond(init['id'], { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    const load = await h.agent.method('session/load');
    h.agent.fail(load['id'], -32602, 'unknown session');
    const created = await h.agent.method('session/new');
    h.agent.respond(created['id'], { sessionId: 'sess_new' });
  };

  it('auth_required from session/new → authenticate with a non-interactive method, then session/new again', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, env: { GEMINI_API_KEY: 'k' } }));
    const init = await h.agent.method('initialize');
    h.agent.respond(init['id'], {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [
        { id: 'oauth-personal', name: 'Log in with Google' },
        { id: 'gemini-api-key', name: 'Use Gemini API key' },
      ],
    });
    const first = await h.agent.method('session/new');
    h.agent.fail(first['id'], -32000, 'Authentication required', { reason: 'auth_required' });
    const auth = await h.agent.method('authenticate');
    expect(params(auth)).toEqual({ methodId: 'gemini-api-key' });
    h.agent.respond(auth['id'], {});
    const second = await h.agent.method('session/new');
    h.agent.respond(second['id'], { sessionId: 'sess_auth' });
    await h.until(() => h.of('init').length === 1, 'init');
    expect(h.of('init')[0]?.chatId).toBe('sess_auth');
    expect(h.of('error')).toEqual([]);
  });

  it('auth_required with only interactive methods → an error telling the user to sign in with the CLI, then exit', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    const init = await h.agent.method('initialize');
    h.agent.respond(init['id'], {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    });
    const created = await h.agent.method('session/new');
    h.agent.fail(created['id'], -32000, 'Authentication required', { reason: 'auth_required' });
    expect(await h.exited).toBeNull();
    expect(h.of('error')).toEqual([
      { type: 'error', message: fill(copy.acpRunner.signInFirst, { cli: 'Gemini' }) },
    ]);
    expect(h.agent.received.some((m) => m['method'] === 'authenticate')).toBe(false);
    expect(h.runner.has('s1')).toBe(false);
  });

  it('a failed initialize ends the session with a handshake error', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    const init = await h.agent.method('initialize');
    h.agent.fail(init['id'], -32600, 'unsupported protocol version');
    expect(await h.exited).toBeNull();
    expect(h.of('error')[0]?.message).toBe(
      fill(copy.acpRunner.handshakeFailed, { cli: 'Gemini', message: 'unsupported protocol version' }),
    );
  });
});

describe('AcpRunner: one turn', () => {
  it('streams text and thoughts, lands a tool row with its result, asks for permission and finishes the turn', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'hi', session: { permissionMode: 'acceptEdits' } }));
    await handshake(h.agent);
    const setMode = await h.agent.method('session/set_mode');
    expect(params(setMode)).toEqual({ sessionId: 'sess_1', modeId: 'auto_edit' });
    h.agent.respond(setMode['id'], {});

    const prompt = await h.agent.method('session/prompt');
    const sid = 'sess_1';
    h.agent.update(sid, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking…' },
    });
    h.agent.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'po' } });
    h.agent.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ng\n' } });
    h.agent.update(sid, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Run echo',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'echo pong' },
    });
    h.agent.request(100, 'session/request_permission', {
      sessionId: sid,
      toolCall: {
        toolCallId: 'call_1',
        title: 'Run echo',
        kind: 'execute',
        rawInput: { command: 'echo pong' },
      },
      options: ALLOW_DENY,
    });
    await h.until(() => h.of('permission').length === 1, 'permission effect');
    expect(h.of('permission')).toEqual([
      {
        type: 'permission',
        requestId: '100',
        toolName: 'Bash',
        input: { command: 'echo pong', title: 'Run echo', styxEdit: false },
      },
    ]);
    h.runner.respondPermission('s1', '100', true);
    expect(await h.agent.answer(100)).toEqual({
      jsonrpc: '2.0',
      id: 100,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    h.agent.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' });
    h.agent.update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'pong\n' } }],
    });
    h.agent.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } });
    h.agent.respond(prompt['id'], { stopReason: 'end_turn' });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'quiet');

    const seq = h.effects.filter((e) => e.type !== 'render' && e.type !== 'session');
    expect(seq).toEqual([
      { type: 'init', chatId: 'sess_1', model: null, permissionMode: 'acceptEdits', slashCommands: [] },
      { type: 'streamStart', key: 'acp-1:1', kind: 'thinking' },
      { type: 'streamDelta', key: 'acp-1:1', text: 'thinking…' },
      { type: 'streamStop', key: 'acp-1:1' },
      { type: 'streamFinal', key: 'acp-1:1', body: 'thinking…' },
      { type: 'streamStart', key: 'acp-1:2', kind: 'text' },
      { type: 'streamDelta', key: 'acp-1:2', text: 'po' },
      { type: 'streamDelta', key: 'acp-1:2', text: 'ng\n' },
      { type: 'streamStop', key: 'acp-1:2' },
      { type: 'streamFinal', key: 'acp-1:2', body: 'pong' },
      {
        type: 'transcript',
        body: 'Bash echo pong',
        payload: {
          kind: 'tool',
          tool: 'Bash',
          hint: 'echo pong',
          toolUseId: 'call_1',
          status: 'running',
          detail: null,
        },
      },
      {
        type: 'permission',
        requestId: '100',
        toolName: 'Bash',
        input: { command: 'echo pong', title: 'Run echo', styxEdit: false },
      },
      { type: 'toolResult', toolUseId: 'call_1', ok: true, detail: 'pong' },
      { type: 'streamStart', key: 'acp-1:3', kind: 'text' },
      { type: 'streamDelta', key: 'acp-1:3', text: 'done.' },
      { type: 'streamStop', key: 'acp-1:3' },
      { type: 'streamFinal', key: 'acp-1:3', body: 'done.' },
      { type: 'note', note: 'done.' },
      { type: 'usage', costUsd: null, numTurns: 1, durationMs: expect.any(Number) },
    ]);
    // The terminal saw the text, the tool line and the permission ask.
    const rendered = h.of('render').map((e) => e.text);
    expect(rendered).toContain('pong\r\n');
    expect(rendered).toContain('▸ Bash echo pong\r\n');
    expect(rendered).toContain('? permission: Bash echo pong\r\n');
    expect(rendered.some((t) => t.startsWith('— done in'))).toBe(true);
    // Activity was reported while streaming; quiet once, at the end.
    expect(h.of('session').filter((e) => e.event === 'quiet')).toHaveLength(1);
    expect(h.of('session')[0]).toEqual({ type: 'session', event: 'activity' });
  });

  it('an edit tool call: Edit row with the worktree-relative path, rescan on completion, failure detail on the row', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'go' }));
    await handshake(h.agent);
    const prompt = await h.agent.method('session/prompt');
    h.agent.update('sess_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'e1',
      title: 'Edit checkout.ts',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: `${WT}/src/checkout.ts` }],
    });
    h.agent.update('sess_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'r1',
      title: 'Search for TODO',
      kind: 'search',
      status: 'completed',
      rawInput: { pattern: 'TODO' },
    });
    h.agent.update('sess_1', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'permission denied\nmore' } }],
    });
    h.agent.respond(prompt['id'], { stopReason: 'end_turn' });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'quiet');
    expect(h.of('transcript').map((e) => e.payload)).toEqual([
      {
        kind: 'tool',
        tool: 'Edit',
        hint: 'src/checkout.ts',
        toolUseId: 'e1',
        status: 'running',
        detail: null,
      },
      { kind: 'tool', tool: 'Grep', hint: 'TODO', toolUseId: 'r1', status: 'running', detail: null },
    ]);
    expect(h.of('toolResult')).toEqual([
      { type: 'toolResult', toolUseId: 'r1', ok: true, detail: null },
      { type: 'toolResult', toolUseId: 'e1', ok: false, detail: 'permission denied' },
    ]);
    expect(h.of('rescan')).toHaveLength(1);
    expect(h.of('render').map((e) => e.text)).toContain('  ! permission denied\r\n');
  });

  it('a plan lands as an agent row; a tool_call_update for an unknown id is treated as the call itself', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'plan it' }));
    await handshake(h.agent);
    const prompt = await h.agent.method('session/prompt');
    h.agent.update('sess_1', {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the tests', priority: 'high', status: 'completed' },
        { content: 'Fix the bug', priority: 'high', status: 'in_progress' },
        { content: 'Run the suite', priority: 'medium', status: 'pending' },
      ],
    });
    h.agent.update('sess_1', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'late',
      title: 'Fetch docs',
      kind: 'fetch',
      status: 'completed',
      rawInput: { url: 'https://example.test/docs' },
    });
    h.agent.respond(prompt['id'], { stopReason: 'max_turn_requests' });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'quiet');
    expect(h.of('transcript')[0]).toEqual({
      type: 'transcript',
      body: '**Plan**\n- ☑ Read the tests\n- ▸ Fix the bug\n- ☐ Run the suite',
      payload: { kind: 'agent' },
    });
    expect(h.of('transcript')[1]?.payload).toEqual({
      kind: 'tool',
      tool: 'WebFetch',
      hint: 'https://example.test/docs',
      toolUseId: 'late',
      status: 'running',
      detail: null,
    });
    expect(h.of('toolResult')).toEqual([{ type: 'toolResult', toolUseId: 'late', ok: true, detail: null }]);
    expect(
      h
        .of('render')
        .map((e) => e.text)
        .some((t) => t.startsWith('— done (max_turn_requests)')),
    ).toBe(true);
  });

  it('a prompt error becomes an error effect and still ends the turn', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'hi' }));
    await handshake(h.agent);
    const prompt = await h.agent.method('session/prompt');
    h.agent.fail(prompt['id'], -32603, 'model overloaded');
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'quiet');
    expect(h.of('error')).toEqual([
      { type: 'error', message: fill(copy.acpRunner.promptFailed, { message: 'model overloaded' }) },
    ]);
    expect(h.of('usage')).toEqual([
      { type: 'usage', costUsd: null, numTurns: 1, durationMs: expect.any(Number) },
    ]);
  });

  it('messages typed mid-turn queue up (ACP has no steer) and go out one prompt at a time', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'first' }));
    await handshake(h.agent);
    const p1 = await h.agent.method('session/prompt');
    h.runner.send('s1', 'second');
    h.runner.send('s1', 'third');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.agent.received.filter((m) => m['method'] === 'session/prompt')).toHaveLength(1);
    h.agent.respond(p1['id'], { stopReason: 'end_turn' });
    const p2 = await h.agent.method('session/prompt');
    expect((params(p2)['prompt'] as Json[])[0]?.['text']).toBe('second');
    h.agent.respond(p2['id'], { stopReason: 'end_turn' });
    const p3 = await h.agent.method('session/prompt');
    expect((params(p3)['prompt'] as Json[])[0]?.['text']).toBe('third');
    h.agent.respond(p3['id'], { stopReason: 'end_turn' });
    await h.until(() => h.of('usage').length === 3, 'three turns');
    expect(h.of('usage').map((e) => e.numTurns)).toEqual([1, 2, 3]);
  });

  it('images ride along as image blocks when the agent takes them, and are dropped with a system row when not', async () => {
    const block = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' },
    };
    const yes = harness();
    await yes.runner.spawn(opts({ firstMessage: null }));
    await handshake(yes.agent, { image: true });
    await yes.until(() => yes.of('session').some((e) => e.event === 'quiet'), 'ready');
    yes.runner.send('s1', 'look', [block]);
    const p = await yes.agent.method('session/prompt');
    expect(params(p)['prompt']).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);

    const no = harness();
    await no.runner.spawn(opts({ id: 's2', firstMessage: null }));
    await handshake(no.agent, { image: false });
    await no.until(() => no.of('session').some((e) => e.event === 'quiet'), 'ready');
    no.runner.send('s2', 'look', [block]);
    const p2 = await no.agent.method('session/prompt');
    expect(params(p2)['prompt']).toEqual([{ type: 'text', text: 'look' }]);
    expect(no.of('transcript')).toEqual([
      { type: 'transcript', body: fill(copy.acpRunner.imagesDropped, { n: 1 }), payload: { kind: 'system' } },
    ]);
  });

  it('history replayed outside a turn (session/load) is not streamed into the transcript', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { resumeSessionId: 'old' } }));
    const init = await h.agent.method('initialize');
    h.agent.respond(init['id'], { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    const load = await h.agent.method('session/load');
    h.agent.update('old', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'earlier' },
    });
    h.agent.update('old', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'before' },
    });
    h.agent.update('old', { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'old', kind: 'read' });
    h.agent.respond(load['id'], {});
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    expect(h.of('streamStart')).toEqual([]);
    expect(h.of('transcript')).toEqual([]);
  });

  it('usage_update reports tokens and context window; current_mode_update becomes a note', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    await handshake(h.agent);
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    h.agent.update('sess_1', { sessionUpdate: 'usage_update', used: 5300, size: 200000 });
    h.agent.update('sess_1', { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    await h.until(() => h.of('note').length === 1, 'note');
    expect(h.of('usage')).toEqual([
      {
        type: 'usage',
        costUsd: null,
        numTurns: null,
        durationMs: null,
        tokensUsed: 5300,
        contextWindow: 200000,
      },
    ]);
    expect(h.of('note')).toEqual([
      { type: 'note', note: fill(copy.chat.controls.modeChanged, { mode: 'Plan' }) },
    ]);
  });
});

describe('AcpRunner: permission answers', () => {
  const askThenAnswer = async (h: Harness, id: number, options: Json[], allow: boolean, updated?: Json) => {
    h.agent.request(id, 'session/request_permission', {
      sessionId: 'sess_1',
      toolCall: { toolCallId: `c${id}`, title: 'rm -rf build', kind: 'execute' },
      options,
    });
    await h.until(() => h.of('permission').some((e) => e.requestId === String(id)), `ask ${id}`);
    h.runner.respondPermission('s1', String(id), allow, 'no thanks', updated);
    return (await h.agent.answer(id))['result'];
  };

  it('deny picks reject_once, allow-always picks allow_always, and no fitting option answers cancelled', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'hi' }));
    await handshake(h.agent);
    await h.agent.method('session/prompt');
    expect(await askThenAnswer(h, 1, ALLOW_DENY, false)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    expect(await askThenAnswer(h, 2, ALLOW_DENY, true, { always: true })).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' },
    });
    // Only an "always" on offer: allow-once has nothing to pick, so the request is cancelled rather than widened.
    const alwaysOnly = [{ optionId: 'always', name: 'Always', kind: 'allow_always' }];
    expect(await askThenAnswer(h, 3, alwaysOnly, true)).toEqual({ outcome: { outcome: 'cancelled' } });
    // A reject with no reject_once (never reject_always) is cancelled too.
    const rejectAlways = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'never', name: 'Never', kind: 'reject_always' },
    ];
    expect(await askThenAnswer(h, 4, rejectAlways, false)).toEqual({ outcome: { outcome: 'cancelled' } });
    // The tool name comes from the kind; the command from the title when rawInput has none.
    expect(h.of('permission')[0]).toEqual({
      type: 'permission',
      requestId: '1',
      toolName: 'Bash',
      input: { title: 'rm -rf build', command: 'rm -rf build', styxEdit: false },
    });
  });

  it('a v2-shaped request (subject.toolCall) resolves through the earlier tool_call row', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'hi' }));
    await handshake(h.agent);
    await h.agent.method('session/prompt');
    h.agent.update('sess_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'w1',
      title: 'Write notes',
      kind: 'edit',
      locations: [{ path: `${WT}/notes.md` }],
    });
    h.agent.request(9, 'session/request_permission', {
      sessionId: 'sess_1',
      title: 'Approve file edit?',
      subject: { type: 'tool_call', toolCall: { toolCallId: 'w1' } },
      options: ALLOW_DENY,
    });
    await h.until(() => h.of('permission').length === 1, 'ask');
    expect(h.of('permission')[0]).toEqual({
      type: 'permission',
      requestId: '9',
      toolName: 'Edit',
      input: {
        title: 'Write notes',
        file_path: `${WT}/notes.md`,
        locations: [`${WT}/notes.md`],
        styxEdit: true,
      },
    });
  });

  it('answering an unknown request id is a no-op', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    await handshake(h.agent);
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    const before = h.agent.received.length;
    h.runner.respondPermission('s1', 'nope', true);
    h.runner.respondPermission('other', '1', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.agent.received.length).toBe(before);
  });
});

describe('AcpRunner: modes, model, effort', () => {
  it('Gemini-style ids: set_mode on spawn (plan) and on setPermissionMode (bypass → yolo, acceptEdits → auto_edit)', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { permissionMode: 'plan' } }));
    await handshake(h.agent);
    const first = await h.agent.method('session/set_mode');
    expect(params(first)).toEqual({ sessionId: 'sess_1', modeId: 'plan' });
    h.agent.respond(first['id'], {});
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');

    h.runner.setPermissionMode('s1', 'bypassPermissions');
    const second = await h.agent.method('session/set_mode');
    expect(params(second)['modeId']).toBe('yolo');
    h.agent.respond(second['id'], {});
    h.runner.setPermissionMode('s1', 'acceptEdits');
    const third = await h.agent.method('session/set_mode');
    expect(params(third)['modeId']).toBe('auto_edit');
    h.agent.respond(third['id'], {});
    // Same agent mode again (dontAsk → yolo → … acceptEdits is current): a repeat is not re-sent.
    h.runner.setPermissionMode('s1', 'acceptEdits');
    h.runner.setPermissionMode('s1', 'not-a-mode');
    await new Promise((r) => setTimeout(r, 10));
    expect(h.agent.received.filter((m) => m['method'] === 'session/set_mode')).toHaveLength(3);
    expect(h.of('transcript')).toEqual([]); // exact mappings are silent
  });

  it('Cursor-style ids: default is already agent (no set_mode); plan → plan; dontAsk → agent', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { agent: 'cursor' } }));
    await handshake(h.agent, { modes: CURSOR_MODES });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    expect(h.agent.received.some((m) => m['method'] === 'session/set_mode')).toBe(false);
    h.runner.setPermissionMode('s1', 'plan');
    const plan = await h.agent.method('session/set_mode');
    expect(params(plan)['modeId']).toBe('plan');
    h.agent.respond(plan['id'], {});
    h.runner.setPermissionMode('s1', 'dontAsk');
    const agent = await h.agent.method('session/set_mode');
    expect(params(agent)['modeId']).toBe('agent');
    h.agent.respond(agent['id'], {});
  });

  it('unknown ids: the closest mode by name is picked and noted; nothing fitting leaves the mode with a system row', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { permissionMode: 'bypassPermissions' } }));
    await handshake(h.agent, {
      modes: {
        currentModeId: 'normal',
        availableModes: [
          { id: 'normal', name: 'Normal' },
          { id: 'full-auto', name: 'Full auto' },
        ],
      },
    });
    const set = await h.agent.method('session/set_mode');
    expect(params(set)['modeId']).toBe('full-auto');
    h.agent.respond(set['id'], {});
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    expect(h.of('transcript')).toEqual([
      {
        type: 'transcript',
        body: fill(copy.acpRunner.modeMapped, { mode: 'Bypass permissions', agentMode: 'Full auto' }),
        payload: { kind: 'system' },
      },
    ]);
    h.runner.setPermissionMode('s1', 'plan');
    await h.until(() => h.of('transcript').length === 2, 'no-mode row');
    expect(h.of('transcript')[1]?.body).toBe(
      fill(copy.acpRunner.noMode, { mode: 'Plan mode', current: 'Full auto' }),
    );
    expect(h.agent.received.filter((m) => m['method'] === 'session/set_mode')).toHaveLength(1);
  });

  it('a refused set_mode is reported in the transcript, not thrown', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { permissionMode: 'plan' } }));
    await handshake(h.agent);
    const set = await h.agent.method('session/set_mode');
    h.agent.fail(set['id'], -32602, 'plan mode is disabled');
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    expect(h.of('transcript')[0]?.body).toBe(
      fill(copy.acpRunner.modeFailed, { mode: 'Plan mode', message: 'plan mode is disabled' }),
    );
  });

  it('a v2 agent with the mode as a config option switches through session/set_config_option', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { permissionMode: 'plan' } }));
    await handshake(h.agent, {
      modes: null,
      configOptions: [
        {
          id: 'session-mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });
    const set = await h.agent.method('session/set_config_option');
    expect(params(set)).toEqual({ sessionId: 'sess_1', configId: 'session-mode', type: 'id', value: 'plan' });
    h.agent.respond(set['id'], { configOptions: [] });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    expect(h.agent.received.some((m) => m['method'] === 'session/set_mode')).toBe(false);
  });

  it('model: a config option switches with set_config_option; the requested launch model is applied when it differs', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null, session: { model: 'gemini-2.5-flash' } }));
    await handshake(h.agent, {
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-2.5-pro',
          options: [{ value: 'gemini-2.5-pro' }, { value: 'gemini-2.5-flash' }],
        },
      ],
    });
    const first = await h.agent.method('session/set_config_option');
    expect(params(first)).toEqual({
      sessionId: 'sess_1',
      configId: 'model',
      type: 'id',
      value: 'gemini-2.5-flash',
    });
    h.agent.respond(first['id'], { configOptions: [] });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    h.runner.setModel('s1', 'gemini-2.5-pro');
    const second = await h.agent.method('session/set_config_option');
    expect(params(second)['value']).toBe('gemini-2.5-pro');
    h.agent.respond(second['id'], { configOptions: [] });
    // "Default model" (null) goes back to the model that was current at session start.
    h.runner.setModel('s1', null);
    const third = await h.agent.method('session/set_config_option');
    expect(params(third)['value']).toBe('gemini-2.5-pro');
  });

  it("model: Gemini's models block switches with session/set_model; an agent without either gets a system row", async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    await handshake(h.agent, {
      models: {
        currentModelId: 'gemini-2.5-pro',
        availableModels: [
          { modelId: 'gemini-2.5-pro', name: 'Pro' },
          { modelId: 'gemini-2.5-flash', name: 'Flash' },
        ],
      },
    });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    expect(h.of('catalogue')[0]?.models.map((m) => [m.id, m.label, m.isDefault])).toEqual([
      ['gemini-2.5-pro', 'Pro', true],
      ['gemini-2.5-flash', 'Flash', false],
    ]);
    h.runner.setModel('s1', 'gemini-2.5-flash');
    const set = await h.agent.method('session/set_model');
    expect(params(set)).toEqual({ sessionId: 'sess_1', modelId: 'gemini-2.5-flash' });
    h.agent.respond(set['id'], {});

    const bare = harness();
    await bare.runner.spawn(opts({ id: 's2', firstMessage: null }));
    await handshake(bare.agent);
    await bare.until(() => bare.of('session').some((e) => e.event === 'quiet'), 'ready');
    bare.runner.setModel('s2', 'anything');
    bare.runner.setEffort('s2', 'high');
    await bare.until(() => bare.of('transcript').length === 1, 'row');
    expect(bare.of('transcript')[0]?.body).toBe(copy.acpRunner.noModelSwitch);
    expect(bare.of('render').map((e) => e.text)).toContain(`· ${copy.acpRunner.noEffort}\r\n`);
    expect(bare.agent.received.map((m) => m['method'])).toEqual(['initialize', 'session/new']);
  });
});

describe('AcpRunner: cancel, kill, unsupported client methods', () => {
  it('interrupt sends session/cancel and answers a pending permission with cancelled; the turn ends as interrupted', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'hi' }));
    await handshake(h.agent);
    const prompt = await h.agent.method('session/prompt');
    h.agent.request(5, 'session/request_permission', {
      sessionId: 'sess_1',
      toolCall: { toolCallId: 'c', title: 'x', kind: 'execute' },
      options: ALLOW_DENY,
    });
    await h.until(() => h.of('permission').length === 1, 'ask');
    h.runner.interrupt('s1');
    expect((await h.agent.answer(5))['result']).toEqual({ outcome: { outcome: 'cancelled' } });
    const cancel = await h.agent.method('session/cancel');
    expect(cancel['id']).toBeUndefined();
    expect(params(cancel)).toEqual({ sessionId: 'sess_1' });
    h.agent.respond(prompt['id'], { stopReason: 'cancelled' });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'quiet');
    expect(h.of('render').map((e) => e.text)).toContain(`— ${copy.chat.controls.interrupted}\r\n`);
    expect(h.of('error')).toEqual([]);
  });

  it('fs/* and terminal/* requests are answered with method-not-found', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    await handshake(h.agent);
    h.agent.request(7, 'fs/read_text_file', { sessionId: 'sess_1', path: '/etc/passwd' });
    h.agent.request(8, 'terminal/create', { sessionId: 'sess_1', command: 'ls' });
    expect(await h.agent.answer(7)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Styx does not provide fs/read_text_file' },
    });
    expect((await h.agent.answer(8))['error']).toEqual({
      code: -32601,
      message: 'Styx does not provide terminal/create',
    });
  });

  it('kill ends stdin and the process; the exit is reported once and the entry is gone', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: 'hi' }));
    await handshake(h.agent);
    await h.agent.method('session/prompt');
    h.runner.kill('s1');
    expect(await h.exited).toBeNull();
    expect(h.agent.killed).toBe(true);
    expect(h.runner.has('s1')).toBe(false);
    // Nothing more comes out of a dead turn.
    expect(h.of('usage')).toEqual([]);
    h.runner.kill('s1');
    h.runner.send('s1', 'ignored');
  });

  it('the process dying on its own during the handshake ends with exit, no error effect for a session already gone', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    await h.agent.method('initialize');
    h.agent.close(1);
    expect(await h.exited).toBe(1);
    expect(h.of('error')).toEqual([]);
    expect(h.runner.has('s1')).toBe(false);
  });

  it('stderr and non-JSON stdout lines reach the terminal only; killAll empties the runner', async () => {
    const h = harness();
    await h.runner.spawn(opts({ firstMessage: null }));
    h.agent.stderr.write('warning: update available\n');
    h.agent.stdout.write('not json\n');
    await h.until(() => h.of('render').length === 2, 'render');
    expect(h.of('render').map((e) => e.text)).toEqual(['warning: update available\r\n', 'not json\r\n']);
    h.runner.killAll();
    expect(await h.exited).toBeNull();
    expect(h.runner.has('s1')).toBe(false);
  });
});

/**
 * OpenCode 1.18.35, as captured from a real `opencode acp` run (docs/research/agent-parity.md): modes and models are
 * config options, the mode list holds OpenCode's primary agents (the `styx-*` ones come from the launch config), and a
 * tool call is announced before its input is known; the command or path arrives with the permission request.
 */
describe('AcpRunner: OpenCode', () => {
  const OPENCODE_CONFIG = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opencode/big-pickle',
      options: [
        { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
        { value: 'anthropic/claude-sonnet-4-5', name: 'Anthropic/Claude Sonnet 4.5' },
      ],
    },
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'build',
      options: [
        {
          value: 'build',
          name: 'build',
          description: 'The default agent. Executes tools based on configured permissions.',
        },
        { value: 'plan', name: 'plan', description: 'Plan mode. Disallows all edit tools.' },
        { value: 'styx-accept-edits', name: 'styx-accept-edits' },
        { value: 'styx-bypass', name: 'styx-bypass' },
        { value: 'styx-dont-ask', name: 'styx-dont-ask' },
      ],
    },
  ];
  const OPENCODE_OPTIONS = [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  ];
  const start = async (session: Partial<StreamSessionSettings> = {}, firstMessage: string | null = null) => {
    const h = harness();
    await h.runner.spawn(
      opts({
        command: '/bin/opencode',
        args: ['acp'],
        firstMessage,
        session: { agent: 'opencode', ...session },
      }),
    );
    await handshake(h.agent, { modes: null, configOptions: OPENCODE_CONFIG, sessionId: 'ses_1' });
    return h;
  };

  it('default stays on build (no switch); the launch model and later modes go through set_config_option', async () => {
    const h = await start({ model: 'anthropic/claude-sonnet-4-5' });
    const model = await h.agent.method('session/set_config_option');
    expect(params(model)).toEqual({
      sessionId: 'ses_1',
      configId: 'model',
      type: 'id',
      value: 'anthropic/claude-sonnet-4-5',
    });
    h.agent.respond(model['id'], { configOptions: OPENCODE_CONFIG });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    expect(h.of('catalogue')[0]?.models.map((m) => m.id)).toEqual([
      'opencode/big-pickle',
      'anthropic/claude-sonnet-4-5',
    ]);
    for (const [mode, id] of [
      ['acceptEdits', 'styx-accept-edits'],
      ['bypassPermissions', 'styx-bypass'],
      ['dontAsk', 'styx-dont-ask'],
      ['plan', 'plan'],
      ['default', 'build'],
    ] as const) {
      h.runner.setPermissionMode('s1', mode);
      const set = await h.agent.method('session/set_config_option');
      expect(params(set)).toEqual({ sessionId: 'ses_1', configId: 'mode', type: 'id', value: id });
      h.agent.respond(set['id'], {});
    }
    expect(h.agent.received.some((m) => m['method'] === 'session/set_mode')).toBe(false);
    expect(h.of('transcript')).toEqual([]); // exact mappings are silent
  });

  it('the Allow/Deny card shows the command and path the permission request carries, not the bare announcement', async () => {
    const h = await start({}, 'hi');
    await h.agent.method('session/prompt');
    h.agent.update('ses_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_b',
      title: 'bash',
      kind: 'execute',
      status: 'pending',
      locations: [{ path: WT }],
      rawInput: { cwd: WT },
    });
    h.agent.request(0, 'session/request_permission', {
      sessionId: 'ses_1',
      toolCall: {
        toolCallId: 'call_b',
        title: 'echo hi',
        kind: 'execute',
        status: 'pending',
        locations: [],
        rawInput: { command: 'echo hi' },
      },
      options: OPENCODE_OPTIONS,
    });
    await h.until(() => h.of('permission').length === 1, 'bash ask');
    expect(h.of('permission')[0]).toMatchObject({
      requestId: '0',
      toolName: 'Bash',
      input: { command: 'echo hi', cwd: WT, styxEdit: false },
    });
    h.runner.respondPermission('s1', '0', false);
    expect((await h.agent.answer(0))['result']).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });

    h.agent.update('ses_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_w',
      title: 'write',
      kind: 'edit',
      status: 'pending',
      locations: [],
      rawInput: {},
    });
    h.agent.request(1, 'session/request_permission', {
      sessionId: 'ses_1',
      toolCall: {
        toolCallId: 'call_w',
        title: `${WT}/a.txt`,
        kind: 'edit',
        status: 'pending',
        locations: [{ path: `${WT}/a.txt` }],
        rawInput: { filepath: `${WT}/a.txt`, diff: '+hi' },
      },
      options: OPENCODE_OPTIONS,
    });
    await h.until(() => h.of('permission').length === 2, 'edit ask');
    expect(h.of('permission')[1]).toMatchObject({
      requestId: '1',
      toolName: 'Edit',
      input: {
        file_path: `${WT}/a.txt`,
        filepath: `${WT}/a.txt`,
        locations: [`${WT}/a.txt`],
        styxEdit: true,
      },
    });
    h.runner.respondPermission('s1', '1', true);
    expect((await h.agent.answer(1))['result']).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
  });

  it('a command named only in the request’s title, and a path only as `filepath`, still reach the card', async () => {
    const h = await start({}, 'hi');
    await h.agent.method('session/prompt');
    h.agent.update('ses_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'b',
      title: 'bash',
      kind: 'execute',
      rawInput: {},
    });
    h.agent.request(3, 'session/request_permission', {
      sessionId: 'ses_1',
      toolCall: { toolCallId: 'b', title: 'npm test', kind: 'execute' },
      options: OPENCODE_OPTIONS,
    });
    await h.until(() => h.of('permission').length === 1, 'bash ask');
    expect(h.of('permission')[0]?.input['command']).toBe('npm test');
    h.agent.update('ses_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'w',
      title: 'write',
      kind: 'edit',
      rawInput: {},
    });
    h.agent.request(4, 'session/request_permission', {
      sessionId: 'ses_1',
      toolCall: { toolCallId: 'w', kind: 'edit', rawInput: { filePath: `${WT}/b.txt` } },
      options: OPENCODE_OPTIONS,
    });
    await h.until(() => h.of('permission').length === 2, 'edit ask');
    expect(h.of('permission')[1]?.input).toMatchObject({ file_path: `${WT}/b.txt`, styxEdit: true });
  });

  it('a mode its launch config lacks is refused with a system row, not mapped to a look-alike', async () => {
    const h = harness();
    await h.runner.spawn(
      opts({ command: '/bin/opencode', args: ['acp'], firstMessage: null, session: { agent: 'opencode' } }),
    );
    const stock = OPENCODE_CONFIG.map((o) =>
      o.id === 'mode'
        ? {
            ...o,
            options: [
              ...o.options.filter((m) => !m.value.startsWith('styx-')),
              { value: 'auto-yes', name: 'auto-yes' },
            ],
          }
        : o,
    );
    await handshake(h.agent, { modes: null, configOptions: stock, sessionId: 'ses_1' });
    await h.until(() => h.of('session').some((e) => e.event === 'quiet'), 'ready');
    h.runner.setPermissionMode('s1', 'dontAsk');
    await h.until(() => h.of('transcript').length === 1, 'no-mode row');
    expect(h.of('transcript')[0]?.body).toBe(
      fill(copy.acpRunner.noMode, { mode: "Don't ask", current: 'build' }),
    );
    expect(h.agent.received.some((m) => m['method'] === 'session/set_config_option')).toBe(false);
  });

  it('a permission request cannot turn an announced command into an edit', async () => {
    const h = await start({}, 'hi');
    await h.agent.method('session/prompt');
    h.agent.update('ses_1', { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'bash', kind: 'execute' });
    h.agent.request(2, 'session/request_permission', {
      sessionId: 'ses_1',
      toolCall: {
        toolCallId: 'c',
        kind: 'edit',
        locations: [{ path: `${WT}/x` }],
        rawInput: { command: 'rm -rf /' },
      },
      options: OPENCODE_OPTIONS,
    });
    await h.until(() => h.of('permission').length === 1, 'ask');
    expect(h.of('permission')[0]).toMatchObject({
      toolName: 'Bash',
      input: { command: 'rm -rf /', styxEdit: false },
    });
  });
});

describe('resolveAcpMode / pickAuthMethod / acpMcpServer', () => {
  const gemini = GEMINI_MODES.availableModes;
  const cursor = CURSOR_MODES.availableModes;
  it.each([
    ['default', gemini, 'default', true],
    ['acceptEdits', gemini, 'auto_edit', true],
    ['plan', gemini, 'plan', true],
    ['bypassPermissions', gemini, 'yolo', true],
    ['dontAsk', gemini, 'yolo', true],
    ['auto', gemini, 'auto_edit', true],
    ['default', cursor, 'agent', true],
    ['acceptEdits', cursor, 'agent', true],
    ['plan', cursor, 'plan', true],
    ['bypassPermissions', cursor, 'agent', true],
    ['dontAsk', cursor, 'agent', true],
    ['auto', cursor, 'agent', true],
    // Gemini without plan mode enabled: plan has nowhere to go.
    ['plan', gemini.filter((m) => m.id !== 'plan'), null, false],
    // Unknown vocabularies: closest by id or name.
    ['acceptEdits', [{ id: 'safe' }, { id: 'edits-ok', name: 'Auto-apply edits' }], 'edits-ok', false],
    ['default', [{ id: 'ask-first', name: 'Ask first' }, { id: 'agentic' }], 'agentic', false],
    ['bypassPermissions', [{ id: 'x' }, { id: 'y', name: 'Dangerously skip' }], 'y', false],
    ['auto', [{ id: 'careful' }], null, false],
  ] as const)('%s over %j → %s', (mode, available, id, exact) => {
    const r = resolveAcpMode(mode, available);
    expect(r === null ? null : r.id).toBe(id);
    if (r !== null) expect(r.exact).toBe(exact);
  });

  // OpenCode's modes are its primary agents: a user's own agent named like another CLI's mode never wins.
  const opencode = [
    'build',
    'plan',
    'agent',
    'default',
    'styx-accept-edits',
    'styx-bypass',
    'styx-dont-ask',
  ].map((id) => ({ id }));
  it.each([
    ['default', 'build'],
    ['acceptEdits', 'styx-accept-edits'],
    ['auto', 'styx-accept-edits'],
    ['plan', 'plan'],
    ['bypassPermissions', 'styx-bypass'],
    ['dontAsk', 'styx-dont-ask'],
  ] as const)('opencode: %s → %s', (mode, id) => {
    expect(resolveAcpMode(mode, opencode, 'opencode')).toEqual({ id, exact: true });
  });

  it('opencode fails closed: a mode its launch config should have defined but did not is null, never a name guess', () => {
    const stock = [{ id: 'build' }, { id: 'plan' }, { id: 'yolo-auto', name: 'Full auto' }];
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as const)
      expect(resolveAcpMode(mode, stock, 'opencode')).toBeNull();
    // The same list for an agent without its own table still gets the closest name.
    expect(resolveAcpMode('dontAsk', stock)?.id).toBe('yolo-auto');
  });

  it('the session agent’s own table only: a Gemini id another agent happens to list is not taken as exact', () => {
    expect(resolveAcpMode('default', [{ id: 'default' }, { id: 'build' }], 'opencode')).toEqual({
      id: 'build',
      exact: true,
    });
    expect(resolveAcpMode('default', [{ id: 'build' }, { id: 'default' }], 'gemini')).toEqual({
      id: 'default',
      exact: true,
    });
  });

  it.each([
    [[{ id: 'oauth-personal' }, { id: 'gemini-api-key' }], { GEMINI_API_KEY: 'k' }, 'gemini-api-key'],
    [[{ id: 'oauth-personal' }, { id: 'gemini-api-key' }], {}, null],
    [[{ id: 'vertex-ai' }], { GOOGLE_CLOUD_PROJECT: 'p' }, 'vertex-ai'],
    [[{ id: 'vertex-ai' }], {}, null],
    [[{ id: 'cursor_login' }], {}, 'cursor_login'],
    [[{ id: 'oauth-personal' }], { GEMINI_API_KEY: 'k' }, null],
    [[], { GEMINI_API_KEY: 'k' }, null],
  ] as const)('pickAuthMethod(%j, %j) → %s', (methods, env, expected) => {
    expect(pickAuthMethod(methods, env)).toBe(expected);
  });

  it('acpMcpServer: a stdio entry with env as name/value pairs', () => {
    expect(acpMcpServer({ command: '/s/styx', args: ['mcp'], env: { A: '1', B: '2' } })).toEqual({
      type: 'stdio',
      name: 'styx',
      command: '/s/styx',
      args: ['mcp'],
      env: [
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
      ],
    });
  });
});
