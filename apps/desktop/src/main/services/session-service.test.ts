import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures, MAX_FILE_ATTACHMENT_BYTES, MAX_IMAGE_BYTES } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { PtyService } from './pty-service';
import { parseCliOutdated, runnerFor, STREAM_ACTIVITY_MS, STREAM_FLUSH_MS } from './session-service';
import type {
  ImageBlock,
  StreamEffect,
  StreamEvents,
  StreamRunnerLike,
  StreamSpawnOptions,
} from './stream-runner';

const { ids, DEMO_NOW } = fixtures;

/** In-memory pty: records writes, lets tests emit data/exit. */
class FakePty extends PtyService {
  readonly spawned: {
    id: string;
    shell: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  readonly writes: { id: string; data: string }[] = [];
  private readonly live = new Set<string>();
  constructor() {
    super(process.platform);
  }
  override async resolveLoginPath(): Promise<string> {
    return '/usr/bin';
  }
  override defaultShell(): string {
    return '/bin/zsh';
  }
  override async spawn(opts: {
    id: string;
    cwd: string;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
  }) {
    this.spawned.push({
      id: opts.id,
      shell: opts.shell ?? '',
      args: opts.args ?? [],
      cwd: opts.cwd,
      env: opts.env ?? {},
    });
    this.live.add(opts.id);
    return { pid: 4242 };
  }
  override write(id: string, data: string): void {
    this.writes.push({ id, data });
  }
  override resize(): void {}
  override kill(id: string): void {
    if (!this.live.has(id)) return;
    this.live.delete(id);
    this.emit('exit', id, 0, undefined);
  }
  override has(id: string): boolean {
    return this.live.has(id);
  }
  override killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  data(id: string, text: string): void {
    this.emit('data', id, text);
  }
  exit(id: string, code: number): void {
    this.live.delete(id);
    this.emit('exit', id, code, undefined);
  }
}

class FakeStream extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  readonly spawned: StreamSpawnOptions[] = [];
  readonly sent: { id: string; text: string; blocks?: ImageBlock[] }[] = [];
  readonly permissions: {
    id: string;
    requestId: string;
    allow: boolean;
    message?: string;
    updatedInput?: Record<string, unknown>;
  }[] = [];
  readonly live = new Set<string>();
  failNext: NodeJS.ErrnoException | null = null;
  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.spawned.push(opts);
    this.live.add(opts.id);
    return { pid: 777 };
  }
  send(id: string, text: string, blocks: readonly ImageBlock[] = []): void {
    this.sent.push({ id, text, ...(blocks.length > 0 ? { blocks: [...blocks] } : {}) });
  }
  readonly controls: { id: string; request: Record<string, unknown> }[] = [];
  setModel(id: string, model: string | null): void {
    this.controls.push({ id, request: { subtype: 'set_model', model } });
  }
  setPermissionMode(id: string, mode: string): void {
    this.controls.push({ id, request: { subtype: 'set_permission_mode', mode } });
  }
  interrupt(id: string): void {
    this.controls.push({ id, request: { subtype: 'interrupt' } });
  }
  respondPermission(
    id: string,
    requestId: string,
    allow: boolean,
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.permissions.push({
      id,
      requestId,
      allow,
      ...(message !== undefined ? { message } : {}),
      ...(updatedInput !== undefined ? { updatedInput } : {}),
    });
  }
  kill(id: string): void {
    if (!this.live.delete(id)) return;
    this.emit('exit', id, 0);
  }
  has(id: string): boolean {
    return this.live.has(id);
  }
  killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  effect(id: string, e: StreamEffect): void {
    this.emit('effect', id, e);
  }
}

let t: TestApp | null = null;
let pty: FakePty;
let stream: FakeStream;
const sender = { senderId: 1, frameUrl: 'file:///index.html' };

function app(): TestApp {
  pty = new FakePty();
  stream = new FakeStream();
  t = makeTestApp({ pty, stream });
  return t;
}

afterEach(async () => {
  await t?.app.shutdown();
  t = null;
});

const spawnInput = (agent: 'claude' | 'codex' | 'gemini', worktreeId: string, firstMessage = 'Fix it') => ({
  projectId: ids.project.acmeShop,
  agent,
  worktree: { kind: 'existing' as const, worktreeId },
  firstMessage,
  toggles: { autoApproveEdits: false, mayRequestTargets: true, notifyWhenNeedsMe: true },
  model: null,
});

describe('runnerFor (ADR-0010)', () => {
  it('claude streams when its CLI advertises stream-json; cursor also needs --print; the rest is pty', () => {
    expect(runnerFor('claude', { capabilities: { streamJson: true } })).toBe('stream');
    expect(runnerFor('claude', { capabilities: {} })).toBe('pty');
    expect(runnerFor('claude', null)).toBe('pty');
    expect(runnerFor('cursor', { capabilities: { streamJson: true } })).toBe('pty');
    expect(runnerFor('cursor', { capabilities: { streamJson: true, printMode: true } })).toBe('stream');
    expect(runnerFor('codex', { capabilities: { streamJson: true, printMode: true } })).toBe('pty');
    expect(runnerFor('shell', null)).toBe('pty');
  });
});

describe('SessionService spawn + stream runner', () => {
  it('spawns claude through the stream runner, feeds effects into transcript, hunks, note and state', async () => {
    const { app: a, win } = app();
    const cursor = a.repos.sessions.get(ids.session.cursor)!;
    a.repos.sessions.upsert({ ...cursor, state: 'done', endedAt: DEMO_NOW, pid: null, exitCode: 0 });
    const { session, worktree } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(session.runner).toBe('stream');
    expect(session.state).toBe('working');
    expect(session.pid).toBe(777);
    expect(stream.spawned).toHaveLength(1);
    const sp = stream.spawned[0]!;
    expect(sp.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-prompt-tool',
        'stdio',
        '--mcp-config',
        '--settings',
      ]),
    );
    expect(sp.input).toEqual({ kind: 'stdin' });
    expect(sp.firstMessage).toBe('Fix it');
    expect(sp.env['STYX_SESSION_ID']).toBe(session.id);
    expect(sp.env['STYX_WORKTREE']).toBe(worktree.path);
    expect(sp.cwd).toBe(worktree.path);
    expect(a.repos.worktrees.get(worktree.id)?.owner).toEqual({ kind: 'session', sessionId: session.id });
    // the hooks settings file forwards through `styx hook claude`
    const settings = JSON.parse(
      readFileSync(join(t!.userData, 'agents', session.id, 'styx-settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(['Stop', 'SessionEnd', 'Notification', 'PostToolUse', 'SessionStart']),
    );

    stream.effect(session.id, {
      type: 'transcript',
      body: 'Reading checkout.ts',
      payload: { kind: 'agent' },
    });
    stream.effect(session.id, { type: 'note', note: 'Reading checkout.ts' });
    stream.effect(session.id, {
      type: 'transcript',
      body: 'checkout.ts',
      payload: { kind: 'file-list', files: [{ path: 'checkout.ts', added: 0, removed: 0 }] },
    });
    stream.effect(session.id, { type: 'render', text: '▸ Edit checkout.ts\r\n' });
    const msgs = a.repos.transcripts.last(session.id);
    expect(msgs.map((m) => m.payload.kind)).toEqual(['user', 'agent', 'file-list']);
    expect(a.sessions.get(session.id)?.note).toBe('Reading checkout.ts');
    a.publisher.flushPty();
    expect(
      win.sent.some(
        (m) => m.channel === 'styx:pty' && (m.payload as { data: string }).data.includes('Edit checkout.ts'),
      ),
    ).toBe(true);
    const log = join(t!.userData, 'logs', 'pty', `${session.id}.log`);
    expect(readFileSync(log, 'utf8')).toContain('> Fix it');
    expect(readFileSync(log, 'utf8')).toContain('Edit checkout.ts');

    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(a.sessions.get(session.id)?.state).toBe('idle');

    a.sessions.sendMessage(session.id, 'Now add tests');
    expect(stream.sent).toEqual([{ id: session.id, text: 'Now add tests' }]);
    expect(pty.writes).toEqual([]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
    a.sessions.ptyInput(session.id, 'typed'); // ignored for stream sessions
    expect(pty.writes).toEqual([]);

    // can_use_tool → Allow/Deny decision ask → needs-you; answering replies to the request
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
    });
    const s2 = a.sessions.get(session.id)!;
    expect(s2.state).toBe('needs-you');
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    expect(ask.payload).toEqual({
      kind: 'decision',
      prompt: 'Bash: rm -rf build',
      options: ['Allow', 'Deny'],
    });
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'decision', chosen: 'Allow' },
    });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'req-1', allow: true }]);
    expect(a.sessions.get(session.id)?.state).toBe('working');

    // stop → kill → exit → done with ended_at + exit code
    a.sessions.stop(session.id);
    const done = a.sessions.get(session.id)!;
    expect(done.state).toBe('done');
    expect(done.endedAt).toBe(DEMO_NOW);
    expect(done.exitCode).toBe(0);
    expect(done.pid).toBeNull();
    await vi.waitFor(() => expect(existsSync(join(t!.userData, 'agents', session.id))).toBe(false));
  });

  it('auto-approves edits when the toggle is on and denies pending permissions when the session stops', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      toggles: { autoApproveEdits: true, mayRequestTargets: true, notifyWhenNeedsMe: true },
    });
    expect(stream.spawned[0]!.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'e1',
      toolName: 'Edit',
      input: { file_path: 'a.ts' },
    });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'e1', allow: true }]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
    stream.effect(session.id, { type: 'permission', requestId: 'b1', toolName: 'Bash', input: {} });
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    a.sessions.stop(session.id);
    expect(stream.permissions.at(-1)).toEqual({
      id: session.id,
      requestId: 'b1',
      allow: false,
      message: 'Session stopped',
    });
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
    expect(a.sessions.get(session.id)?.state).toBe('done');
  });

  it('H-1: autoApproveEdits never auto-approves an edit to .styx/project.json', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      toggles: { autoApproveEdits: true, mayRequestTargets: true, notifyWhenNeedsMe: true },
    });
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'p1',
      toolName: 'Write',
      input: { file_path: '/repo/.styx/project.json' },
    });
    expect(stream.permissions).toEqual([]);
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    expect(a.repos.pendingAsks.openBySession(session.id)[0]?.payload).toMatchObject({
      kind: 'decision',
      prompt: 'Write: /repo/.styx/project.json',
    });
  });

  it('spawn failure (ENOENT) pauses the session with cli-missing and a banner', async () => {
    const { app: a, win } = app();
    stream.failNext = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(session.state).toBe('paused');
    expect(session.pausedReason).toBe('cli-missing');
    expect(win.events('banner.set')).toContainEqual(
      expect.objectContaining({ bannerKey: 'cli-missing:claude' }),
    );
  });
});

const OUTDATED =
  "API Error: 400 Claude Code 2.1.199 does not support this model; version 2.1.251 or newer is required. Run 'claude update' to update.";
const OUTDATED_TEXT =
  "Claude Code 2.1.199 can't use your default model. Update it (claude update) or switch the model in Settings.";

describe('parseCliOutdated', () => {
  it('reads the running and required versions out of the CLI message', () => {
    expect(parseCliOutdated(OUTDATED)).toEqual({ have: '2.1.199', need: '2.1.251' });
    expect(parseCliOutdated('does not support this model; version 3.0 or newer is required')).toEqual({
      have: null,
      need: '3.0',
    });
    expect(parseCliOutdated('API Error: 401 unauthorized')).toBeNull();
  });
});

describe('SessionService CLI-outdated (model needs a newer CLI)', () => {
  it('a stream error raises a persistent cli-outdated banner and a system line with the CLI message', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'error', message: OUTDATED });
    a.publisher.flush();
    expect(win.events('banner.set')).toContainEqual({
      bannerKey: 'cli-outdated:claude',
      kind: 'cli-outdated',
      text: OUTDATED_TEXT,
      cta: 'Install guide',
      action: { kind: 'install-guide', agent: 'claude' },
      sessionId: session.id,
      reason: null,
    });
    const n = a.repos.notifications.byBannerKey('cli-outdated:claude');
    expect(n).toMatchObject({ kind: 'error-banner', state: 'shown', meta: '2.1.251', title: OUTDATED_TEXT });
    const last = a.repos.transcripts.last(session.id).at(-1)!;
    expect(last.payload.kind).toBe('system');
    expect(last.body).toBe(OUTDATED);
    // The same error also arrives as assistant text in the same turn: one banner, one line.
    stream.effect(session.id, { type: 'transcript', body: OUTDATED, payload: { kind: 'agent' } });
    expect(a.repos.transcripts.last(session.id).filter((m) => m.payload.kind === 'system')).toHaveLength(1);
    // The session machine is untouched: no paused reason, no cli-missing banner.
    expect(a.sessions.get(session.id)?.pausedReason).toBeNull();
    expect(
      win.events('banner.set').some((e) => (e as { bannerKey: string }).bannerKey === 'cli-missing:claude'),
    ).toBe(false);
  });

  it('assistant text with the message (no error result) raises the banner too', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'transcript', body: OUTDATED, payload: { kind: 'agent' } });
    a.publisher.flush();
    expect(win.events('banner.set')).toContainEqual(
      expect.objectContaining({ bannerKey: 'cli-outdated:claude' }),
    );
    expect(a.repos.transcripts.last(session.id).map((m) => m.payload.kind)).toEqual([
      'user',
      'agent',
      'system',
    ]);
  });

  it('pty output (split across chunks, with ANSI) raises the banner for a pty-run claude', async () => {
    const { app: a, win } = app();
    a.repos.discovery.saveCli({
      agent: 'claude',
      binary: '/opt/homebrew/bin/claude',
      version: '2.1.199',
      found: true,
      authState: 'signed-in',
      capabilities: {}, // no stream-json → pty runner
      checkedAt: DEMO_NOW,
    });
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(session.runner).toBe('pty');
    pty.data(session.id, '\u001b[31mAPI Error: 400 Claude Code 2.1.199 does not support this mo');
    pty.data(session.id, "del; version 2.1.251 or newer is required.\u001b[0m Run 'claude update'.\r\n");
    a.publisher.flush();
    expect(win.events('banner.set')).toContainEqual(
      expect.objectContaining({ bannerKey: 'cli-outdated:claude', text: OUTDATED_TEXT }),
    );
    expect(a.repos.transcripts.last(session.id).at(-1)?.body).toContain('does not support this model');
  });

  it('refreshClis clears the banner once the detected claude satisfies the required version', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'error', message: OUTDATED });
    const detected = (version: string) => async () => [
      {
        agent: 'claude' as const,
        label: 'Claude Code',
        binary:
          '/Users/nic/.vscode/extensions/anthropic.claude-code-2.1.261-darwin-arm64/resources/native-binary/claude',
        version,
        found: true,
        authState: 'signed-in' as const,
        capabilities: { streamJson: true },
        source: 'vscode-extension' as const,
        alternatives: [],
      },
    ];
    a.detect.detectClis = detected('2.1.199');
    await a.sessions.refreshClis();
    expect(a.repos.notifications.byBannerKey('cli-outdated:claude')?.state).toBe('shown');
    expect(win.events('banner.clear')).toEqual([]);
    a.detect.detectClis = detected('2.1.261');
    const clis = await a.sessions.refreshClis();
    expect(clis.find((c) => c.agent === 'claude')).toMatchObject({
      version: '2.1.261',
      capabilities: { streamJson: true, source: 'vscode-extension' },
    });
    a.publisher.flush();
    expect(a.repos.notifications.byBannerKey('cli-outdated:claude')?.state).toBe('resolved');
    expect(win.events('banner.clear')).toContainEqual({ bannerKey: 'cli-outdated:claude' });
  });
});

describe('SessionService relaunch + re-detect', () => {
  it('sendMessage relaunches the CLI when its process is gone (nothing replayed), then delivers the message', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    stream.live.delete(session.id); // the process exited on the API error without an exit event reaching us
    expect(a.sessions.isRunning(session.id)).toBe(false);

    await a.sessions.sendMessage(session.id, 'try again');
    expect(stream.spawned).toHaveLength(2);
    expect(stream.spawned[1]).toMatchObject({
      id: session.id,
      firstMessage: null,
      cwd: stream.spawned[0]!.cwd,
    });
    expect(stream.sent).toEqual([{ id: session.id, text: 'try again' }]);
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'working', pid: 777 });
    // The broker token was rotated for the new process.
    expect(a.repos.transcripts.last(session.id).at(-1)).toMatchObject({
      body: 'try again',
      payload: { kind: 'user' },
    });
  });

  it('a failed relaunch pauses the session with cli-missing and its banner; the message is not delivered', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.live.delete(session.id);
    stream.failNext = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    await a.sessions.sendMessage(session.id, 'again');
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'paused', pausedReason: 'cli-missing' });
    expect(stream.sent).toEqual([]);
    a.publisher.flush();
    expect(win.events('banner.set')).toContainEqual(
      expect.objectContaining({ bannerKey: 'cli-missing:claude' }),
    );
  });

  it('with redetectClis on, every spawn / relaunch uses the freshly detected binary', async () => {
    pty = new FakePty();
    stream = new FakeStream();
    t = makeTestApp({ pty, stream, redetectClis: true });
    const a = t.app;
    let binary = '/Users/nic/.local/bin/claude';
    let version = '2.1.199';
    a.detect.detectClis = async () => [
      {
        agent: 'claude' as const,
        label: 'Claude Code',
        binary,
        version,
        found: true,
        authState: 'signed-in' as const,
        capabilities: { streamJson: true },
        source: 'path' as const,
        alternatives: [],
      },
    ];
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(stream.spawned[0]?.command).toBe('/Users/nic/.local/bin/claude');
    expect(a.repos.discovery.cli('claude')).toMatchObject({ version: '2.1.199' });

    // `claude update` ran meanwhile: the relaunch picks up the new binary without a manual re-detect.
    binary =
      '/Users/nic/.vscode/extensions/anthropic.claude-code-2.1.263-darwin-arm64/resources/native-binary/claude';
    version = '2.1.263';
    stream.live.delete(session.id);
    await a.sessions.sendMessage(session.id, 'retry');
    expect(stream.spawned[1]?.command).toBe(binary);
    expect(a.repos.discovery.cli('claude')).toMatchObject({ version: '2.1.263' });
  });
});

describe('SessionService pty runner + CLI hooks', () => {
  it('spawns codex on a pty, typing routes to the pty, and hooks drive the state', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    expect(session.runner).toBe('pty');
    expect(pty.spawned[0]).toMatchObject({ id: session.id, shell: '/opt/homebrew/bin/codex' });
    expect(pty.spawned[0]!.args).toEqual(expect.arrayContaining(['-c', 'Fix it']));
    expect(session.state).toBe('working');

    a.sessions.sendMessage(session.id, 'more');
    expect(pty.writes).toEqual([{ id: session.id, data: 'more\r' }]);

    a.sessions.onHook(session.id, 'codex', 'notify', {
      type: 'agent-turn-complete',
      'last-assistant-message': 'All green.',
    });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'idle', note: 'All green.' });
    pty.data(session.id, 'thinking…');
    expect(a.sessions.get(session.id)?.state).toBe('working');
    expect(readFileSync(join(t!.userData, 'logs', 'pty', `${session.id}.log`), 'utf8')).toContain(
      'thinking…',
    );
  });

  it('Claude hooks: Notification permission_prompt → system line + question ask (needs-you); Stop clears it', async () => {
    const { app: a } = app();
    a.repos.discovery.saveCli({
      agent: 'claude',
      binary: '/opt/homebrew/bin/claude',
      version: '2.1.199',
      found: true,
      authState: 'signed-in',
      capabilities: {},
      checkedAt: DEMO_NOW,
    });
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(session.runner).toBe('pty');
    expect(pty.spawned[0]!.args).not.toContain('-p');

    a.sessions.onHook(session.id, 'claude', 'Notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    let s = a.sessions.get(session.id)!;
    expect(s.state).toBe('needs-you');
    expect(s.note).toBe('Claude needs your permission to use Bash');
    const asks = a.repos.pendingAsks.openBySession(session.id);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.payload).toEqual({
      kind: 'question',
      prompt: 'Claude needs your permission to use Bash',
    });
    const last = a.repos.transcripts.last(session.id).at(-1)!;
    expect(last.payload.kind).toBe('system');
    expect(last.body).toContain('waiting in the terminal');
    // a second prompt while one is open does not stack
    a.sessions.onHook(session.id, 'claude', 'Notification', {
      notification_type: 'agent_needs_input',
      message: 'again',
    });
    expect(a.repos.pendingAsks.openBySession(session.id)).toHaveLength(1);

    // the user answered in the terminal → the agent moves on → ask cancelled, needs-you clears
    a.sessions.onHook(session.id, 'claude', 'PostToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: 'checkout.ts' },
    });
    s = a.sessions.get(session.id)!;
    expect(s.state).toBe('working');
    expect(a.repos.pendingAsks.get(asks[0]!.id)?.state).toBe('cancelled');

    a.sessions.onHook(session.id, 'claude', 'Stop', { stop_hook_active: false });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    a.sessions.onHook(session.id, 'claude', 'Notification', {
      notification_type: 'idle_prompt',
      message: 'Waiting',
    });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    a.sessions.onHook(session.id, 'claude', 'UserPromptSubmit', { prompt: 'go' });
    expect(a.sessions.get(session.id)?.state).toBe('working');
  });

  it('answering a hook question from Styx types it into the pty; SessionEnd finishes and the exit code lands later', async () => {
    const { app: a } = app();
    a.repos.discovery.saveCli({
      agent: 'claude',
      binary: '/opt/homebrew/bin/claude',
      version: '2.1.199',
      found: true,
      authState: 'signed-in',
      capabilities: {},
      checkedAt: DEMO_NOW,
    });
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo, ''));
    a.sessions.onHook(session.id, 'claude', 'Notification', {
      notification_type: 'agent_needs_input',
      message: 'Which db?',
    });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'question', answer: 'postgres' },
    });
    expect(pty.writes.at(-1)).toEqual({ id: session.id, data: 'postgres\r' });
    expect(a.sessions.get(session.id)?.state).toBe('working');

    a.sessions.onHook(session.id, 'claude', 'SessionEnd', { reason: 'clear' });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    a.sessions.onHook(session.id, 'claude', 'SessionEnd', { reason: 'exit' });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'done', exitCode: null });
    pty.exit(session.id, 3);
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'done', exitCode: 3 });
  });

  it('cli-missing → paused; resume re-detects and respawns', async () => {
    const { app: a } = app();
    a.repos.discovery.saveCli({
      agent: 'codex',
      binary: null,
      version: null,
      found: false,
      authState: 'unknown',
      capabilities: {},
      checkedAt: DEMO_NOW,
    });
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    expect(session).toMatchObject({ state: 'paused', pausedReason: 'cli-missing' });
    expect(pty.spawned).toHaveLength(0);
    await expect(a.sessions.resume(session.id)).rejects.toMatchObject({ code: 'cli-missing' });
    // detection now finds it (fake detect: whatever the real machine has, so seed the row and stub detect)
    a.detect.detectClis = async () => [
      {
        agent: 'codex',
        label: 'Codex',
        binary: '/usr/local/bin/codex',
        version: '1.0.0',
        found: true,
        authState: 'signed-in',
        capabilities: {},
        source: 'path',
        alternatives: [],
      },
    ];
    await a.sessions.resume(session.id);
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'working', pausedReason: null, pid: 4242 });
    expect(pty.spawned[0]).toMatchObject({ shell: '/usr/local/bin/codex' });
  });

  it('conflict → resume only once the worktree merges cleanly; auth-expired → once no target is expired', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    const wt = a.repos.worktrees.get(ids.worktree.testFlaky)!;
    a.repos.worktrees.upsert({ ...wt, conflict: { file: 'checkout.ts', against: 'main' } });
    a.sessions.applyEvent(session.id, { type: 'error', reason: 'conflict' });
    expect(a.sessions.get(session.id)?.state).toBe('paused');
    a.git.detectConflict = async () => ({ file: 'checkout.ts', against: 'main' });
    await expect(a.sessions.resume(session.id)).rejects.toMatchObject({ code: 'git-error' });
    a.git.detectConflict = async () => null;
    await a.sessions.resume(session.id);
    expect(a.sessions.get(session.id)?.state).toBe('working');
    expect(a.repos.worktrees.get(ids.worktree.testFlaky)?.conflict).toBeNull();
    expect(pty.spawned).toHaveLength(1); // the process was still attached → no respawn

    a.sessions.applyEvent(session.id, { type: 'error', reason: 'auth-expired' });
    const target = a.repos.targets.get(ids.target.supabaseProd)!;
    a.repos.targets.upsert({ ...target, health: 'expired' });
    await expect(a.sessions.resume(session.id)).rejects.toMatchObject({ code: 'provider-error' });
    a.repos.targets.upsert({ ...target, health: 'ok' });
    await a.sessions.resume(session.id);
    expect(a.sessions.get(session.id)?.state).toBe('working');
  });

  it('session.stop / session.archive commands', async () => {
    const { app: a, clock } = app();
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    expect(await a.bus.dispatch(sender, 'session.archive', { sessionId: session.id })).toMatchObject({
      ok: false,
      error: { code: 'invalid-transition' },
    });
    expect(await a.bus.dispatch(sender, 'session.stop', { sessionId: session.id })).toMatchObject({
      ok: true,
    });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'done', endedAt: DEMO_NOW });
    clock.advance(1000);
    expect(await a.bus.dispatch(sender, 'session.archive', { sessionId: session.id })).toMatchObject({
      ok: true,
    });
    expect(a.sessions.get(session.id)?.archivedAt).toBe(DEMO_NOW + 1000);
  });
});

describe('SessionService Claude Code parity (stream)', () => {
  const systemLines = (a: TestApp['app'], id: string) =>
    a.repos.transcripts
      .last(id)
      .filter((m) => m.payload.kind === 'system')
      .map((m) => m.body);
  const flag = (args: string[], f: string): string | undefined => args[args.indexOf(f) + 1];

  it('launch flags follow the session row: default mode passes no --permission-mode; plan + effort do; bypass adds the skip flag', async () => {
    const { app: a } = app();
    await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const first = stream.spawned[0]!.args;
    expect(first).not.toContain('--permission-mode');
    expect(first).not.toContain('--effort');
    expect(first).not.toContain('--resume');
    expect(first).toContain('--allow-dangerously-skip-permissions');
    expect(first).not.toContain('--dangerously-skip-permissions');

    const cursor = a.repos.sessions.get(ids.session.cursor)!;
    a.repos.sessions.upsert({ ...cursor, state: 'done', endedAt: DEMO_NOW, pid: null, exitCode: 0 });
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.testFlaky),
      permissionMode: 'plan',
      effort: 'high',
    });
    expect(session).toMatchObject({ permissionMode: 'plan', effort: 'high' });
    const second = stream.spawned[1]!.args;
    expect(flag(second, '--permission-mode')).toBe('plan');
    expect(flag(second, '--effort')).toBe('high');

    a.sessions.configure(session.id, { permissionMode: 'bypassPermissions' });
    stream.live.delete(session.id);
    await a.sessions.sendMessage(session.id, 'again');
    const third = stream.spawned[2]!.args;
    expect(flag(third, '--permission-mode')).toBe('bypassPermissions');
    expect(third).toContain('--dangerously-skip-permissions');
  });

  it('init stores the CLI session id (and a default model); a relaunch resumes it with --resume', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(session.cliSessionId).toBeNull();
    stream.effect(session.id, {
      type: 'init',
      chatId: 'cli-sess-9',
      model: 'claude-opus-4-1',
      permissionMode: 'default',
      slashCommands: [],
    });
    expect(a.sessions.get(session.id)).toMatchObject({ cliSessionId: 'cli-sess-9', model: 'claude-opus-4-1' });
    // a second init (the CLI restarted) keeps an explicit model; a null chat id keeps the stored one
    a.sessions.configure(session.id, { model: 'sonnet' });
    stream.effect(session.id, { type: 'init', chatId: null, model: 'claude-x', permissionMode: null, slashCommands: [] });
    expect(a.sessions.get(session.id)).toMatchObject({ cliSessionId: 'cli-sess-9', model: 'sonnet' });

    stream.effect(session.id, { type: 'session', event: 'quiet' });
    stream.live.delete(session.id);
    await a.sessions.sendMessage(session.id, 'continue');
    const args = stream.spawned[1]!.args;
    expect(flag(args, '--resume')).toBe('cli-sess-9');
    expect(flag(args, '--model')).toBe('sonnet');
    expect(stream.spawned[0]!.args).not.toContain('--resume');
  });

  it.each([
    ['first result', 0, 0, { costUsd: 0.02, numTurns: 2 }, { costUsd: 0.02, numTurns: 2 }],
    ['running total grows', 0.02, 2, { costUsd: 0.05, numTurns: 5 }, { costUsd: 0.05, numTurns: 5 }],
    ['a restarted CLI reports less: keep the max', 0.05, 5, { costUsd: 0.01, numTurns: 1 }, { costUsd: 0.05, numTurns: 5 }],
    ['nulls leave the row alone', 0.05, 5, { costUsd: null, numTurns: null }, { costUsd: 0.05, numTurns: 5 }],
  ])('usage: %s', async (_label, costUsd, numTurns, reported, expected) => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    a.repos.sessions.upsert({ ...a.sessions.get(session.id)!, costUsd, numTurns });
    stream.effect(session.id, { type: 'usage', ...reported, durationMs: 100 });
    expect(a.sessions.get(session.id)).toMatchObject(expected);
  });

  it('tool lines: the running line is patched by its tool_result (ok / error + detail) and republished', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const tool = (id: string, tool: string, hint: string) =>
      stream.effect(session.id, {
        type: 'transcript',
        body: `${tool} ${hint}`,
        payload: { kind: 'tool', tool, hint, toolUseId: id, status: 'running', detail: null },
      });
    tool('t1', 'Bash', 'pnpm test');
    tool('t2', 'Read', 'a.ts');
    stream.effect(session.id, { type: 'toolResult', toolUseId: 't2', ok: true, detail: null });
    stream.effect(session.id, { type: 'toolResult', toolUseId: 't1', ok: false, detail: 'exit 1: 3 failed' });
    stream.effect(session.id, { type: 'toolResult', toolUseId: 'unknown', ok: true, detail: null }); // ignored
    const tools = a.repos.transcripts.last(session.id).filter((m) => m.payload.kind === 'tool');
    expect(tools.map((m) => m.payload)).toEqual([
      { kind: 'tool', tool: 'Bash', hint: 'pnpm test', toolUseId: 't1', status: 'error', detail: 'exit 1: 3 failed' },
      { kind: 'tool', tool: 'Read', hint: 'a.ts', toolUseId: 't2', status: 'ok', detail: null },
    ]);
    a.publisher.flush();
    const replaces = win.batches().flatMap((b) => b.deltas).filter((d) => d.op === 'transcript.replace');
    expect(replaces).toHaveLength(2);
    expect(a.sessions.get(session.id)?.state).toBe('working');
  });

  it('AskUserQuestion: one decision ask per question; the answers go back together as updatedInput', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const questions = [
      { question: 'Which database?', header: 'Storage', options: [{ label: 'Postgres', description: 'p' }, { label: 'SQLite' }], multiSelect: false },
      { question: 'Add tests?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ];
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'q-1',
      toolName: 'AskUserQuestion',
      input: { questions },
    });
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    const asks = a.repos.pendingAsks.openBySession(session.id);
    expect(asks.map((x) => x.payload)).toEqual([
      { kind: 'decision', prompt: 'Storage — Which database?', options: ['Postgres', 'SQLite', 'Other…'] },
      { kind: 'decision', prompt: 'Add tests?', options: ['Yes', 'No', 'Other…'] },
    ]);
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: asks[0]!.id,
      resolution: { kind: 'decision', chosen: 'Postgres' },
    });
    expect(stream.permissions).toEqual([]); // waits for the second question
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: asks[1]!.id,
      resolution: { kind: 'decision', chosen: 'No' },
    });
    expect(stream.permissions).toEqual([
      {
        id: session.id,
        requestId: 'q-1',
        allow: true,
        updatedInput: { questions, answers: { 'Which database?': 'Postgres', 'Add tests?': 'No' } },
      },
    ]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
    // the decision lines in the chat show what was chosen
    expect(
      a.repos.transcripts
        .last(session.id)
        .filter((m) => m.payload.kind === 'decision')
        .map((m) => (m.payload as { chosen: string | null }).chosen),
    ).toEqual(['Postgres', 'No']);
  });

  it('AskUserQuestion "Other…" → a free-text question ask whose answer is the value; no options → free text directly', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const questions = [
      { question: 'Framework?', options: [{ label: 'React' }] },
      { question: 'Anything else?', options: [] },
    ];
    stream.effect(session.id, { type: 'permission', requestId: 'q-2', toolName: 'AskUserQuestion', input: { questions } });
    const [first, second] = a.repos.pendingAsks.openBySession(session.id);
    expect(second?.payload).toEqual({ kind: 'question', prompt: 'Anything else?' });
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: first!.id,
      resolution: { kind: 'decision', chosen: 'Other…' },
    });
    const followUp = a.repos.pendingAsks.openBySession(session.id).find((x) => x.kind === 'question' && x.payload.kind === 'question' && x.payload.prompt === 'Framework?');
    expect(followUp).toBeDefined();
    expect(stream.permissions).toEqual([]);
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: followUp!.id,
      resolution: { kind: 'question', answer: '  Svelte ' },
    });
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: second!.id,
      resolution: { kind: 'question', answer: 'no' },
    });
    expect(stream.permissions).toEqual([
      {
        id: session.id,
        requestId: 'q-2',
        allow: true,
        updatedInput: { questions, answers: { 'Framework?': 'Svelte', 'Anything else?': 'no' } },
      },
    ]);
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
  });

  it('AskUserQuestion with an unparseable input falls back to a plain Allow/Deny decision', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'permission', requestId: 'q-3', toolName: 'AskUserQuestion', input: {} });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    expect(ask.payload).toEqual({ kind: 'decision', prompt: 'AskUserQuestion', options: ['Allow', 'Deny'] });
    await a.bus.dispatch(sender, 'ask.respond', { askId: ask.id, resolution: { kind: 'decision', chosen: 'Deny' } });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'q-3', allow: false }]);
  });

  it('stopping a session with an open AskUserQuestion denies the request exactly once', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'q-4',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'A?', options: [{ label: 'x' }] }, { question: 'B?', options: [{ label: 'y' }] }] },
    });
    expect(a.repos.pendingAsks.openBySession(session.id)).toHaveLength(2);
    a.sessions.stop(session.id);
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'q-4', allow: false, message: 'Session stopped' }]);
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
  });

  it('ExitPlanMode: a plan ask; approve → allow + the session leaves plan mode; reject → deny with the note', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({ ...spawnInput('claude', ids.worktree.featPromo), permissionMode: 'plan' });
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'p-1',
      toolName: 'ExitPlanMode',
      input: { plan: '# Plan\n1. add validate.ts\n2. wire it up' },
    });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'needs-you', note: 'Plan ready for review' });
    let ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    expect(ask.payload).toEqual({ kind: 'plan', summary: '# Plan\n1. add validate.ts\n2. wire it up', files: [] });
    expect(a.repos.transcripts.last(session.id).at(-1)).toMatchObject({ askId: ask.id, payload: { kind: 'agent' } });

    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'plan', outcome: 'rejected', note: 'Use the existing validator' },
    });
    expect(stream.permissions).toEqual([
      { id: session.id, requestId: 'p-1', allow: false, message: 'Use the existing validator' },
    ]);
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'working', permissionMode: 'plan' });

    stream.effect(session.id, { type: 'permission', requestId: 'p-2', toolName: 'ExitPlanMode', input: { plan: 'v2' } });
    ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'plan', outcome: 'rejected', note: null },
    });
    expect(stream.permissions.at(-1)).toEqual({
      id: session.id,
      requestId: 'p-2',
      allow: false,
      message: 'Plan rejected in Styx',
    });

    stream.effect(session.id, { type: 'permission', requestId: 'p-3', toolName: 'ExitPlanMode', input: { plan: 'v3' } });
    ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'plan', outcome: 'approved', note: null },
    });
    expect(stream.permissions.at(-1)).toEqual({ id: session.id, requestId: 'p-3', allow: true });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'working', permissionMode: 'default' });
    expect(stream.controls.at(-1)).toEqual({ id: session.id, request: { subtype: 'set_permission_mode', mode: 'default' } });
    expect(systemLines(a, session.id).at(-1)).toBe('permissions: Ask each time');
  });

  it('ExitPlanMode approval in a non-plan mode (the agent entered plan mode itself) keeps the stored mode', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({ ...spawnInput('claude', ids.worktree.featPromo), permissionMode: 'acceptEdits' });
    stream.effect(session.id, { type: 'permission', requestId: 'p-9', toolName: 'ExitPlanMode', input: { plan: 'x' } });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'ask.respond', { askId: ask.id, resolution: { kind: 'plan', outcome: 'approved', note: null } });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'p-9', allow: true }]);
    expect(a.sessions.get(session.id)?.permissionMode).toBe('acceptEdits');
    expect(stream.controls).toEqual([]);
  });

  it('configure: a changed model / mode sends the control and a system line; unchanged values and effort are silent', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    a.sessions.configure(session.id, { model: 'opus', permissionMode: 'acceptEdits', effort: 'max' });
    expect(a.sessions.get(session.id)).toMatchObject({ model: 'opus', permissionMode: 'acceptEdits', effort: 'max' });
    expect(stream.controls).toEqual([
      { id: session.id, request: { subtype: 'set_model', model: 'opus' } },
      { id: session.id, request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } },
    ]);
    expect(systemLines(a, session.id)).toEqual(['model: Opus', 'permissions: Accept edits']);
    a.sessions.configure(session.id, { model: 'opus', permissionMode: 'acceptEdits', effort: 'low' });
    expect(stream.controls).toHaveLength(2);
    expect(systemLines(a, session.id)).toHaveLength(2);
    expect(a.sessions.get(session.id)?.effort).toBe('low');
    a.sessions.configure(session.id, { model: null });
    expect(stream.controls.at(-1)).toEqual({ id: session.id, request: { subtype: 'set_model', model: null } });
    expect(systemLines(a, session.id).at(-1)).toBe('model: Default model');
    a.sessions.configure(session.id, { model: 'claude-opus-4-1-20250805' });
    expect(systemLines(a, session.id).at(-1)).toBe('model: claude-opus-4-1-20250805');
    // effort lands on the next relaunch
    stream.live.delete(session.id);
    await a.sessions.sendMessage(session.id, 'go');
    expect(flag(stream.spawned[1]!.args, '--effort')).toBe('low');
  });

  it('interrupt: stream → interrupt control + "interrupted" system line + idle; pty → Ctrl+C only', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(a.sessions.get(session.id)?.state).toBe('working');
    a.sessions.interrupt(session.id);
    expect(stream.controls).toEqual([{ id: session.id, request: { subtype: 'interrupt' } }]);
    expect(systemLines(a, session.id)).toEqual(['interrupted']);
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    await a.bus.dispatch(sender, 'session.interrupt', { sessionId: session.id });
    expect(stream.controls).toHaveLength(2);

    const { session: codex } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    a.sessions.interrupt(codex.id);
    expect(pty.writes.at(-1)).toEqual({ id: codex.id, data: '\x03' });
    expect(systemLines(a, codex.id)).toEqual([]);
    expect(a.sessions.get(codex.id)?.state).toBe('working');
  });

  it('compact_boundary arrives as a system transcript line', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'transcript', body: 'context compacted', payload: { kind: 'system' } });
    expect(systemLines(a, session.id)).toEqual(['context compacted']);
  });

  it('ask.respond is idempotent: a repeat answer to a resolved ask is ok and sends nothing; a cancelled ask is an error', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'permission', requestId: 'r-1', toolName: 'Bash', input: { command: 'ls' } });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    const respond = () =>
      a.bus.dispatch(sender, 'ask.respond', { askId: ask.id, resolution: { kind: 'decision', chosen: 'Allow' } });
    expect(await respond()).toEqual({ ok: true, value: {} });
    expect(await respond()).toEqual({ ok: true, value: {} });
    expect(
      await a.bus.dispatch(sender, 'ask.respond', { askId: ask.id, resolution: { kind: 'decision', chosen: 'Deny' } }),
    ).toEqual({ ok: true, value: {} });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'r-1', allow: true }]);
    expect(a.repos.pendingAsks.get(ask.id)?.resolution).toEqual({ kind: 'decision', chosen: 'Allow' });
    expect(a.sessions.resolveAsk(ask.id, { kind: 'decision', chosen: 'Deny' })).toMatchObject({
      state: 'resolved',
      resolution: { kind: 'decision', chosen: 'Allow' },
    });

    stream.effect(session.id, { type: 'permission', requestId: 'r-2', toolName: 'Bash', input: { command: 'rm' } });
    const second = a.repos.pendingAsks.openBySession(session.id)[0]!;
    a.sessions.stop(session.id);
    expect(a.repos.pendingAsks.get(second.id)?.state).toBe('cancelled');
    expect(
      await a.bus.dispatch(sender, 'ask.respond', { askId: second.id, resolution: { kind: 'decision', chosen: 'Allow' } }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-transition' } });
    expect(() => a.sessions.resolveAsk(second.id, { kind: 'decision', chosen: 'Allow' })).toThrow();
  });
});

describe('SessionService partial messages (stream rows patched live)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rows = (a: TestApp['app'], id: string) => a.repos.transcripts.last(id);
  const deltas = (win: TestApp['win'], op: string) =>
    win
      .batches()
      .flatMap((b) => b.deltas)
      .filter((d) => d.op === op) as unknown as { op: string; body?: string; messageId?: string }[];
  const streaming = (a: TestApp['app'], id: string) =>
    rows(a, id).filter(
      (m) =>
        (m.payload.kind === 'agent' && m.payload.streaming === true) ||
        (m.payload.kind === 'thinking' && m.payload.status === 'streaming'),
    );

  it('text: a streaming row from the first delta, patched at most every 33 ms with a trailing flush, settled on stop, reconciled by the final', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const id = session.id;
    stream.effect(id, { type: 'streamStart', key: 'm:0', kind: 'text' });
    expect(rows(a, id).map((m) => m.payload.kind)).toEqual(['user']); // no row until there is text to show
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'Hel' });
    const row = rows(a, id).at(-1)!;
    expect(row).toMatchObject({ body: 'Hel', payload: { kind: 'agent', streaming: true } }); // lands right away
    const body = () => a.repos.transcripts.get(row.id)?.body;
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'lo' });
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: ' wo' });
    expect(body()).toBe('Hel'); // within the flush window: buffered
    vi.advanceTimersByTime(STREAM_FLUSH_MS - 1);
    expect(body()).toBe('Hel');
    vi.advanceTimersByTime(1);
    expect(body()).toBe('Hello wo');
    a.publisher.flush();
    expect(deltas(win, 'transcript.patch').map((d) => d.body)).toEqual(['Hello wo']);
    expect(deltas(win, 'transcript.replace')).toHaveLength(0);

    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'rld' });
    stream.effect(id, { type: 'streamStop', key: 'm:0' }); // flushes the pending text, then settles the payload
    expect(a.repos.transcripts.get(row.id)).toMatchObject({ body: 'Hello world', payload: { kind: 'agent' } });
    a.publisher.flush();
    expect(deltas(win, 'transcript.patch').map((d) => d.body)).toEqual(['Hello wo', 'Hello world']);
    expect(deltas(win, 'transcript.replace')).toHaveLength(1);

    // The complete block differs (a dropped delta, or the trim): one more patch. Same body: nothing.
    stream.effect(id, { type: 'streamFinal', key: 'm:0', body: 'Hello world!' });
    expect(body()).toBe('Hello world!');
    stream.effect(id, { type: 'streamFinal', key: 'm:0', body: 'ignored: the block is gone' });
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'ignored too' });
    expect(body()).toBe('Hello world!');
    a.publisher.flush();
    expect(deltas(win, 'transcript.patch')).toHaveLength(3);
    expect(deltas(win, 'transcript.replace')).toHaveLength(1);
    expect(streaming(a, id)).toEqual([]);
    expect(rows(a, id).map((m) => m.payload.kind)).toEqual(['user', 'agent']);
  });

  it('the CLI sends the complete block before content_block_stop: the final settles the row, the stop is a no-op', async () => {
    const { app: a, win, clock } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const id = session.id;
    stream.effect(id, { type: 'streamStart', key: 'm:0', kind: 'thinking' });
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'Consider' });
    clock.advance(1200);
    stream.effect(id, { type: 'streamFinal', key: 'm:0', body: 'Consider the tests.' });
    expect(rows(a, id).at(-1)).toMatchObject({
      body: 'Consider the tests.',
      payload: { kind: 'thinking', status: 'done', durationMs: 1200 },
    });
    clock.advance(500);
    stream.effect(id, { type: 'streamStop', key: 'm:0' });
    a.publisher.flush();
    expect(deltas(win, 'transcript.replace')).toHaveLength(1);
    expect(rows(a, id).at(-1)?.payload).toEqual({ kind: 'thinking', status: 'done', durationMs: 1200 });
  });

  it.each<[string, () => void]>([
    ['a thinking block that only ever carries a signature', () => {}],
    ['a text block whose only text is blank', () => stream.effect(ids.session.cursor, { type: 'streamDelta', key: 'm:0', text: ' \n' })],
  ])('%s never gets a row', async (_name, during) => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const id = session.id;
    stream.effect(id, { type: 'streamStart', key: 'm:0', kind: 'thinking' });
    during();
    stream.effect(id, { type: 'streamFinal', key: 'm:0', body: '' });
    stream.effect(id, { type: 'streamStop', key: 'm:0' });
    stream.effect(id, { type: 'streamStart', key: 'm:1', kind: 'text' });
    stream.effect(id, { type: 'streamDelta', key: 'm:1', text: '\n' });
    vi.advanceTimersByTime(STREAM_FLUSH_MS);
    stream.effect(id, { type: 'streamStart', key: 'm:2', kind: 'text' }); // never gets anything before the exit
    stream.emit('exit', id, 0);
    expect(rows(a, id).map((m) => m.payload.kind)).toEqual(['user']);
    a.publisher.flush();
    expect(deltas(win, 'transcript.patch')).toHaveLength(0);
    expect(deltas(win, 'transcript.replace')).toHaveLength(0);
  });

  it('thinking: streamed live, then "done" with the elapsed duration; agent text is redacted on the way in', async () => {
    const { app: a, win, clock } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const id = session.id;
    stream.effect(id, { type: 'streamStart', key: 'm:0', kind: 'thinking' });
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'The key is AKIAABCDEFGHIJKLMNOP, ' });
    const row = rows(a, id).at(-1)!;
    expect(row).toMatchObject({
      body: 'The key is [redacted], ',
      payload: { kind: 'thinking', status: 'streaming', durationMs: null },
    });
    clock.advance(2500);
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'so deploy.' });
    stream.effect(id, { type: 'streamStop', key: 'm:0' });
    expect(a.repos.transcripts.get(row.id)).toMatchObject({
      body: 'The key is [redacted], so deploy.',
      payload: { kind: 'thinking', status: 'done', durationMs: 2500 },
    });
    a.publisher.flush();
    const before = deltas(win, 'transcript.patch').length;
    // The final block equals what was streamed (post-redaction it is compared raw, so a secret means one more patch).
    stream.effect(id, { type: 'streamFinal', key: 'm:0', body: 'The key is AKIAABCDEFGHIJKLMNOP, so deploy.' });
    a.publisher.flush();
    expect(deltas(win, 'transcript.patch').length).toBe(before);
    expect(a.repos.transcripts.get(row.id)?.body).toBe('The key is [redacted], so deploy.');
    // Then the text block of the same message; its final is longer than what streamed (a dropped delta).
    stream.effect(id, { type: 'streamStart', key: 'm:1', kind: 'text' });
    stream.effect(id, { type: 'streamDelta', key: 'm:1', text: 'Deploying' });
    stream.effect(id, { type: 'streamStop', key: 'm:1' });
    stream.effect(id, { type: 'streamFinal', key: 'm:1', body: 'Deploying now.' });
    expect(rows(a, id).map((m) => [m.payload.kind, m.body])).toEqual([
      ['user', 'Fix it'],
      ['thinking', 'The key is [redacted], so deploy.'],
      ['agent', 'Deploying now.'],
    ]);
    expect(streaming(a, id)).toEqual([]);
  });

  it('a streamed final that carries the CLI-outdated message raises the banner like a plain agent row', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const msg = 'API Error: 400 Claude Code 2.1.199 does not support this model; version 2.1.251 or newer is required';
    stream.effect(session.id, { type: 'streamStart', key: 'm:0', kind: 'text' });
    stream.effect(session.id, { type: 'streamDelta', key: 'm:0', text: msg });
    stream.effect(session.id, { type: 'streamStop', key: 'm:0' });
    a.publisher.flush();
    expect(win.events('banner.set')).toEqual([]); // only the complete text is trusted
    stream.effect(session.id, { type: 'streamFinal', key: 'm:0', body: msg });
    a.publisher.flush();
    expect(win.events('banner.set')).toContainEqual(expect.objectContaining({ bannerKey: 'cli-outdated:claude' }));
    expect(rows(a, session.id).map((m) => m.payload.kind)).toEqual(['user', 'agent', 'system']);
  });

  it.each<['exit' | 'interrupt' | 'killAll' | 'stop']>([['exit'], ['interrupt'], ['killAll'], ['stop']])(
    'live rows settle on %s so nothing streams forever; later effects for those keys are ignored',
    async (how) => {
      const { app: a, win, clock } = app();
      const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
      const id = session.id;
      stream.effect(id, { type: 'streamStart', key: 'm:0', kind: 'thinking' });
      stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'Plan' });
      clock.advance(800);
      stream.effect(id, { type: 'streamStart', key: 'm:1', kind: 'text' });
      stream.effect(id, { type: 'streamDelta', key: 'm:1', text: 'Partial ' });
      stream.effect(id, { type: 'streamDelta', key: 'm:1', text: 'answer' }); // still buffered
      expect(streaming(a, id)).toHaveLength(2);
      a.publisher.flush();
      const patchesBefore = deltas(win, 'transcript.patch').length;
      if (how === 'exit') stream.emit('exit', id, 1);
      else if (how === 'interrupt') a.sessions.interrupt(id);
      else if (how === 'stop') a.sessions.stop(id);
      else a.sessions.killAll();
      const after = rows(a, id).filter((m) => m.payload.kind !== 'user' && m.payload.kind !== 'system');
      expect(after.map((m) => [m.body, m.payload])).toEqual([
        ['Plan', { kind: 'thinking', status: 'done', durationMs: 800 }],
        ['Partial answer', { kind: 'agent' }],
      ]);
      a.publisher.flush();
      expect(deltas(win, 'transcript.patch').length).toBe(patchesBefore + 1); // the trailing text flushed once
      expect(deltas(win, 'transcript.replace')).toHaveLength(1);
      expect(a.sessions.get(id)?.state).toBe(how === 'interrupt' ? 'idle' : 'done');
      stream.effect(id, { type: 'streamDelta', key: 'm:1', text: '…more' });
      stream.effect(id, { type: 'streamStop', key: 'm:1' });
      stream.effect(id, { type: 'streamFinal', key: 'm:1', body: 'Partial answer…more' });
      expect(after.map((m) => a.repos.transcripts.get(m.id)?.body)).toEqual(['Plan', 'Partial answer']);
      // No flush timer survives the finalisation (the hunk watcher's own timer may, while the session lives on).
      vi.advanceTimersByTime(STREAM_FLUSH_MS * 2);
      a.publisher.flush();
      expect(deltas(win, 'transcript.patch').length).toBe(patchesBefore + 1);
    },
  );

  it('sweepStreaming settles rows a previous process left streaming (thinking duration unknown)', () => {
    const { app: a, win } = app();
    const sid = ids.session.cursor;
    const base = { sessionId: sid, askId: null, createdAt: DEMO_NOW };
    const seq = a.repos.transcripts.nextSeq(sid);
    a.repos.transcripts.upsert({
      ...base,
      id: '01STALE0000000000000000001' as never,
      seq,
      body: 'half a thought',
      payload: { kind: 'thinking', status: 'streaming', durationMs: null },
    });
    a.repos.transcripts.upsert({
      ...base,
      id: '01STALE0000000000000000002' as never,
      seq: seq + 1,
      body: 'half an answer',
      payload: { kind: 'agent', streaming: true },
    });
    a.repos.transcripts.upsert({
      ...base,
      id: '01STALE0000000000000000003' as never,
      seq: seq + 2,
      body: 'finished',
      payload: { kind: 'agent' },
    });
    expect(streaming(a, sid)).toHaveLength(2);
    a.sessions.sweepStreaming();
    expect(streaming(a, sid)).toEqual([]);
    expect(rows(a, sid).slice(-3)).toMatchObject([
      { body: 'half a thought', payload: { kind: 'thinking', status: 'done', durationMs: null } },
      { body: 'half an answer', payload: { kind: 'agent' } },
      { body: 'finished', payload: { kind: 'agent' } },
    ]);
    a.publisher.flush();
    expect(deltas(win, 'transcript.replace')).toHaveLength(1);
    a.sessions.sweepStreaming(); // idempotent: nothing to settle, nothing published
    a.publisher.flush();
    expect(deltas(win, 'transcript.replace')).toHaveLength(1);
  });

  it('partial deltas are activity at most once per second; streamUsage is accepted and ignored', async () => {
    const { app: a, clock } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const id = session.id;
    const state = () => a.sessions.get(id)?.state;
    stream.effect(id, { type: 'session', event: 'quiet' });
    expect(state()).toBe('idle');
    stream.effect(id, { type: 'streamStart', key: 'm:0', kind: 'text' });
    expect(state()).toBe('working');
    stream.effect(id, { type: 'session', event: 'quiet' });
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'a' }); // throttled: same second
    expect(state()).toBe('idle');
    clock.advance(STREAM_ACTIVITY_MS - 1);
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'b' });
    expect(state()).toBe('idle');
    clock.advance(1);
    stream.effect(id, { type: 'streamDelta', key: 'm:0', text: 'c' });
    expect(state()).toBe('working');
    expect(a.sessions.get(id)?.lastActivityAt).toBe(clock.now());
    stream.effect(id, { type: 'streamUsage', outputTokens: 12 });
    expect(state()).toBe('working');
    stream.effect(id, { type: 'streamStop', key: 'm:0' });
    stream.effect(id, { type: 'streamFinal', key: 'm:0', body: 'abc' });
    expect(rows(a, id).at(-1)).toMatchObject({ body: 'abc', payload: { kind: 'agent' } });
  });
});

describe('SessionService attachments + slash commands', () => {
  const worktreeDir = (a: TestApp['app'], worktreeId: string): string => {
    const base = mkdtempSync(join(tmpdir(), 'styx-attach-'));
    const root = join(base, 'wt');
    const outside = join(base, 'outside');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(MAX_FILE_ATTACHMENT_BYTES + 1));
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    const wt = a.repos.worktrees.get(worktreeId)!;
    a.repos.worktrees.upsert({ ...wt, path: root });
    return root;
  };
  const png = { kind: 'image' as const, name: 'shot.png', mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
  const userRows = (a: TestApp['app'], id: string) =>
    a.repos.transcripts.last(id).filter((m) => m.payload.kind === 'user');

  it('images go to a stream session as base64 blocks; the transcript row keeps metadata only', async () => {
    const { app: a } = app();
    worktreeDir(a, ids.worktree.featPromo);
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'what is this?', [png]);
    expect(stream.sent.at(-1)).toEqual({
      id: session.id,
      text: 'what is this?',
      blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } }],
    });
    expect(userRows(a, session.id).at(-1)).toMatchObject({
      body: 'what is this?',
      payload: { kind: 'user', attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 8 }] },
    });
    expect(JSON.stringify(userRows(a, session.id).at(-1))).not.toContain(png.data);
  });

  it('files are read inside the worktree and inlined after the text; an attachment-only message is named after them', async () => {
    const { app: a } = app();
    worktreeDir(a, ids.worktree.featPromo);
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'review', [{ kind: 'file', path: 'src/a.ts' }, png]);
    expect(stream.sent.at(-1)).toMatchObject({
      text: 'review\n\n<file path="src/a.ts">\nexport const a = 1;\n\n</file>',
    });
    expect(stream.sent.at(-1)!.blocks).toHaveLength(1);
    expect(userRows(a, session.id).at(-1)).toMatchObject({
      body: 'review',
      payload: {
        kind: 'user',
        attachments: [
          { kind: 'file', path: 'src/a.ts', bytes: 20 },
          { kind: 'image', name: 'shot.png' },
        ],
      },
    });
    // nothing typed: the bubble shows the attachment names; the CLI still gets the file
    await a.sessions.sendMessage(session.id, '', [{ kind: 'file', path: './src/../src/a.ts' }, png]);
    expect(userRows(a, session.id).at(-1)).toMatchObject({ body: 'src/a.ts, shot.png' });
    expect(stream.sent.at(-1)!.text).toBe('\n\n<file path="src/a.ts">\nexport const a = 1;\n\n</file>');
    // the terminal log shows the typed text / names, never file contents
    const log = readFileSync(join(t!.userData, 'logs', 'pty', `${session.id}.log`), 'utf8');
    expect(log).toContain('> src/a.ts, shot.png');
    expect(log).not.toContain('export const a = 1');
  });

  it.each([
    ['empty body and no attachments', '', [], 'invalid-input', /empty/],
    ['image over 5 MB', 'x', [{ ...png, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }], 'invalid-input', /shot\.png is larger than 5 MB/],
    ['file over 200 KB', 'x', [{ kind: 'file' as const, path: 'big.txt' }], 'invalid-input', /big\.txt is larger than 200 KB/],
    ['relative escape', 'x', [{ kind: 'file' as const, path: '../outside/secret.txt' }], 'fs-denied', /outside the worktree/],
    ['absolute path outside', 'x', [{ kind: 'file' as const, path: '/etc/passwd' }], 'fs-denied', /outside the worktree/],
    ['symlink escape', 'x', [{ kind: 'file' as const, path: 'escape.txt' }], 'fs-denied', /outside the worktree/],
    ['a directory', 'x', [{ kind: 'file' as const, path: 'src' }], 'invalid-input', /not a file/],
    ['a missing file', 'x', [{ kind: 'file' as const, path: 'src/nope.ts' }], 'invalid-input', /not a file/],
  ])('rejects %s and records nothing', async (_label, body, attachments, code, message) => {
    const { app: a } = app();
    worktreeDir(a, ids.worktree.featPromo);
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const before = userRows(a, session.id).length;
    await expect(a.sessions.sendMessage(session.id, body, attachments)).rejects.toMatchObject({ code, message });
    expect(userRows(a, session.id)).toHaveLength(before);
    expect(stream.sent).toEqual([]);
  });

  it('pty sessions get files inlined too; images are dropped with a system line', async () => {
    const { app: a } = app();
    worktreeDir(a, ids.worktree.testFlaky);
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    await a.sessions.sendMessage(session.id, 'look', [png, { kind: 'file', path: 'src/a.ts' }]);
    expect(pty.writes.at(-1)).toEqual({
      id: session.id,
      data: 'look\n\n<file path="src/a.ts">\nexport const a = 1;\n\n</file>\r',
    });
    const last = a.repos.transcripts.last(session.id).slice(-2);
    expect(last.map((m) => m.payload.kind)).toEqual(['user', 'system']);
    expect(last[1]!.body).toMatch(/Image dropped: Codex .* images need a stream session/);
    expect(last[0]!.payload).toMatchObject({ attachments: [{ kind: 'image' }, { kind: 'file', path: 'src/a.ts' }] });
  });

  it('init stores the slash command list on the session and publishes it; an empty report keeps the last list', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(session.slashCommands).toEqual([]);
    stream.effect(session.id, {
      type: 'init',
      chatId: 'c1',
      model: null,
      permissionMode: null,
      slashCommands: ['compact', 'model'],
    });
    expect(a.sessions.get(session.id)?.slashCommands).toEqual(['compact', 'model']);
    a.publisher.flush();
    const upserts = win
      .batches()
      .flatMap((b) => b.deltas)
      .filter((d): d is { op: string; table: string; rows: { id: string; slashCommands: string[] }[] } =>
        d.op === 'upsert' && (d as { table?: string }).table === 'sessions',
      );
    expect(upserts.at(-1)?.rows.find((r) => r.id === session.id)?.slashCommands).toEqual(['compact', 'model']);
    stream.effect(session.id, { type: 'init', chatId: 'c1', model: null, permissionMode: null, slashCommands: [] });
    expect(a.sessions.get(session.id)?.slashCommands).toEqual(['compact', 'model']);
  });
});
