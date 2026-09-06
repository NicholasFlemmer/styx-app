import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures } from '@styx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { PtyService } from './pty-service';
import { parseCliOutdated, runnerFor } from './session-service';
import type { StreamEffect, StreamEvents, StreamRunnerLike, StreamSpawnOptions } from './stream-runner';

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
  readonly sent: { id: string; text: string }[] = [];
  readonly permissions: { id: string; requestId: string; allow: boolean }[] = [];
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
  send(id: string, text: string): void {
    this.sent.push({ id, text });
  }
  respondPermission(id: string, requestId: string, allow: boolean): void {
    this.permissions.push({ id, requestId, allow });
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
    expect(stream.permissions.at(-1)).toEqual({ id: session.id, requestId: 'b1', allow: false });
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
