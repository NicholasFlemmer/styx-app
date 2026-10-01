import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { PermissionMode } from '@styx/core';
import { describe, expect, it } from 'vitest';
import type { JsonRpcId } from './app-server-client';
import { AppServerRunner, rateLimitNote, type AppServerProcess } from './app-server-runner';
import type { StreamEffect, StreamSpawnOptions } from './stream-runner';

const WT = '/tmp/styx-probe-dir/repo';
const PROJECT = '/tmp/styx-probe-dir/main';

// --- The recorded turn (codex 0.154.0, "reply with the single word pong") ------------

type Line = { id?: JsonRpcId; method?: string; params?: unknown; result?: unknown };
const FIXTURE: Line[] = readFileSync(join(__dirname, '__fixtures__/codex-app-server/pong.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Line);
const resultOf = (id: number): unknown => FIXTURE.find((l) => l.id === id)?.result;
const NOTIFICATIONS = FIXTURE.filter((l) => l.method !== undefined);
const THREAD_ID = '01a0a91e-aab6-7ff1-aa36-dd6f70da0bf7';
const TURN_ID = '01a0a91e-ab76-7960-ae34-606d81f93b35';
const MSG_ID = 'msg_0913afe65ef88bc3016aaa45501aa887d2accbfbbed37f9e1c';

const MODEL_LIST = {
  data: [
    {
      id: 'gpt-6-astra',
      model: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      description: 'Frontier',
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
        { reasoningEffort: 'ultra', description: '' },
        { reasoningEffort: 'turbo', description: 'not a Styx effort' },
      ],
      defaultReasoningEffort: 'low',
      isDefault: true,
    },
    {
      id: 'gpt-reserve',
      model: 'gpt-reserve',
      displayName: '',
      description: null,
      hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
      defaultReasoningEffort: 'nope',
      isDefault: false,
    },
  ],
  nextCursor: null,
};
const CATALOGUE = [
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'Frontier',
    efforts: ['low', 'medium', 'ultra'],
    defaultEffort: 'low',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'gpt-reserve',
    label: 'gpt-reserve',
    description: null,
    efforts: ['medium'],
    defaultEffort: null,
    isDefault: false,
    hidden: true,
  },
];

// --- A fake `codex app-server` behind PassThrough pipes -------------------------------

class FakeProc extends EventEmitter implements AppServerProcess {
  pid = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

type Handler = (params: unknown, id: JsonRpcId) => unknown;

class FakeServer {
  readonly proc = new FakeProc();
  /** Client → server requests, in order. */
  readonly requests: { id: JsonRpcId; method: string; params: unknown }[] = [];
  readonly notifications: { method: string; params: unknown }[] = [];
  /** Client answers to server → client requests. */
  readonly answers: { id: JsonRpcId; result?: unknown; error?: unknown }[] = [];
  private readonly handlers = new Map<string, Handler>();
  private buffer = '';

  constructor() {
    this.proc.stdin.setEncoding('utf8');
    this.proc.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        this.onLine(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf('\n');
      }
    });
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    const m = JSON.parse(line) as {
      id?: JsonRpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (m.method !== undefined && m.id !== undefined) {
      this.requests.push({ id: m.id, method: m.method, params: m.params });
      const h = this.handlers.get(m.method);
      if (h === undefined) return this.error(m.id, -32601, `no handler for ${m.method}`);
      try {
        this.respond(m.id, h(m.params, m.id));
      } catch (e) {
        this.error(m.id, -32000, (e as Error).message);
      }
      return;
    }
    if (m.method !== undefined) {
      this.notifications.push({ method: m.method, params: m.params });
      return;
    }
    if (m.id !== undefined) this.answers.push({ id: m.id, result: m.result, error: m.error });
  }

  write(o: Record<string, unknown>): void {
    this.proc.stdout.write(`${JSON.stringify(o)}\n`);
  }
  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }
  error(id: JsonRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }
  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }
  request(id: JsonRpcId, method: string, params: unknown): void {
    this.write({ id, method, params });
  }
  last(method: string): { id: JsonRpcId; method: string; params: unknown } | undefined {
    return [...this.requests].reverse().find((r) => r.method === method);
  }
  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

const until = (pred: () => boolean, what = 'condition'): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) resolve();
      else if (Date.now() - t0 > 3000) reject(new Error(`timeout waiting for ${what}`));
      else setTimeout(tick, 5);
    };
    tick();
  });

const spawnOpts = (
  over: Partial<StreamSpawnOptions> = {},
  session: Partial<NonNullable<StreamSpawnOptions['session']>> = {},
): StreamSpawnOptions => ({
  id: 's1',
  command: '/opt/codex',
  args: ['app-server'],
  cwd: WT,
  env: {},
  input: { kind: 'app-server' },
  worktreePath: WT,
  firstMessage: null,
  session: {
    agent: 'codex',
    model: null,
    effort: null,
    permissionMode: 'default',
    autoApproveEdits: false,
    resumeSessionId: null,
    projectPath: PROJECT,
    mcp: { command: '/shims/styx', args: ['mcp'], env: {} },
    ...session,
  },
  ...over,
});

/** A runner over a fake server with the plain handshake answered; resolves once `init` was emitted. */
async function boot(
  over: Partial<StreamSpawnOptions> = {},
  session: Partial<NonNullable<StreamSpawnOptions['session']>> = {},
  wire: (server: FakeServer) => void = () => undefined,
) {
  const server = new FakeServer();
  const runner = new AppServerRunner((_cmd, _args, _opts) => {
    setImmediate(() => server.proc.emit('spawn'));
    return server.proc;
  });
  const effects: StreamEffect[] = [];
  const exits: (number | null)[] = [];
  runner.on('effect', (_id, e) => effects.push(e));
  runner.on('exit', (_id, code) => exits.push(code));
  server
    .on('initialize', () => resultOf(1))
    .on('model/list', () => MODEL_LIST)
    .on('thread/start', () => resultOf(5))
    .on('thread/resume', (params) => ({
      ...(resultOf(5) as object),
      thread: { id: (params as { threadId: string }).threadId },
    }))
    .on('turn/start', () => ({ turn: { id: TURN_ID, status: 'inProgress' } }))
    .on('turn/steer', () => ({ turnId: TURN_ID }))
    .on('turn/interrupt', () => ({}))
    .on('thread/compact/start', () => ({}))
    .on('review/start', () => ({ turn: { id: 'turn-review' }, reviewThreadId: THREAD_ID }));
  wire(server);
  const opts = spawnOpts(over, session);
  const { pid } = await runner.spawn(opts);
  await until(() => effects.some((e) => e.type === 'init'), 'init');
  const quiet = () => effects.filter((e) => e.type === 'session' && e.event === 'quiet').length;
  const kinds = () => effects.filter((e) => e.type !== 'render');
  return { server, runner, effects, exits, pid, opts, quiet, kinds };
}

/** The recorded notifications, replayed after `turn/start` is answered. */
const replayPong = (server: FakeServer): void => {
  server.on('turn/start', () => {
    setTimeout(() => {
      for (const n of NOTIFICATIONS) server.notify(n.method ?? '', n.params);
    }, 0);
    return resultOf(6);
  });
};

// --- Tests ----------------------------------------------------------------------------

describe('AppServerRunner: the recorded pong turn', () => {
  it('handshakes, starts the thread, sends the first message and maps the stream onto effects', async () => {
    const { server, effects, kinds, quiet, pid, runner } = await boot(
      { firstMessage: 'Reply with the single word pong and nothing else.' },
      {},
      replayPong,
    );
    expect(pid).toBe(4242);
    expect(runner.has('s1')).toBe(true);
    await until(() => quiet() === 1, 'turn end');

    expect(kinds()).toEqual([
      { type: 'catalogue', models: CATALOGUE },
      {
        type: 'init',
        chatId: THREAD_ID,
        model: 'gpt-6-astra',
        permissionMode: 'default',
        slashCommands: ['/compact', '/review'],
      },
      { type: 'session', event: 'activity' }, // session started
      { type: 'session', event: 'activity' }, // turn/start sent
      { type: 'session', event: 'activity' }, // turn/started
      { type: 'streamStart', key: MSG_ID, kind: 'text' },
      { type: 'streamDelta', key: MSG_ID, text: 'pong' },
      { type: 'streamStop', key: MSG_ID },
      { type: 'streamFinal', key: MSG_ID, body: 'pong' },
      { type: 'note', note: 'pong' },
      // The recorded `account/rateLimits/updated` (plan and both windows) feeds the Usage page.
      {
        type: 'limits',
        limits: {
          agent: 'codex',
          plan: 'team',
          windows: [
            { label: '5 h', usedPercent: 0, resetsAt: 1789561758000 },
            { label: '7 d', usedPercent: 0, resetsAt: 1790077939000 },
          ],
          updatedAt: expect.any(Number) as number,
        },
      },
      {
        type: 'usage',
        costUsd: null,
        numTurns: 1,
        durationMs: 5805,
        tokensUsed: 14574,
        contextWindow: 258400,
      },
      { type: 'session', event: 'quiet' },
    ]);
    // The terminal view got the session line, the reply and the turn footer.
    const rendered = effects.filter((e) => e.type === 'render').map((e) => e.text);
    expect(rendered).toContain('· session started · gpt-6-astra\r\n');
    expect(rendered).toContain('pong\r\n');
    expect(rendered).toContain('— done in 5.8s\r\n');

    // What went down stdin, in order.
    expect(server.requests.map((r) => r.method)).toEqual([
      'initialize',
      'model/list',
      'thread/start',
      'turn/start',
    ]);
    expect(server.requests[0]?.params).toEqual({
      clientInfo: { name: 'styx', title: 'Styx', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    expect(server.notifications).toEqual([{ method: 'initialized', params: undefined }]);
    expect(server.requests[1]?.params).toEqual({ includeHidden: true });
    expect(server.requests[2]?.params).toEqual({
      cwd: WT,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });
    expect(server.requests[3]?.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'Reply with the single word pong and nothing else.', text_elements: [] }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [WT],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it('a second message after the turn ended starts a new turn; the running turn count grows', async () => {
    const { server, runner, quiet, effects } = await boot({ firstMessage: 'first' }, {}, replayPong);
    await until(() => quiet() === 1, 'first turn');
    runner.send('s1', 'second');
    await until(() => quiet() === 2, 'second turn');
    expect(server.count('turn/start')).toBe(2);
    expect(server.count('turn/steer')).toBe(0);
    const usage = effects.filter((e) => e.type === 'usage');
    expect(usage.map((u) => u.numTurns)).toEqual([1, 2]);
  });
});

describe('AppServerRunner: permission modes → Codex policy (thread/start and every turn/start)', () => {
  const table: {
    mode: PermissionMode;
    approvalPolicy: string;
    sandbox: string;
    reviewer: string;
    sandboxPolicy: unknown;
  }[] = [
    {
      mode: 'default',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      reviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [WT],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    },
    {
      mode: 'acceptEdits',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      reviewer: 'user',
      sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' }),
    },
    {
      mode: 'plan',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      reviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    },
    {
      mode: 'bypassPermissions',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      reviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
    {
      mode: 'dontAsk',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      reviewer: 'user',
      sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' }),
    },
    {
      mode: 'auto',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      reviewer: 'auto_review',
      sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' }),
    },
  ];

  it.each(table)('$mode', async ({ mode, approvalPolicy, sandbox, reviewer, sandboxPolicy }) => {
    const { server, runner, effects } = await boot(
      { firstMessage: 'go' },
      { permissionMode: mode, model: 'gpt-6-astra', effort: 'high' },
    );
    await until(() => server.count('turn/start') === 1, 'turn/start');
    expect(server.last('thread/start')?.params).toEqual({
      cwd: WT,
      model: 'gpt-6-astra',
      approvalPolicy,
      approvalsReviewer: reviewer,
      sandbox,
      config: { model_reasoning_effort: 'high' },
    });
    expect(server.last('turn/start')?.params).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'high',
      approvalPolicy,
      approvalsReviewer: reviewer,
      sandboxPolicy,
    });
    expect(effects.find((e) => e.type === 'init')).toMatchObject({ permissionMode: mode });
    runner.kill('s1');
  });

  it('setModel / setEffort / setPermissionMode apply to the next turn/start, not a relaunch', async () => {
    const { server, runner } = await boot({ firstMessage: 'one' });
    await until(() => server.count('turn/start') === 1, 'first turn');
    server.notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed' } });
    runner.setModel('s1', 'gpt-5.5');
    runner.setEffort('s1', 'xhigh');
    runner.setPermissionMode('s1', 'plan');
    runner.send('s1', 'two');
    await until(() => server.count('turn/start') === 2, 'second turn');
    expect(server.last('turn/start')?.params).toMatchObject({
      model: 'gpt-5.5',
      effort: 'xhigh',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    // Unknown vocabulary never reaches Codex: it falls back to the CLI default / the `default` mode.
    server.notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed' } });
    runner.setEffort('s1', 'bogus');
    runner.setPermissionMode('s1', 'bogus');
    runner.send('s1', 'three');
    await until(() => server.count('turn/start') === 3, 'third turn');
    const p = server.last('turn/start')?.params as Record<string, unknown>;
    expect(p['effort']).toBeUndefined();
    expect(p['sandboxPolicy']).toMatchObject({ type: 'workspaceWrite' });
    expect(server.count('thread/start')).toBe(1);
  });
});

describe('AppServerRunner: server requests become asks', () => {
  it('commandExecution/requestApproval → Bash permission; allow / always / deny answer the JSON-RPC id', async () => {
    const { server, runner, effects } = await boot({ firstMessage: 'go' });
    const ask = (id: number) =>
      server.request(id, 'item/commandExecution/requestApproval', {
        kind: 'command',
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: `cmd_${id}`,
        startedAtMs: 1,
        environmentId: null,
        reason: 'needs network',
        command: 'curl https://example.com',
        cwd: WT,
      });
    ask(100);
    await until(() => effects.some((e) => e.type === 'permission'), 'permission');
    expect(effects.filter((e) => e.type === 'permission')).toEqual([
      {
        type: 'permission',
        requestId: '100',
        toolName: 'Bash',
        input: { command: 'curl https://example.com', cwd: WT, description: 'needs network' },
      },
    ]);
    runner.respondPermission('s1', '100', true);
    await until(() => server.answers.length === 1, 'answer');
    expect(server.answers[0]).toEqual({ id: 100, result: { decision: 'accept' } });

    ask(101);
    await until(() => effects.filter((e) => e.type === 'permission').length === 2, 'permission 2');
    runner.respondPermission('s1', '101', true, undefined, { always: true });
    await until(() => server.answers.length === 2, 'answer 2');
    expect(server.answers[1]).toEqual({ id: 101, result: { decision: 'acceptForSession' } });

    ask(102);
    await until(() => effects.filter((e) => e.type === 'permission').length === 3, 'permission 3');
    runner.respondPermission('s1', '102', false, 'not now');
    await until(() => server.answers.length === 3, 'answer 3');
    expect(server.answers[2]).toEqual({ id: 102, result: { decision: 'decline' } });

    // A second answer to the same id, or an unknown id, writes nothing.
    runner.respondPermission('s1', '102', true);
    runner.respondPermission('s1', 'nope', true);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.answers).toHaveLength(3);
  });

  it('fileChange/requestApproval → Edit permission with the path the item announced', async () => {
    const { server, runner, effects } = await boot({ firstMessage: 'go' });
    server.notify('item/started', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: {
        type: 'fileChange',
        id: 'patch_1',
        status: 'inProgress',
        changes: [
          {
            path: `${WT}/src/a.ts`,
            kind: { type: 'update', move_path: null },
            diff: '--- a\n+++ b\n+one\n+two\n-three\n',
          },
          { path: `${WT}/src/b.ts`, kind: { type: 'add' }, diff: '+++ b\n+x\n' },
        ],
      },
    });
    server.request(7, 'item/fileChange/requestApproval', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'patch_1',
      startedAtMs: 1,
      reason: 'outside the sandbox',
    });
    await until(() => effects.some((e) => e.type === 'permission'), 'permission');
    expect(effects.find((e) => e.type === 'permission')).toEqual({
      type: 'permission',
      requestId: '7',
      toolName: 'Edit',
      input: { file_path: 'src/a.ts', paths: ['src/a.ts', 'src/b.ts'], reason: 'outside the sandbox' },
    });
    expect(effects.filter((e) => e.type === 'transcript')).toEqual([
      {
        type: 'transcript',
        body: 'Edit src/a.ts, src/b.ts',
        payload: {
          kind: 'tool',
          tool: 'Edit',
          hint: 'src/a.ts, src/b.ts',
          toolUseId: 'patch_1',
          status: 'running',
          detail: null,
        },
      },
      {
        type: 'transcript',
        body: 'src/a.ts, src/b.ts',
        payload: {
          kind: 'file-list',
          files: [
            { path: 'src/a.ts', added: 2, removed: 1 },
            { path: 'src/b.ts', added: 1, removed: 0 },
          ],
        },
      },
    ]);
    runner.respondPermission('s1', '7', true);
    await until(() => server.answers.length === 1, 'answer');
    expect(server.answers[0]).toEqual({ id: 7, result: { decision: 'accept' } });
    server.notify('item/completed', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: 'fileChange', id: 'patch_1', status: 'completed', changes: [] },
    });
    await until(() => effects.some((e) => e.type === 'rescan'), 'rescan');
    expect(effects.filter((e) => e.type === 'toolResult')).toEqual([
      { type: 'toolResult', toolUseId: 'patch_1', ok: true, detail: null },
    ]);
  });

  it('tool/requestUserInput → AskUserQuestion; answers by question text go back by question id', async () => {
    const { server, runner, effects } = await boot({ firstMessage: 'go' });
    const params = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'tool_1',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'region',
          header: 'Deploy',
          question: 'Which region?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'us-east-1', description: 'Virginia' }],
        },
        {
          id: 'token',
          header: 'Token',
          question: 'API token?',
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    };
    server.request(8, 'item/tool/requestUserInput', params);
    await until(() => effects.some((e) => e.type === 'permission'), 'permission');
    const perm = effects.find((e) => e.type === 'permission');
    expect(perm).toEqual({
      type: 'permission',
      requestId: '8',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which region?',
            header: 'Deploy',
            multiSelect: false,
            options: [{ label: 'us-east-1', description: 'Virginia' }],
            secret: false,
          },
          { question: 'API token?', header: 'Token', multiSelect: false, options: [], secret: true },
        ],
      },
    });
    runner.respondPermission('s1', '8', true, undefined, {
      questions: perm?.type === 'permission' ? perm.input['questions'] : undefined,
      answers: { 'Which region?': 'us-east-1', 'API token?': 'hunter2' },
    });
    await until(() => server.answers.length === 1, 'answer');
    expect(server.answers[0]).toEqual({
      id: 8,
      result: { answers: { region: { answers: ['us-east-1'] }, token: { answers: ['hunter2'] } } },
    });

    server.request(9, 'item/tool/requestUserInput', params);
    await until(() => effects.filter((e) => e.type === 'permission').length === 2, 'permission 2');
    runner.respondPermission('s1', '9', false, 'cancelled');
    await until(() => server.answers.length === 2, 'answer 2');
    expect(server.answers[1]).toEqual({ id: 9, result: { answers: {} } });
  });

  it('permissions/requestApproval → Permissions ask answered with the same profile for the turn; elicitations and unknown requests are refused', async () => {
    const { server, runner, effects } = await boot({ firstMessage: 'go' });
    const permissions = { network: { hosts: ['example.com'] }, fileSystem: null };
    server.request(10, 'item/permissions/requestApproval', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'perm_1',
      environmentId: null,
      startedAtMs: 1,
      cwd: WT,
      reason: 'fetch docs',
      permissions,
    });
    await until(() => effects.some((e) => e.type === 'permission'), 'permission');
    expect(effects.find((e) => e.type === 'permission')).toEqual({
      type: 'permission',
      requestId: '10',
      toolName: 'Permissions',
      input: { reason: 'fetch docs', permissions },
    });
    runner.respondPermission('s1', '10', true);
    await until(() => server.answers.length === 1, 'answer');
    expect(server.answers[0]).toEqual({
      id: 10,
      result: { permissions: { network: { hosts: ['example.com'] } }, scope: 'turn' },
    });

    server.request(11, 'item/permissions/requestApproval', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'perm_2',
      environmentId: null,
      startedAtMs: 1,
      cwd: WT,
      reason: null,
      permissions,
    });
    await until(() => effects.filter((e) => e.type === 'permission').length === 2, 'permission 2');
    runner.respondPermission('s1', '11', false);
    await until(() => server.answers.length === 2, 'answer 2');
    expect(server.answers[1]).toEqual({ id: 11, result: { permissions: {}, scope: 'turn' } });

    server.request(12, 'mcpServer/elicitation/request', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: 'pencil',
      mode: 'form',
      _meta: null,
      message: 'Fill in',
      requestedSchema: {},
    });
    server.request(13, 'item/tool/call', { threadId: THREAD_ID, turnId: TURN_ID, tool: 'x', arguments: {} });
    server.request(14, 'attestation/generate', {});
    await until(() => server.answers.length === 5, 'refusals');
    expect(server.answers.slice(2)).toEqual([
      { id: 12, result: { action: 'cancel', content: null, _meta: null } },
      { id: 13, error: { code: -32601, message: 'item/tool/call is not supported by Styx' } },
      { id: 14, error: { code: -32601, message: 'attestation/generate is not supported by Styx' } },
    ]);
    expect(effects.filter((e) => e.type === 'permission')).toHaveLength(2);
  });
});

describe('AppServerRunner: resume, steer, interrupt, slash commands, kill', () => {
  it('a relaunch resumes the earlier thread and reports its id', async () => {
    const { server, effects, runner } = await boot({}, { resumeSessionId: 'thr_old', model: 'gpt-6-astra' });
    expect(server.count('thread/start')).toBe(0);
    expect(server.last('thread/resume')?.params).toEqual({
      threadId: 'thr_old',
      cwd: WT,
      model: 'gpt-6-astra',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });
    expect(effects.find((e) => e.type === 'init')).toMatchObject({ chatId: 'thr_old', model: 'gpt-6-astra' });
    runner.kill('s1');
  });

  it('a resume the server refuses falls back to a fresh thread', async () => {
    const { server, effects, runner } = await boot({}, { resumeSessionId: 'thr_gone' }, (s) =>
      s.on('thread/resume', () => {
        throw new Error('thread not found');
      }),
    );
    expect(server.requests.map((r) => r.method)).toEqual([
      'initialize',
      'model/list',
      'thread/resume',
      'thread/start',
    ]);
    expect(effects.find((e) => e.type === 'init')).toMatchObject({ chatId: THREAD_ID });
    expect(effects.some((e) => e.type === 'error')).toBe(false);
    runner.kill('s1');
  });

  it('a message while a turn is running steers it; interrupt names the live turn; a stale steer restarts', async () => {
    const { server, runner, effects } = await boot({ firstMessage: 'first' });
    await until(() => server.count('turn/start') === 1, 'turn/start');
    server.notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    await until(
      () => effects.filter((e) => e.type === 'session' && e.event === 'activity').length >= 3,
      'started',
    );
    runner.send('s1', 'and also this');
    await until(() => server.count('turn/steer') === 1, 'steer');
    expect(server.last('turn/steer')?.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'and also this', text_elements: [] }],
      expectedTurnId: TURN_ID,
    });
    runner.interrupt('s1');
    await until(() => server.count('turn/interrupt') === 1, 'interrupt');
    expect(server.last('turn/interrupt')?.params).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });

    // The server no longer has that turn: the steer fails and the message starts a turn instead.
    server.on('turn/steer', () => {
      throw new Error('no active turn');
    });
    runner.send('s1', 'again');
    await until(() => server.count('turn/start') === 2, 'restart');
    expect(server.count('turn/steer')).toBe(2);
    // Nothing to interrupt once the turn is over.
    server.notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'interrupted', durationMs: 10 },
    });
    await until(() => effects.some((e) => e.type === 'session' && e.event === 'quiet'), 'quiet');
    runner.interrupt('s1');
    await new Promise((r) => setTimeout(r, 20));
    expect(server.count('turn/interrupt')).toBe(1);
    expect(effects.filter((e) => e.type === 'render').map((e) => e.text)).toContain(
      '— interrupted in 0.0s\r\n',
    );
  });

  it('/compact and /review are app-server requests; any other slash text goes to the model', async () => {
    const { server, runner, effects } = await boot();
    runner.send('s1', '/compact');
    await until(() => server.count('thread/compact/start') === 1, 'compact');
    expect(server.last('thread/compact/start')?.params).toEqual({ threadId: THREAD_ID });
    runner.send('s1', '/review');
    await until(() => server.count('review/start') === 1, 'review');
    expect(server.last('review/start')?.params).toEqual({
      threadId: THREAD_ID,
      target: { type: 'uncommittedChanges' },
    });
    // The review runs as a turn: a later message steers it rather than starting a second turn.
    runner.send('s1', '/model gpt-5');
    await until(() => server.count('turn/steer') === 1, 'steer');
    expect(server.last('turn/steer')?.params).toMatchObject({
      input: [{ type: 'text', text: '/model gpt-5', text_elements: [] }],
      expectedTurnId: 'turn-review',
    });
    expect(effects.filter((e) => e.type === 'render').map((e) => e.text)).toEqual(
      expect.arrayContaining(['· compacting context…\r\n', '· reviewing uncommitted changes…\r\n']),
    );
  });

  it('messages sent before the thread exists wait for it', async () => {
    const server = new FakeServer();
    const runner = new AppServerRunner(() => {
      setImmediate(() => server.proc.emit('spawn'));
      return server.proc;
    });
    let releaseThread: (() => void) | null = null;
    server
      .on('initialize', () => resultOf(1))
      .on('model/list', () => MODEL_LIST)
      .on('thread/start', (_p, id) => {
        releaseThread = () => server.respond(id, resultOf(5));
        throw new Error('__defer__');
      })
      .on('turn/start', () => ({ turn: { id: TURN_ID } }));
    // The fake answers a thrown handler with an error, so intercept: answer thread/start only when released.
    const orig = server.error.bind(server);
    server.error = (id, code, message) => {
      if (message !== '__defer__') orig(id, code, message);
    };
    await runner.spawn(spawnOpts({ firstMessage: 'first' }));
    await until(() => server.count('thread/start') === 1, 'thread/start');
    runner.send('s1', 'early');
    expect(server.count('turn/start')).toBe(0);
    (releaseThread as (() => void) | null)?.();
    await until(() => server.count('turn/start') === 2, 'both turns');
    expect(
      server.requests
        .filter((r) => r.method === 'turn/start')
        .map((r) => (r.params as { input: { text: string }[] }).input[0]?.text),
    ).toEqual(['first', 'early']);
    runner.kill('s1');
  });

  it('kill ends stdin, kills the process and emits exit; a handshake failure ends the session with an error', async () => {
    const { server, runner, exits } = await boot();
    runner.kill('s1');
    await until(() => exits.length === 1, 'exit');
    expect(exits).toEqual([null]);
    expect(server.proc.killed).toBe(true);
    expect(runner.has('s1')).toBe(false);

    const failing = new FakeServer();
    const r2 = new AppServerRunner(() => {
      setImmediate(() => failing.proc.emit('spawn'));
      return failing.proc;
    });
    const effects: StreamEffect[] = [];
    const exited: (number | null)[] = [];
    r2.on('effect', (_id, e) => effects.push(e));
    r2.on('exit', (_id, code) => exited.push(code));
    failing.on('initialize', () => {
      throw new Error('not logged in');
    });
    await r2.spawn(spawnOpts());
    await until(() => exited.length === 1, 'exit');
    expect(effects.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'not logged in' }]);
    expect(r2.has('s1')).toBe(false);
  });

  it('spawn rejects when the process cannot start', async () => {
    const proc = new FakeProc();
    const runner = new AppServerRunner(() => {
      setImmediate(() => proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return proc;
    });
    await expect(runner.spawn(spawnOpts())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runner.has('s1')).toBe(false);
  });
});

describe('AppServerRunner: items, usage, rate limits, errors', () => {
  const item = (server: FakeServer, event: 'item/started' | 'item/completed', it: Record<string, unknown>) =>
    server.notify(event, { threadId: THREAD_ID, turnId: TURN_ID, item: it });

  it('commandExecution → Bash tool row, live output, then a result with the output tail', async () => {
    const { server, effects, kinds } = await boot({ firstMessage: 'go' });
    const before = kinds().length;
    item(server, 'item/started', {
      type: 'commandExecution',
      id: 'cmd_1',
      command: 'pnpm test\n--filter x',
      cwd: WT,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      processId: null,
      source: 'agent',
      pluginId: null,
      scriptPath: null,
    });
    server.notify('item/commandExecution/outputDelta', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'cmd_1',
      delta: 'line 1\nline 2\n',
    });
    item(server, 'item/completed', {
      type: 'commandExecution',
      id: 'cmd_1',
      command: 'pnpm test',
      cwd: WT,
      status: 'completed',
      aggregatedOutput: `${Array.from({ length: 40 }, (_, i) => `out ${i}`).join('\n')}\n`,
      exitCode: 0,
      durationMs: 12,
    });
    item(server, 'item/started', {
      type: 'commandExecution',
      id: 'cmd_2',
      command: '/usr/local/bin/gcloud deploy',
      cwd: WT,
      status: 'inProgress',
    });
    item(server, 'item/completed', {
      type: 'commandExecution',
      id: 'cmd_2',
      command: '/usr/local/bin/gcloud deploy',
      cwd: WT,
      status: 'failed',
      aggregatedOutput: '',
      exitCode: 2,
    });
    await until(() => effects.filter((e) => e.type === 'toolResult').length === 2, 'results');
    expect(kinds().slice(before)).toEqual([
      { type: 'session', event: 'activity' },
      {
        type: 'transcript',
        body: 'Bash pnpm test',
        payload: {
          kind: 'tool',
          tool: 'Bash',
          hint: 'pnpm test',
          toolUseId: 'cmd_1',
          status: 'running',
          detail: null,
        },
      },
      {
        type: 'toolResult',
        toolUseId: 'cmd_1',
        ok: true,
        detail: Array.from({ length: 30 }, (_, i) => `out ${i + 10}`).join('\n'),
      },
      { type: 'session', event: 'activity' },
      {
        type: 'transcript',
        body: 'Bash /usr/local/bin/gcloud deploy',
        payload: {
          kind: 'tool',
          tool: 'Bash',
          hint: '/usr/local/bin/gcloud deploy',
          toolUseId: 'cmd_2',
          status: 'running',
          detail: null,
        },
      },
      {
        type: 'transcript',
        body: 'warning: gcloud called by full path — this skips the Styx shim, so no grant was asked and nothing was audited',
        payload: { kind: 'system' },
      },
      { type: 'toolResult', toolUseId: 'cmd_2', ok: false, detail: 'exit 2' },
    ]);
    const rendered = effects.filter((e) => e.type === 'render').map((e) => e.text);
    expect(rendered).toContain('▸ Bash pnpm test\r\n');
    expect(rendered).toContain('line 1\r\nline 2\r\n');
    expect(rendered).toContain('  ✓ completed · exit 0\r\n');
    expect(rendered).toContain('  ! failed · exit 2\r\n');
  });

  it('mcpToolCall, webSearch, plan, reasoning and compaction items', async () => {
    const { server, effects, kinds } = await boot({ firstMessage: 'go' });
    const before = kinds().length;
    item(server, 'item/started', {
      type: 'mcpToolCall',
      id: 'mcp_1',
      server: 'styx',
      tool: 'request_access',
      status: 'inProgress',
      arguments: { target: 'supabase prod', scope: ['read'] },
      result: null,
      error: null,
    });
    item(server, 'item/completed', {
      type: 'mcpToolCall',
      id: 'mcp_1',
      server: 'styx',
      tool: 'request_access',
      status: 'failed',
      arguments: {},
      result: null,
      error: { message: 'denied by policy\nmore' },
    });
    item(server, 'item/started', {
      type: 'webSearch',
      id: 'ws_1',
      query: 'codex app-server protocol',
      action: null,
      results: null,
    });
    item(server, 'item/completed', {
      type: 'webSearch',
      id: 'ws_1',
      query: 'codex app-server protocol',
      action: null,
      results: [],
    });
    item(server, 'item/started', { type: 'reasoning', id: 'rs_1', summary: [], content: [] });
    server.notify('item/reasoning/summaryPartAdded', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'rs_1',
      summaryIndex: 0,
    });
    server.notify('item/reasoning/summaryTextDelta', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'rs_1',
      delta: 'Thinking about',
      summaryIndex: 0,
    });
    server.notify('item/reasoning/summaryPartAdded', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'rs_1',
      summaryIndex: 1,
    });
    server.notify('item/reasoning/summaryTextDelta', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'rs_1',
      delta: 'the plan',
      summaryIndex: 1,
    });
    item(server, 'item/completed', {
      type: 'reasoning',
      id: 'rs_1',
      summary: ['Thinking about', 'the plan'],
      content: [],
    });
    item(server, 'item/completed', {
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
      content: ['raw reasoning'],
    });
    item(server, 'item/completed', { type: 'plan', id: 'plan_1', text: '1. read\n2. write' });
    item(server, 'item/completed', {
      type: 'agentMessage',
      id: 'msg_x',
      text: 'Done without deltas',
      phase: 'final_answer',
    });
    item(server, 'item/completed', { type: 'contextCompaction', id: 'cc_1' });
    item(server, 'item/completed', { type: 'imageGeneration', id: 'ig_1' });
    await until(
      () => effects.some((e) => e.type === 'transcript' && e.payload.kind === 'system'),
      'compaction',
    );
    expect(kinds().slice(before)).toEqual([
      { type: 'session', event: 'activity' },
      {
        type: 'transcript',
        body: 'mcp__styx__request_access supabase prod',
        payload: {
          kind: 'tool',
          tool: 'mcp__styx__request_access',
          hint: 'supabase prod',
          toolUseId: 'mcp_1',
          status: 'running',
          detail: null,
        },
      },
      { type: 'toolResult', toolUseId: 'mcp_1', ok: false, detail: 'denied by policy' },
      { type: 'session', event: 'activity' },
      {
        type: 'transcript',
        body: 'WebSearch codex app-server protocol',
        payload: {
          kind: 'tool',
          tool: 'WebSearch',
          hint: 'codex app-server protocol',
          toolUseId: 'ws_1',
          status: 'running',
          detail: null,
        },
      },
      { type: 'toolResult', toolUseId: 'ws_1', ok: true, detail: null },
      { type: 'streamStart', key: 'rs_1:thinking', kind: 'thinking' },
      { type: 'streamDelta', key: 'rs_1:thinking', text: 'Thinking about' },
      { type: 'streamDelta', key: 'rs_1:thinking', text: '\n\n' },
      { type: 'streamDelta', key: 'rs_1:thinking', text: 'the plan' },
      { type: 'streamStop', key: 'rs_1:thinking' },
      { type: 'streamFinal', key: 'rs_1:thinking', body: 'Thinking about\n\nthe plan' },
      {
        type: 'transcript',
        body: 'raw reasoning',
        payload: { kind: 'thinking', status: 'done', durationMs: null },
      },
      { type: 'transcript', body: '1. read\n2. write', payload: { kind: 'agent' } },
      { type: 'note', note: '1. read' },
      { type: 'transcript', body: 'Done without deltas', payload: { kind: 'agent' } },
      { type: 'note', note: 'Done without deltas' },
      { type: 'transcript', body: 'context compacted', payload: { kind: 'system' } },
    ]);
  });

  it('a turn that fails, an error notification, an MCP startup failure and a rate-limit window above 80%', async () => {
    const { server, effects, kinds } = await boot({ firstMessage: 'go' });
    const before = kinds().length;
    server.notify('error', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      error: { message: 'rate limited' },
      willRetry: true,
    });
    server.notify('mcpServer/startupStatus/updated', {
      threadId: THREAD_ID,
      name: 'pencil',
      status: 'failed',
      error: 'boom',
      failureReason: null,
    });
    server.notify('mcpServer/startupStatus/updated', {
      threadId: THREAD_ID,
      name: 'styx',
      status: 'failed',
      error: 'env: : No such file or directory',
      failureReason: null,
    });
    server.notify('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 85.4, windowDurationMins: 300, resetsAt: 1789561758 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790077939 },
      },
    });
    server.notify('thread/tokenUsage/updated', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      tokenUsage: { total: { totalTokens: 999 }, last: { totalTokens: 1 }, modelContextWindow: null },
    });
    server.notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: { message: 'model overloaded' }, durationMs: 42 },
    });
    await until(() => effects.some((e) => e.type === 'session' && e.event === 'quiet'), 'quiet');
    const resets = rateLimitNote({ usedPercent: 85.4, windowDurationMins: 300, resetsAt: 1789561758 });
    expect(resets).toMatch(/^Codex 5 h window 85% used · resets \d\d:\d\d$/);
    expect(kinds().slice(before)).toEqual([
      { type: 'error', message: 'rate limited (Codex will retry)', carriesOn: true },
      {
        type: 'error',
        message: 'styx MCP server failed to start: env: : No such file or directory',
        carriesOn: true,
      },
      // The whole report goes to the Usage page (resets in ms); the chat only gets the >80% note.
      {
        type: 'limits',
        limits: {
          agent: 'codex',
          plan: null,
          windows: [
            { label: '5 h', usedPercent: 85.4, resetsAt: 1789561758000 },
            { label: '7 d', usedPercent: 12, resetsAt: 1790077939000 },
          ],
          updatedAt: expect.any(Number) as number,
        },
      },
      { type: 'note', note: resets },
      { type: 'error', message: 'model overloaded' },
      { type: 'usage', costUsd: null, numTurns: 1, durationMs: 42, tokensUsed: 999, contextWindow: null },
      { type: 'session', event: 'quiet' },
    ]);
    expect(rateLimitNote({ usedPercent: 80, windowDurationMins: 300, resetsAt: null })).toBeNull();
    expect(rateLimitNote({ usedPercent: 91, windowDurationMins: 10080, resetsAt: null })).toBe(
      'Codex 7 d window 91% used · resets ',
    );
    expect(rateLimitNote({ usedPercent: 99, windowDurationMins: 90, resetsAt: null })).toBe(
      'Codex 90 min window 99% used · resets ',
    );
    expect(rateLimitNote(null)).toBeNull();
  });

  it('images go to Codex as local files in a per-session temp dir that vanishes with the process', async () => {
    const { server, runner, exits } = await boot();
    runner.send('s1', 'look', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    await until(() => server.count('turn/start') === 1, 'turn');
    const input = (
      server.last('turn/start')?.params as { input: { type: string; path?: string; text?: string }[] }
    ).input;
    expect(input).toHaveLength(2);
    const image = input[0];
    expect(image).toMatchObject({ type: 'localImage' });
    expect(image?.path).toMatch(/styx-s1[/\\]image-1\.png$/);
    expect(existsSync(image?.path ?? '')).toBe(true);
    expect(readFileSync(image?.path ?? '').toString('base64')).toBe('iVBORw0KGgo=');
    expect(input[1]).toEqual({ type: 'text', text: 'look', text_elements: [] });
    runner.kill('s1');
    await until(() => exits.length === 1, 'exit');
    expect(existsSync(image?.path ?? '')).toBe(false);
  });

  it('a process that dies mid-turn stops open streams and reports exit; non-JSON stdout is shown in the terminal', async () => {
    const { server, effects, exits } = await boot({ firstMessage: 'go' });
    server.proc.stdout.write('warning: something on stdout\n');
    server.notify('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'msg_1',
      delta: 'par',
    });
    await until(() => effects.some((e) => e.type === 'streamDelta'), 'delta');
    server.proc.emit('close', 1);
    await until(() => exits.length === 1, 'exit');
    expect(exits).toEqual([1]);
    expect(effects.filter((e) => e.type === 'streamStop')).toEqual([{ type: 'streamStop', key: 'msg_1' }]);
    expect(effects.filter((e) => e.type === 'render').map((e) => e.text)).toContain(
      'warning: something on stdout\r\n',
    );
  });
});
