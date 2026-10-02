import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENTS_DIR, copy, fixtures, MAX_FILE_ATTACHMENT_BYTES, MAX_UPLOAD_BYTES } from '@styx/core';
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
  setEffort(): void {}
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

/** Waits out the pty typing delay (text, then Enter 120 ms later). */
const typed = () => new Promise((r) => setTimeout(r, 170));

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

    // stop → kill → exit → idle with the exit code and no process (discrepancy #111: only the person
    // finishes a session, so the lane stays this agent's until Mark done).
    a.sessions.stop(session.id);
    const stopped = a.sessions.get(session.id)!;
    expect(stopped.state).toBe('idle');
    expect(stopped.endedAt).toBeNull();
    expect(stopped.exitCode).toBe(0);
    expect(stopped.pid).toBeNull();
    a.sessions.markDone(session.id);
    const done = a.sessions.get(session.id)!;
    expect(done.state).toBe('done');
    expect(done.endedAt).toBe(DEMO_NOW);
    expect(done.exitCode).toBe(0);
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
    // Stopping ends the run, not the session (discrepancy #111).
    expect(a.sessions.get(session.id)?.state).toBe('idle');
  });

  it('auto-approve covers edits inside the worktree only: outside paths, a hidden policy file, a missing path and a titled ACP tool all ask', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      toggles: { autoApproveEdits: true, mayRequestTargets: true, notifyWhenNeedsMe: true },
    });
    const root = a.repos.worktrees.get(session.worktreeId)!.path;
    const ask = (requestId: string, toolName: string, input: Record<string, unknown>) => {
      stream.effect(session.id, { type: 'permission', requestId, toolName, input });
      const auto = stream.permissions.some((p) => p.requestId === requestId && p.allow);
      const open = a.repos.pendingAsks.openBySession(session.id);
      const asked = open.length > 0;
      for (const o of open) a.sessions.resolveAsk(o.id, { kind: 'decision', chosen: 'Deny' });
      return auto ? 'auto' : asked ? 'asked' : 'nothing';
    };
    // Absolute and relative paths under the worktree pass; every path in a multi-file edit must.
    expect(ask('in1', 'Edit', { file_path: `${root}/src/a.ts` })).toBe('auto');
    expect(ask('in2', 'Edit', { file_path: 'src/b.ts', paths: ['src/b.ts', `${root}/src/c.ts`] })).toBe(
      'auto',
    );
    // Outside the worktree (a Codex fileChange approval is by construction for such a path): ask.
    expect(ask('out1', 'Edit', { file_path: '/Users/nic/.zshrc' })).toBe('asked');
    expect(ask('out2', 'Edit', { file_path: '../other/x.ts' })).toBe('asked');
    // The policy file smuggled in as the second path of one change set: ask.
    expect(ask('pol', 'Edit', { file_path: 'README.md', paths: ['README.md', '.styx/project.json'] })).toBe(
      'asked',
    );
    // No path at all (an approval whose item was never seen): ask.
    expect(ask('none', 'Edit', { file_path: '' })).toBe('asked');
    // An ACP tool whose agent-chosen title is "Write" is not an edit unless the runner says so by kind.
    expect(ask('acp1', 'Write', { title: 'Write', styxEdit: false })).toBe('asked');
    expect(ask('acp2', 'tool', { title: 'Write notes', file_path: `${root}/notes.md`, styxEdit: true })).toBe(
      'auto',
    );
  });

  it('Stop while an approval is open cancels the ask and declines it, so a later Allow cannot run it', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'b1',
      toolName: 'Bash',
      input: { command: 'rm x' },
    });
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    a.sessions.interrupt(session.id);
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
    expect(stream.permissions.at(-1)).toMatchObject({ id: session.id, requestId: 'b1', allow: false });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
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
      account: null,
      verifiedAt: null,
      verifyError: null,
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
        searched: [],
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

  it('refreshClis keeps a recorded verification (account, verifiedAt, and its authState) when the binary is unchanged', async () => {
    const { app: a } = app();
    const detection = (authState: 'signed-in' | 'signed-out') => async () => [
      {
        agent: 'claude' as const,
        label: 'Claude Code',
        binary: '/opt/homebrew/bin/claude',
        version: '2.4.1',
        found: true,
        authState,
        capabilities: { streamJson: true },
        source: 'path' as const,
        alternatives: [],
        searched: [],
      },
    ];
    // The CLI itself said nobody is signed in (`agent.verify`), while its credentials file still exists on disk.
    a.repos.discovery.saveCli({
      agent: 'claude',
      binary: '/opt/homebrew/bin/claude',
      version: '2.4.1',
      found: true,
      authState: 'signed-out',
      capabilities: { streamJson: true, source: 'path' },
      checkedAt: DEMO_NOW,
      account: null,
      verifiedAt: DEMO_NOW,
      verifyError: null,
    });
    a.detect.detectClis = detection('signed-in');
    expect((await a.sessions.refreshClis()).find((c) => c.agent === 'claude')).toMatchObject({
      authState: 'signed-out',
      verifiedAt: DEMO_NOW,
      account: null,
    });
    // A different binary is a different install: the verification no longer applies and detection is trusted.
    a.detect.detectClis = async () => [
      { ...(await detection('signed-in')())[0]!, binary: '/usr/local/bin/claude' },
    ];
    expect((await a.sessions.refreshClis()).find((c) => c.agent === 'claude')).toMatchObject({
      authState: 'signed-in',
      verifiedAt: null,
      binary: '/usr/local/bin/claude',
    });
  });
});

describe('a lane is named by its task', () => {
  it('a lane started without a first message takes the first thing sent as its task, once', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo, ''));
    expect(a.sessions.get(session.id)?.firstMessage).toBeNull();
    stream.effect(session.id, { type: 'note', note: 'Reading checkout.ts' });
    await a.sessions.sendMessage(session.id, 'Make the header sticky');
    expect(a.sessions.get(session.id)?.firstMessage).toBe('Make the header sticky');
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    await a.sessions.sendMessage(session.id, 'And on mobile');
    expect(a.sessions.get(session.id)?.firstMessage).toBe('Make the header sticky');
  });

  it('backfills lanes from before: the first thing said, not the latest status', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo, ''));
    a.transcript.user(session.id, 'Ship the pricing page');
    a.repos.sessions.upsert({
      ...a.sessions.get(session.id)!,
      firstMessage: null,
      note: 'The build is packaging',
    });
    a.sessions.backfillTasks();
    expect(a.sessions.get(session.id)?.firstMessage).toBe('Ship the pricing page');
  });
});

describe('design and build tasks (#140)', () => {
  it('a design task stores its kind and gets the design brief ahead of its first turn', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo, 'A checkout'),
      kind: 'design',
    });
    expect(a.sessions.get(session.id)?.kind).toBe('design');
    expect(stream.spawned.at(-1)?.firstMessage).toContain('.styx/designs/<screen>/<size>.html');
    expect(stream.spawned.at(-1)?.firstMessage).toContain('A checkout');
  });

  it('a build task links only to a design task of the same project', async () => {
    const { app: a } = app();
    const { session: build } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo, 'x'));
    await expect(
      a.sessions.spawn({
        ...spawnInput('claude', ids.worktree.featPromo, 'y'),
        kind: 'build',
        designSessionId: build.id,
      }),
    ).rejects.toThrow();
  });

  it('a message pointing at something keeps a chip on the row and gives the agent the detail', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo, ''));
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    await a.sessions.sendMessage(session.id, 'Make it sticky', [], {
      pointer: { source: 'design', label: 'Checkout › Pay button', detail: 'Screen: checkout/desktop.html' },
    });
    const row = a.repos.transcripts.last(session.id).at(-1);
    expect(row?.body).toBe('Make it sticky');
    expect(row?.payload).toMatchObject({
      kind: 'user',
      pointer: { source: 'design', label: 'Checkout › Pay button' },
    });
    expect(stream.sent.at(-1)?.text).toContain('Screen: checkout/desktop.html');
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
        searched: [],
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

describe('SessionService.tell + the launch preamble (ADR-0025)', () => {
  const system = (a: TestApp['app'], id: string) =>
    a.repos.transcripts
      .last(id)
      .filter((m) => m.payload.kind === 'system')
      .map((m) => m.body);

  it('a Styx line reaches a working agent at once, an idle one ahead of its next message; the chat shows it either way', async () => {
    const { app: a } = app();
    const cursor = a.repos.sessions.get(ids.session.cursor)!;
    a.repos.sessions.upsert({ ...cursor, state: 'done', endedAt: DEMO_NOW, pid: null, exitCode: 0 });
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(a.sessions.get(session.id)?.state).toBe('working');
    a.sessions.tell(session.id, 'Codex on test/flaky also changed a.ts.');
    expect(stream.sent).toEqual([{ id: session.id, text: 'Codex on test/flaky also changed a.ts.' }]);
    expect(system(a, session.id).at(-1)).toBe('Codex on test/flaky also changed a.ts.');
    // Idle: owed, not sent — the agent is not woken up — and it rides the next message, ahead of it.
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    a.sessions.tell(session.id, 'Shared file: package.json should have one owner.');
    expect(stream.sent).toHaveLength(1);
    expect(system(a, session.id).at(-1)).toBe('Shared file: package.json should have one owner.');
    await a.sessions.sendMessage(session.id, 'Now add tests');
    expect(stream.sent.at(-1)).toEqual({
      id: session.id,
      text: 'Shared file: package.json should have one owner.\n\nNow add tests',
    });
    // The transcript keeps the human's words only.
    expect(
      a.repos.transcripts
        .last(session.id)
        .filter((m) => m.payload.kind === 'user')
        .map((m) => m.body),
    ).toEqual(['Fix it', 'Now add tests']);
    // Done: shown, never sent.
    a.sessions.stop(session.id);
    a.sessions.tell(session.id, 'late');
    expect(system(a, session.id).at(-1)).toBe('late');
    expect(stream.sent).toHaveLength(2);
  });

  it('a session started blank on a CLI without a system-prompt flag gets the preamble ahead of its first message', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky, ''));
    expect(pty.spawned[0]!.args.at(-1)).not.toContain('From Styx');
    // `start` is `working` until the CLI goes quiet; the TUI's prompt is the notify hook's job.
    a.sessions.onHook(session.id, 'codex', 'notify', {
      type: 'agent-turn-complete',
      'last-assistant-message': '',
    });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    await a.sessions.sendMessage(session.id, 'Start with the flaky test');
    const typed = pty.writes.find((w) => w.id === session.id && w.data.includes('Start with the flaky test'));
    expect(typed?.data.startsWith('From Styx, the app running this session')).toBe(true);
    expect(typed?.data).toContain('Your worktree is the branch test/flaky, cut from main.');
    expect(typed?.data.endsWith('\n\nStart with the flaky test')).toBe(true);
    // Claude Code gets its lines in the system prompt instead: nothing rides its messages.
    const cursor = a.repos.sessions.get(ids.session.cursor)!;
    a.repos.sessions.upsert({ ...cursor, state: 'done', endedAt: DEMO_NOW, pid: null, exitCode: 0 });
    const claude = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo, ''));
    stream.effect(claude.session.id, { type: 'session', event: 'quiet' });
    await a.sessions.sendMessage(claude.session.id, 'hello');
    expect(stream.sent.at(-1)).toEqual({ id: claude.session.id, text: 'hello' });
  });
});

describe('why an agent did not get going (#125)', () => {
  it('a missing CLI counts once as cli-missing, however often it is retried', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    a.repos.discovery.saveCli({
      agent: 'codex',
      binary: null,
      version: null,
      found: false,
      authState: 'unknown',
      capabilities: {},
      checkedAt: DEMO_NOW,
      account: null,
      verifiedAt: null,
      verifyError: null,
    });
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    a.detect.detectClis = async () => [];
    await a.sessions.resume(session.id).catch(() => undefined);
    expect(record.mock.calls.map((c) => c[0]).filter((n) => n.startsWith('agent.failed'))).toEqual([
      'agent.failed.cli-missing',
    ]);
  });

  it('a signed-out CLI counts as sign-in; another error before the first turn as error; after a turn, nothing', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'error', message: 'Invalid API key · Please run /login' });
    stream.effect(session.id, { type: 'error', message: 'Something odd happened' });
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    stream.effect(session.id, { type: 'error', message: 'Overloaded, try again' });
    expect(record.mock.calls.map((c) => c[0]).filter((n) => n.startsWith('agent.failed'))).toEqual([
      'agent.failed.sign-in',
      'agent.failed.error',
    ]);
  });

  it('a CLI that exits with an error straight after launch counts as exited; a clean exit does not', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    const first = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    pty.exit(first.session.id, 1);
    const cursor = a.repos.sessions.get(ids.session.cursor)!;
    a.repos.sessions.upsert({ ...cursor, state: 'done', endedAt: DEMO_NOW, pid: null, exitCode: 0 });
    // A real folder: a Gemini launch writes its settings into the worktree, and the fixture's path is a display path.
    const promo = a.repos.worktrees.get(ids.worktree.featPromo)!;
    a.repos.worktrees.upsert({ ...promo, path: mkdtempSync(join(tmpdir(), 'styx-early-exit-')) });
    const second = await a.sessions.spawn(spawnInput('gemini', ids.worktree.featPromo));
    pty.exit(second.session.id, 0);
    expect(record.mock.calls.map((c) => c[0]).filter((n) => n.startsWith('agent.failed'))).toEqual([
      'agent.failed.exited',
    ]);
  });
});

describe('an agent that got going (#127)', () => {
  it('counts agent.worked once per session, on its first finished turn, however the work was asked for', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(record.mock.calls.map((c) => c[0])).not.toContain('agent.worked');
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    stream.effect(session.id, { type: 'session', event: 'activity' });
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(record.mock.calls.map((c) => c[0]).filter((n) => n === 'agent.worked')).toEqual(['agent.worked']);
  });

  it('a turn that ended in an error is not work (#129); the next clean one is', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'error', message: 'Something odd happened' });
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(record.mock.calls.map((c) => c[0])).not.toContain('agent.worked');
    stream.effect(session.id, { type: 'session', event: 'activity' });
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(record.mock.calls.map((c) => c[0]).filter((n) => n === 'agent.worked')).toEqual(['agent.worked']);
  });

  it('names a spent limit or quota as limit, and an expired token as sign-in (#129)', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    const one = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(one.session.id, { type: 'error', message: 'Claude AI usage limit reached|1790000000' });
    const two = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    stream.effect(two.session.id, {
      type: 'error',
      message: 'OAuth token has expired. Please obtain a new token',
    });
    expect(record.mock.calls.map((c) => c[0]).filter((n) => n.startsWith('agent.failed'))).toEqual([
      'agent.failed.limit',
      'agent.failed.sign-in',
    ]);
  });

  it('a retry the CLI makes by itself, and the error after the user pressed Stop, are not problems (#129)', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'error',
      message: 'stream disconnected (Codex will retry)',
      carriesOn: true,
    });
    a.sessions.interrupt(session.id);
    stream.effect(session.id, { type: 'error', message: 'error_during_execution' });
    expect(record.mock.calls.map((c) => c[0]).filter((n) => n.startsWith('agent.failed'))).toEqual([]);
  });

  it('a first message in the spawn dialog counts as a message sent; an empty one does not', async () => {
    const { app: a } = app();
    const record = vi.spyOn(a.usageReports, 'record');
    await a.bus.dispatch(sender, 'session.spawn', {
      ...spawnInput('claude', ids.worktree.featPromo),
      firstMessage: '  ',
    });
    expect(record.mock.calls.map((c) => c[0])).toEqual(['agent.spawned']);
    await a.bus.dispatch(sender, 'session.spawn', spawnInput('codex', ids.worktree.testFlaky));
    expect(record.mock.calls.map((c) => c[0]).slice(1)).toEqual(['agent.spawned', 'message.sent']);
  });
});

describe('SessionService pty runner + CLI hooks', () => {
  it('spawns codex on a pty, typing routes to the pty, and hooks drive the state', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    expect(session.runner).toBe('pty');
    expect(pty.spawned[0]).toMatchObject({ id: session.id, shell: '/opt/homebrew/bin/codex' });
    // No system-prompt flag: the lines Claude Code gets go ahead of the first message (ADR-0025).
    const prompt = pty.spawned[0]!.args.at(-1) ?? '';
    expect(prompt.startsWith('From Styx, the app running this session')).toBe(true);
    expect(prompt).toContain(copy.agentPrompt.shims);
    expect(prompt).toContain('Your worktree is the branch test/flaky, cut from main.');
    expect(prompt.endsWith('\n\nFix it')).toBe(true);
    expect(pty.spawned[0]!.args).toEqual(expect.arrayContaining(['-c']));
    expect(session.state).toBe('working');

    a.sessions.onHook(session.id, 'codex', 'notify', {
      type: 'agent-turn-complete',
      'last-assistant-message': 'All green.',
    });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'idle', note: 'All green.' });

    // Idle: the message goes straight into the TUI (mid-turn it would wait in the queue instead).
    a.sessions.sendMessage(session.id, 'more');
    await typed();
    // Text, then Enter a beat later: one write would be a paste burst to a TUI, and Enter inside it a newline.
    expect(pty.writes).toEqual([
      { id: session.id, data: 'more' },
      { id: session.id, data: '\r' },
    ]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
    a.sessions.onHook(session.id, 'codex', 'notify', { type: 'agent-turn-complete' });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
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
      account: null,
      verifiedAt: null,
      verifyError: null,
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
      account: null,
      verifiedAt: null,
      verifyError: null,
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
    await typed();
    expect(pty.writes.slice(-2)).toEqual([
      { id: session.id, data: 'postgres' },
      { id: session.id, data: '\r' },
    ]);
    expect(a.sessions.get(session.id)?.state).toBe('working');

    a.sessions.onHook(session.id, 'claude', 'SessionEnd', { reason: 'clear' });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    // The CLI ended its own session: idle, not done — the person decides that (discrepancy #111).
    a.sessions.onHook(session.id, 'claude', 'SessionEnd', { reason: 'exit' });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'idle', exitCode: null, pid: null });
    pty.exit(session.id, 3);
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'idle', exitCode: 3 });
    a.sessions.markDone(session.id);
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
      account: null,
      verifiedAt: null,
      verifyError: null,
    });
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    expect(session).toMatchObject({ state: 'paused', pausedReason: 'cli-missing' });
    expect(pty.spawned).toHaveLength(0);
    // `resume` re-detects, so the first attempt must be stubbed too: left unstubbed it scanned the real PATH,
    // which made the assertion depend on whether this machine happens to have codex (and cost ~2s).
    a.detect.detectClis = async () => [
      {
        agent: 'codex',
        label: 'Codex',
        binary: null,
        version: null,
        found: false,
        authState: 'unknown',
        capabilities: {},
        source: 'path',
        alternatives: [],
        searched: [],
      },
    ];
    await expect(a.sessions.resume(session.id)).rejects.toMatchObject({ code: 'cli-missing' });
    // ...and now detection finds it.
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
        searched: [],
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
    // Stop ends the run; the session waits in its lane until it is marked done (discrepancy #111), and
    // archiving still refuses until then.
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'idle', endedAt: null });
    expect(await a.bus.dispatch(sender, 'session.archive', { sessionId: session.id })).toMatchObject({
      ok: false,
      error: { code: 'invalid-transition' },
    });
    expect(await a.bus.dispatch(sender, 'session.markDone', { sessionId: session.id })).toMatchObject({
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
    expect(a.sessions.get(session.id)).toMatchObject({
      cliSessionId: 'cli-sess-9',
      model: 'claude-opus-4-1',
    });
    // a second init (the CLI restarted) keeps an explicit model; a null chat id keeps the stored one
    a.sessions.configure(session.id, { model: 'sonnet' });
    stream.effect(session.id, {
      type: 'init',
      chatId: null,
      model: 'claude-x',
      permissionMode: null,
      slashCommands: [],
    });
    expect(a.sessions.get(session.id)).toMatchObject({ cliSessionId: 'cli-sess-9', model: 'sonnet' });

    stream.effect(session.id, { type: 'session', event: 'quiet' });
    stream.live.delete(session.id);
    await a.sessions.sendMessage(session.id, 'continue');
    const args = stream.spawned[1]!.args;
    expect(flag(args, '--resume')).toBe('cli-sess-9');
    expect(flag(args, '--model')).toBe('sonnet');
    expect(stream.spawned[0]!.args).not.toContain('--resume');
  });

  it('session.reopen: a finished session comes back with its transcript, relaunched on its CLI conversation', async () => {
    const { app: a, clock } = app();
    const { session, worktree } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'init',
      chatId: 'cli-sess-3',
      model: 'claude-opus-4-1',
      permissionMode: 'default',
      slashCommands: [],
    });
    // Only a finished session reopens.
    expect(await a.bus.dispatch(sender, 'session.reopen', { sessionId: session.id })).toMatchObject({
      ok: false,
      error: { code: 'invalid-transition' },
    });
    await a.bus.dispatch(sender, 'session.stop', { sessionId: session.id });
    await a.bus.dispatch(sender, 'session.markDone', { sessionId: session.id });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'done', endedAt: DEMO_NOW, exitCode: 0 });
    a.repos.worktrees.upsert({ ...a.repos.worktrees.get(worktree.id)!, owner: { kind: 'user' } });

    clock.advance(5_000);
    expect(await a.bus.dispatch(sender, 'session.reopen', { sessionId: session.id })).toMatchObject({
      ok: true,
    });
    // Reopened and relaunched, but idle: a launch is not a turn, so the agent waits for a message rather than
    // appearing to work on nothing (owner request, discrepancy #111).
    expect(a.sessions.get(session.id)).toMatchObject({
      state: 'idle',
      endedAt: null,
      exitCode: null,
      pid: 777,
      cliSessionId: 'cli-sess-3',
      lastActivityAt: DEMO_NOW,
    });
    // Same worktree, taken back; the CLI resumes its own conversation and replays nothing.
    expect(a.repos.worktrees.get(worktree.id)?.owner).toEqual({ kind: 'session', sessionId: session.id });
    expect(stream.spawned).toHaveLength(2);
    const again = stream.spawned[1]!;
    expect(flag(again.args, '--resume')).toBe('cli-sess-3');
    expect(again.firstMessage).toBeNull();
    expect(again.cwd).toBe(worktree.path);
    expect(again.env['STYX_TOKEN']).not.toBe(stream.spawned[0]!.env['STYX_TOKEN']);
    // The transcript is kept and says the conversation continues; Home hears about it.
    expect(a.repos.transcripts.last(session.id).map((m) => [m.payload.kind, m.body])).toEqual([
      ['user', 'Fix it'],
      ['system', copy.chat.controls.reopened],
    ]);
    expect(a.repos.activity.recent(1)[0]).toMatchObject({
      who: 'Claude',
      what: 'acme-shop · reopened on feat/promo',
      sessionId: session.id,
    });
    expect(a.repos.projects.get(ids.project.acmeShop)?.lastActivityAt).toBe(DEMO_NOW + 5_000);

    // An archived chat (Close chat, the 7 days) comes back too, out of the archive (owner request); a session whose
    // CLI never reported an id says it starts over.
    await a.bus.dispatch(sender, 'session.stop', { sessionId: session.id });
    await a.bus.dispatch(sender, 'session.markDone', { sessionId: session.id });
    a.sessions.archive(session.id);
    expect(await a.bus.dispatch(sender, 'session.reopen', { sessionId: session.id })).toMatchObject({
      ok: true,
    });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'idle', archivedAt: null });
    expect(flag(stream.spawned[2]!.args, '--resume')).toBe('cli-sess-3');
    const fresh = await a.sessions.spawn(spawnInput('claude', ids.worktree.testFlaky, ''));
    a.sessions.stop(fresh.session.id);
    a.sessions.markDone(fresh.session.id);
    await a.sessions.reopen(fresh.session.id);
    expect(stream.spawned[4]!.args).not.toContain('--resume');
    expect(systemLines(a, fresh.session.id)).toEqual([
      'reopened — Claude starts a new conversation; the messages above are kept',
    ]);
  });

  it.each([
    ['first result', 0, 0, { costUsd: 0.02, numTurns: 2 }, { costUsd: 0.02, numTurns: 2 }],
    ['running total grows', 0.02, 2, { costUsd: 0.05, numTurns: 5 }, { costUsd: 0.05, numTurns: 5 }],
    [
      'a restarted CLI reports less: keep the max',
      0.05,
      5,
      { costUsd: 0.01, numTurns: 1 },
      { costUsd: 0.05, numTurns: 5 },
    ],
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
      {
        kind: 'tool',
        tool: 'Bash',
        hint: 'pnpm test',
        toolUseId: 't1',
        status: 'error',
        detail: 'exit 1: 3 failed',
      },
      { kind: 'tool', tool: 'Read', hint: 'a.ts', toolUseId: 't2', status: 'ok', detail: null },
    ]);
    a.publisher.flush();
    const replaces = win
      .batches()
      .flatMap((b) => b.deltas)
      .filter((d) => d.op === 'transcript.replace');
    expect(replaces).toHaveLength(2);
    expect(a.sessions.get(session.id)?.state).toBe('working');
  });

  it('AskUserQuestion: one ask holds the whole set; the answers go back together as updatedInput', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const questions = [
      {
        question: 'Which database?',
        header: 'Storage',
        options: [{ label: 'Postgres', description: 'p' }, { label: 'SQLite' }],
        multiSelect: false,
      },
      { question: 'Add tests?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: true },
    ];
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'q-1',
      toolName: 'AskUserQuestion',
      input: { questions },
    });
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    // One ask for the set, not one per question: the whole thing renders as a single card.
    const asks = a.repos.pendingAsks.openBySession(session.id);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.payload).toEqual({
      kind: 'questions',
      questions: [
        {
          key: 'Which database?',
          header: 'Storage',
          prompt: 'Which database?',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'p' },
            { label: 'SQLite', description: null },
          ],
        },
        {
          key: 'Add tests?',
          header: null,
          prompt: 'Add tests?',
          multiSelect: true,
          options: [
            { label: 'Yes', description: null },
            { label: 'No', description: null },
          ],
        },
      ],
    });
    // Multi-select joins its labels; free text wins over ticked labels on the question that has both.
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: asks[0]!.id,
      resolution: {
        kind: 'questions',
        answers: [
          { key: 'Which database?', chosen: ['Postgres'], freeText: null },
          { key: 'Add tests?', chosen: ['Yes', 'No'], freeText: null },
        ],
      },
    });
    expect(stream.permissions).toEqual([
      {
        id: session.id,
        requestId: 'q-1',
        allow: true,
        updatedInput: { questions, answers: { 'Which database?': 'Postgres', 'Add tests?': 'Yes, No' } },
      },
    ]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
    // The set renders as one questions row carrying every question.
    const row = a.repos.transcripts.last(session.id).find((m) => m.payload.kind === 'questions');
    expect((row?.payload as { questions: unknown[] }).questions).toHaveLength(2);
  });

  it('AskUserQuestion: free text answers a question instead of its labels', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'q-2',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }] }] },
    });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: {
        kind: 'questions',
        answers: [{ key: 'Which database?', chosen: ['Postgres'], freeText: 'DuckDB, actually' }],
      },
    });
    expect(stream.permissions[0]?.updatedInput).toMatchObject({
      answers: { 'Which database?': 'DuckDB, actually' },
    });
  });

  it('AskUserQuestion: a question with no options carries an empty option list (free text only)', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const questions = [
      { question: 'Framework?', options: [{ label: 'React' }] },
      { question: 'Anything else?', options: [] },
    ];
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'q-3',
      toolName: 'AskUserQuestion',
      input: { questions },
    });
    const asks = a.repos.pendingAsks.openBySession(session.id);
    expect(asks).toHaveLength(1);
    const set = (asks[0]!.payload as { questions: { prompt: string; options: unknown[] }[] }).questions;
    expect(set.map((q) => [q.prompt, q.options.length])).toEqual([
      ['Framework?', 1],
      ['Anything else?', 0],
    ]);
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: asks[0]!.id,
      resolution: {
        kind: 'questions',
        answers: [
          { key: 'Framework?', chosen: ['React'], freeText: null },
          { key: 'Anything else?', chosen: [], freeText: '  no  ' },
        ],
      },
    });
    expect(stream.permissions).toEqual([
      {
        id: session.id,
        requestId: 'q-3',
        allow: true,
        updatedInput: { questions, answers: { 'Framework?': 'React', 'Anything else?': 'no' } },
      },
    ]);
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
  });

  it('AskUserQuestion with an unparseable input falls back to a plain Allow/Deny decision', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'q-3',
      toolName: 'AskUserQuestion',
      input: {},
    });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    expect(ask.payload).toEqual({ kind: 'decision', prompt: 'AskUserQuestion', options: ['Allow', 'Deny'] });
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'decision', chosen: 'Deny' },
    });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'q-3', allow: false }]);
  });

  it('close: a running session ends, archives and cancels its open ask (archive alone refuses a live session)', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'c-1',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'A?', options: [{ label: 'x' }] }] },
    });
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    // Archiving a live session is the 7-day retention step and refuses; closing it is what a ✕ does.
    await expect(a.bus.dispatch(sender, 'session.archive', { sessionId: session.id })).resolves.toMatchObject(
      {
        ok: false,
      },
    );
    await a.bus.dispatch(sender, 'session.close', { sessionId: session.id });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'done' });
    expect(a.sessions.get(session.id)?.archivedAt).not.toBeNull();
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
    expect(stream.permissions).toEqual([
      { id: session.id, requestId: 'c-1', allow: false, message: 'Session stopped' },
    ]);
  });

  it('stopping a session with an open AskUserQuestion denies the request exactly once', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'q-4',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'A?', options: [{ label: 'x' }] },
          { question: 'B?', options: [{ label: 'y' }] },
        ],
      },
    });
    // One ask holds both questions, so there is a single thing to cancel.
    expect(a.repos.pendingAsks.openBySession(session.id)).toHaveLength(1);
    a.sessions.stop(session.id);
    expect(stream.permissions).toEqual([
      { id: session.id, requestId: 'q-4', allow: false, message: 'Session stopped' },
    ]);
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
  });

  it('ExitPlanMode: a plan ask; approve → allow + the session leaves plan mode; reject → deny with the note', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      permissionMode: 'plan',
    });
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'p-1',
      toolName: 'ExitPlanMode',
      input: { plan: '# Plan\n1. add validate.ts\n2. wire it up' },
    });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'needs-you', note: 'Plan ready for review' });
    let ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    expect(ask.payload).toEqual({
      kind: 'plan',
      summary: '# Plan\n1. add validate.ts\n2. wire it up',
      files: [],
    });
    // The plan gets its own transcript kind, so it renders as an approvable card instead of agent prose.
    expect(a.repos.transcripts.last(session.id).at(-1)).toMatchObject({
      askId: ask.id,
      payload: { kind: 'plan' },
    });

    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'plan', outcome: 'rejected', note: 'Use the existing validator' },
    });
    expect(stream.permissions).toEqual([
      { id: session.id, requestId: 'p-1', allow: false, message: 'Use the existing validator' },
    ]);
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'working', permissionMode: 'plan' });

    stream.effect(session.id, {
      type: 'permission',
      requestId: 'p-2',
      toolName: 'ExitPlanMode',
      input: { plan: 'v2' },
    });
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

    stream.effect(session.id, {
      type: 'permission',
      requestId: 'p-3',
      toolName: 'ExitPlanMode',
      input: { plan: 'v3' },
    });
    ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'plan', outcome: 'approved', note: null },
    });
    expect(stream.permissions.at(-1)).toEqual({ id: session.id, requestId: 'p-3', allow: true });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'working', permissionMode: 'default' });
    expect(stream.controls.at(-1)).toEqual({
      id: session.id,
      request: { subtype: 'set_permission_mode', mode: 'default' },
    });
    expect(systemLines(a, session.id).at(-1)).toBe('permissions: Ask each time');
  });

  it('ExitPlanMode approval in a non-plan mode (the agent entered plan mode itself) keeps the stored mode', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      permissionMode: 'acceptEdits',
    });
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'p-9',
      toolName: 'ExitPlanMode',
      input: { plan: 'x' },
    });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'ask.respond', {
      askId: ask.id,
      resolution: { kind: 'plan', outcome: 'approved', note: null },
    });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'p-9', allow: true }]);
    expect(a.sessions.get(session.id)?.permissionMode).toBe('acceptEdits');
    expect(stream.controls).toEqual([]);
  });

  it('configure: a changed model / mode sends the control and a system line; unchanged values and effort are silent', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    a.sessions.configure(session.id, { model: 'opus', permissionMode: 'acceptEdits', effort: 'max' });
    expect(a.sessions.get(session.id)).toMatchObject({
      model: 'opus',
      permissionMode: 'acceptEdits',
      effort: 'max',
    });
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
    expect(stream.controls.at(-1)).toEqual({
      id: session.id,
      request: { subtype: 'set_model', model: null },
    });
    expect(systemLines(a, session.id).at(-1)).toBe('model: Default model');
    a.sessions.configure(session.id, { model: 'claude-opus-4-1-20250805' });
    expect(systemLines(a, session.id).at(-1)).toBe('model: claude-opus-4-1-20250805');
    // effort lands on the next relaunch
    stream.live.delete(session.id);
    await a.sessions.sendMessage(session.id, 'go');
    expect(flag(stream.spawned[1]!.args, '--effort')).toBe('low');
  });

  it('pause holds the next tool request and resume releases it into the same run', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    a.sessions.applyEvent(session.id, { type: 'activity' });
    expect(a.sessions.get(session.id)?.state).toBe('working');

    await a.bus.dispatch(sender, 'session.pause', { sessionId: session.id });
    expect(a.sessions.get(session.id)).toMatchObject({ state: 'paused', pausedReason: 'user' });

    // A tool request arriving while held is parked, not answered: no ask, no needs-you, nothing sent to the CLI.
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'p-held',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
    });
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
    expect(stream.permissions).toEqual([]);
    expect(a.sessions.get(session.id)?.state).toBe('paused');

    // Resuming releases it: the request becomes the ask it would have been, and the turn was never torn down.
    await a.bus.dispatch(sender, 'session.resume', { sessionId: session.id });
    const asks = a.repos.pendingAsks.openBySession(session.id);
    expect(asks).toHaveLength(1);
    expect(asks[0]?.payload).toMatchObject({ kind: 'decision' });
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    expect(systemLines(a, session.id)).toContain('resumed');
  });

  it('pause raises no banner: it is a hold, not a fault', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.bus.dispatch(sender, 'session.pause', { sessionId: session.id });
    expect(a.repos.sessions.get(session.id)?.pausedReason).toBe('user');
    expect(a.repos.notifications.all().filter((n) => n.bannerKey !== null)).toEqual([]);
  });

  it('pausing twice is harmless; a finished session cannot be paused', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.bus.dispatch(sender, 'session.pause', { sessionId: session.id });
    const r = await a.bus.dispatch(sender, 'session.pause', { sessionId: session.id });
    expect(r).toMatchObject({ ok: true });
    expect(a.sessions.get(session.id)?.pausedReason).toBe('user');
    a.sessions.close(session.id);
    await expect(a.bus.dispatch(sender, 'session.pause', { sessionId: session.id })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('interrupt: stream → interrupt control + "interrupted" system line + idle; pty → Ctrl+C, line and idle', async () => {
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
    // A pty session used to get ^C silently: no line in the chat and no state change, so nothing looked to have
    // happened. It now reports itself like the stream branch does.
    expect(systemLines(a, codex.id)).toEqual(['interrupted']);
    // ...and ends the turn, rather than sitting in 'working' until the CLI's own hook happens to fire.
    expect(a.sessions.get(codex.id)?.state).toBe('idle');
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
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'r-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    const respond = () =>
      a.bus.dispatch(sender, 'ask.respond', {
        askId: ask.id,
        resolution: { kind: 'decision', chosen: 'Allow' },
      });
    expect(await respond()).toEqual({ ok: true, value: {} });
    expect(await respond()).toEqual({ ok: true, value: {} });
    expect(
      await a.bus.dispatch(sender, 'ask.respond', {
        askId: ask.id,
        resolution: { kind: 'decision', chosen: 'Deny' },
      }),
    ).toEqual({ ok: true, value: {} });
    expect(stream.permissions).toEqual([{ id: session.id, requestId: 'r-1', allow: true }]);
    expect(a.repos.pendingAsks.get(ask.id)?.resolution).toEqual({ kind: 'decision', chosen: 'Allow' });
    expect(a.sessions.resolveAsk(ask.id, { kind: 'decision', chosen: 'Deny' })).toMatchObject({
      state: 'resolved',
      resolution: { kind: 'decision', chosen: 'Allow' },
    });

    stream.effect(session.id, {
      type: 'permission',
      requestId: 'r-2',
      toolName: 'Bash',
      input: { command: 'rm' },
    });
    const second = a.repos.pendingAsks.openBySession(session.id)[0]!;
    a.sessions.stop(session.id);
    expect(a.repos.pendingAsks.get(second.id)?.state).toBe('cancelled');
    expect(
      await a.bus.dispatch(sender, 'ask.respond', {
        askId: second.id,
        resolution: { kind: 'decision', chosen: 'Allow' },
      }),
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
    expect(a.repos.transcripts.get(row.id)).toMatchObject({
      body: 'Hello world',
      payload: { kind: 'agent' },
    });
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
    [
      'a text block whose only text is blank',
      () => stream.effect(ids.session.cursor, { type: 'streamDelta', key: 'm:0', text: ' \n' }),
    ],
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
    stream.effect(id, {
      type: 'streamFinal',
      key: 'm:0',
      body: 'The key is AKIAABCDEFGHIJKLMNOP, so deploy.',
    });
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
    const msg =
      'API Error: 400 Claude Code 2.1.199 does not support this model; version 2.1.251 or newer is required';
    stream.effect(session.id, { type: 'streamStart', key: 'm:0', kind: 'text' });
    stream.effect(session.id, { type: 'streamDelta', key: 'm:0', text: msg });
    stream.effect(session.id, { type: 'streamStop', key: 'm:0' });
    a.publisher.flush();
    expect(win.events('banner.set')).toEqual([]); // only the complete text is trusted
    stream.effect(session.id, { type: 'streamFinal', key: 'm:0', body: msg });
    a.publisher.flush();
    expect(win.events('banner.set')).toContainEqual(
      expect.objectContaining({ bannerKey: 'cli-outdated:claude' }),
    );
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
      // Every one of these ends the run, and none of them finishes the session (discrepancy #111).
      expect(a.sessions.get(id)?.state).toBe('idle');
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
  const png = {
    kind: 'image' as const,
    name: 'shot.png',
    mediaType: 'image/png' as const,
    data: 'iVBORw0KGgo=',
  };
  const userRows = (a: TestApp['app'], id: string) =>
    a.repos.transcripts.last(id).filter((m) => m.payload.kind === 'user');

  it('images go to a stream session as base64 blocks; the transcript row keeps metadata only', async () => {
    const { app: a } = app();
    worktreeDir(a, ids.worktree.featPromo);
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'session', event: 'quiet' }); // idle: sends now rather than queueing
    await a.sessions.sendMessage(session.id, 'what is this?', [png]);
    expect(stream.sent.at(-1)).toEqual({
      id: session.id,
      text: 'what is this?',
      blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } }],
    });
    expect(userRows(a, session.id).at(-1)).toMatchObject({
      body: 'what is this?',
      payload: {
        kind: 'user',
        attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 8 }],
      },
    });
    expect(JSON.stringify(userRows(a, session.id).at(-1))).not.toContain(png.data);
  });

  it('files are read inside the worktree and inlined after the text; an attachment-only message is named after them', async () => {
    const { app: a } = app();
    worktreeDir(a, ids.worktree.featPromo);
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'session', event: 'quiet' }); // idle: sends now rather than queueing
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
    stream.effect(session.id, { type: 'session', event: 'quiet' });
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
    [
      'an attached file over 25 MB',
      'x',
      [
        {
          kind: 'upload' as const,
          name: 'movie.mp4',
          mediaType: 'video/mp4',
          data: Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64'),
        },
      ],
      'invalid-input',
      /movie\.mp4 is larger than 25 MB/,
    ],
    [
      'an attached key file',
      'x',
      [
        {
          kind: 'upload' as const,
          name: 'id_ed25519',
          mediaType: '',
          data: Buffer.from('k').toString('base64'),
        },
      ],
      'invalid-input',
      /id_ed25519 looks like a key or credentials file/,
    ],
    [
      'relative escape',
      'x',
      [{ kind: 'file' as const, path: '../outside/secret.txt' }],
      'fs-denied',
      /outside the worktree/,
    ],
    [
      'absolute path outside',
      'x',
      [{ kind: 'file' as const, path: '/etc/passwd' }],
      'fs-denied',
      /outside the worktree/,
    ],
    [
      'symlink escape',
      'x',
      [{ kind: 'file' as const, path: 'escape.txt' }],
      'fs-denied',
      /outside the worktree/,
    ],
    ['a directory', 'x', [{ kind: 'file' as const, path: 'src' }], 'invalid-input', /not a file/],
    ['a missing file', 'x', [{ kind: 'file' as const, path: 'src/nope.ts' }], 'invalid-input', /not a file/],
  ])('rejects %s and records nothing', async (_label, body, attachments, code, message) => {
    const { app: a } = app();
    worktreeDir(a, ids.worktree.featPromo);
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const before = userRows(a, session.id).length;
    await expect(a.sessions.sendMessage(session.id, body, attachments)).rejects.toMatchObject({
      code,
      message,
    });
    expect(userRows(a, session.id)).toHaveLength(before);
    expect(stream.sent).toEqual([]);
  });

  it('pty sessions get files inlined too; an image is saved in the worktree and named by path instead of dropped', async () => {
    const { app: a } = app();
    const root = worktreeDir(a, ids.worktree.testFlaky);
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    a.sessions.onHook(session.id, 'codex', 'notify', { type: 'agent-turn-complete' }); // idle: sends now
    await a.sessions.sendMessage(session.id, 'look', [png, { kind: 'file', path: 'src/a.ts' }]);
    await typed();
    const typedText = pty.writes.at(-2)?.data ?? '';
    expect(typedText.startsWith('look\n\n<file path="src/a.ts">\nexport const a = 1;\n\n</file>\n\n')).toBe(
      true,
    );
    expect(typedText).toContain('Attached with this message, saved in your worktree');
    const saved = /- (\S+shot\.png) \(image\/png, 8 B\)/.exec(typedText)?.[1] ?? '';
    expect(saved.startsWith(join(root, ATTACHMENTS_DIR, session.id))).toBe(true);
    expect(readFileSync(saved).toString('base64')).toBe(png.data);
    expect(pty.writes.at(-1)).toEqual({ id: session.id, data: '\r' });
    const last = a.repos.transcripts.last(session.id).at(-1)!;
    expect(last.payload).toMatchObject({
      kind: 'user',
      attachments: [
        { kind: 'image', name: 'shot.png' },
        { kind: 'file', path: 'src/a.ts' },
      ],
    });
    // Archiving the session takes what was attached with it.
    a.sessions.close(session.id);
    await vi.waitFor(() => expect(existsSync(join(root, ATTACHMENTS_DIR, session.id))).toBe(false));
  });

  it('any file type reaches a stream session: a PDF is saved in the worktree and named by path; a small text file is inlined', async () => {
    const { app: a } = app();
    const root = worktreeDir(a, ids.worktree.featPromo);
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    const pdf = {
      kind: 'upload' as const,
      name: 'spec.pdf',
      mediaType: 'application/pdf',
      data: Buffer.from('%PDF\u0000').toString('base64'),
    };
    const txt = {
      kind: 'upload' as const,
      name: 'notes.txt',
      mediaType: 'text/plain',
      data: Buffer.from('ship it').toString('base64'),
    };
    await a.sessions.sendMessage(session.id, '', [pdf, txt]);
    const sent = stream.sent.at(-1)!;
    expect(sent.text).toContain('<file path="notes.txt">\nship it\n</file>');
    const pdfPath = /- (\S+spec\.pdf) \(application\/pdf, 5 B\)/.exec(sent.text)?.[1] ?? '';
    expect(pdfPath.startsWith(join(root, ATTACHMENTS_DIR, session.id))).toBe(true);
    expect(readFileSync(pdfPath).toString()).toBe('%PDF\u0000');
    expect(userRows(a, session.id).at(-1)).toMatchObject({
      body: 'spec.pdf, notes.txt',
      payload: {
        kind: 'user',
        attachments: [
          { kind: 'file', name: 'spec.pdf' },
          { kind: 'file', name: 'notes.txt' },
        ],
      },
    });
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
      .filter(
        (d): d is { op: string; table: string; rows: { id: string; slashCommands: string[] }[] } =>
          d.op === 'upsert' && (d as { table?: string }).table === 'sessions',
      );
    expect(upserts.at(-1)?.rows.find((r) => r.id === session.id)?.slashCommands).toEqual([
      'compact',
      'model',
    ]);
    stream.effect(session.id, {
      type: 'init',
      chatId: 'c1',
      model: null,
      permissionMode: null,
      slashCommands: [],
    });
    expect(a.sessions.get(session.id)?.slashCommands).toEqual(['compact', 'model']);
  });
});

describe('background task lifecycle', () => {
  it('persists task identity, publishes it, and releases the runner when its turn finishes', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      purpose: 'learn-deploy',
      taskTargetId: ids.target.vercelPreview,
    });
    expect(a.repos.sessions.get(session.id)).toMatchObject({
      purpose: 'learn-deploy',
      taskTargetId: ids.target.vercelPreview,
    });
    stream.emit('effect', session.id, {
      type: 'transcript',
      body: 'Deployment finished.',
      payload: { kind: 'agent' },
    });
    stream.emit('effect', session.id, { type: 'session', event: 'quiet' });
    expect(a.repos.sessions.get(session.id)).toMatchObject({
      state: 'done',
      exitCode: 0,
      purpose: 'learn-deploy',
    });
    expect(stream.has(session.id)).toBe(false);
    expect(a.repos.transcripts.last(session.id, 10).at(-1)?.body).toBe('Deployment finished.');
  });

  it('keeps an unanswered permission alive and cancels it when the task is stopped', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      purpose: 'debt-audit',
    });
    stream.emit('effect', session.id, {
      type: 'permission',
      requestId: 'task-p',
      toolName: 'Bash',
      input: { command: 'npm test' },
    });
    stream.emit('effect', session.id, { type: 'session', event: 'quiet' });
    expect(a.repos.sessions.get(session.id)?.state).toBe('needs-you');
    expect(stream.has(session.id)).toBe(true);
    a.sessions.stop(session.id);
    expect(a.repos.sessions.get(session.id)).toMatchObject({ state: 'done', exitCode: null });
    expect(a.repos.pendingAsks.openBySession(session.id)).toEqual([]);
    expect(stream.permissions).toContainEqual(expect.objectContaining({ requestId: 'task-p', allow: false }));
  });

  it('preserves failure after the runner exits cleanly in response to being killed', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn({
      ...spawnInput('claude', ids.worktree.featPromo),
      purpose: 'learn-run',
    });
    stream.emit('effect', session.id, { type: 'error', message: 'Authentication failed' });
    stream.emit('effect', session.id, { type: 'session', event: 'quiet' });
    expect(a.repos.sessions.get(session.id)).toMatchObject({
      state: 'done',
      exitCode: 1,
      note: 'Authentication failed',
    });
    expect(stream.has(session.id)).toBe(false);
  });

  it('deduplicates an active task through the command bus', async () => {
    const { app: a } = app();
    const input = { ...spawnInput('claude', ids.worktree.featPromo), purpose: 'debt-audit' };
    const first = await a.bus.dispatch(sender, 'session.spawn', input);
    const second = await a.bus.dispatch(sender, 'session.spawn', input);
    expect(second).toEqual(first);
    expect(stream.spawned).toHaveLength(1);
  });
});

describe('SessionService queue (a message sent mid-turn is never dropped)', () => {
  const userRows = (a: TestApp['app'], id: string) =>
    a.repos.transcripts
      .last(id)
      .filter((m) => m.payload.kind === 'user')
      .map((m) => m.body);
  const systemLines = (a: TestApp['app'], id: string) =>
    a.repos.transcripts
      .last(id)
      .filter((m) => m.payload.kind === 'system')
      .map((m) => m.body);
  const queueDeltas = (win: TestApp['win'], sessionId: string) =>
    win
      .batches()
      .flatMap((b) => b.deltas)
      .filter(
        (d): d is { op: string; sessionId: string; messages: { body: string }[] } => d.op === 'queue.replace',
      )
      .filter((d) => d.sessionId === sessionId)
      .map((d) => d.messages.map((m) => m.body));
  /** The demo Codex CLI moved onto its app-server, so a Codex spawn is a stream session that can steer. */
  const codexAppServer = (a: TestApp['app']) => {
    const cli = a.repos.discovery.cli('codex')!;
    a.repos.discovery.saveCli({ ...cli, capabilities: { ...cli.capabilities, appServer: true } });
  };

  it('delivery: Codex over the app-server steers; Claude, ACP and pty sessions queue', async () => {
    const { app: a } = app();
    const { session: claude } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(a.sessions.deliveryWhileWorking(claude)).toBe('queue');
    const { session: codexTui } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    expect(codexTui.runner).toBe('pty');
    expect(a.sessions.deliveryWhileWorking(codexTui)).toBe('queue');
    expect(a.sessions.deliveryWhileWorking({ agent: 'codex', runner: 'stream' })).toBe('steer');
    expect(a.sessions.deliveryWhileWorking({ agent: 'gemini', runner: 'stream' })).toBe('queue');
  });

  it('working Claude: the message is persisted in the queue and published, with no user row and nothing on stdin', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(a.sessions.get(session.id)?.state).toBe('working');
    await a.sessions.sendMessage(session.id, 'and add tests');
    expect(stream.sent).toEqual([]);
    expect(userRows(a, session.id)).toEqual(['Fix it']);
    const queued = a.repos.queuedMessages.bySession(session.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ sessionId: session.id, body: 'and add tests', createdAt: DEMO_NOW });
    a.publisher.flush();
    expect(queueDeltas(win, session.id)).toEqual([['and add tests']]);
    // The command bus path is the same one.
    await a.bus.dispatch(sender, 'session.sendMessage', { sessionId: session.id, body: 'then lint' });
    expect(a.repos.queuedMessages.bySession(session.id).map((m) => m.body)).toEqual([
      'and add tests',
      'then lint',
    ]);
  });

  it('needs-you (blocked on an ask) queues too; the ask is still answerable and the queue waits for the turn', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    stream.effect(session.id, {
      type: 'permission',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
    });
    expect(a.sessions.get(session.id)?.state).toBe('needs-you');
    await a.sessions.sendMessage(session.id, 'careful with dist');
    expect(stream.sent).toEqual([]);
    expect(a.repos.queuedMessages.bySession(session.id).map((m) => m.body)).toEqual(['careful with dist']);
    const ask = a.repos.pendingAsks.openBySession(session.id)[0]!;
    a.sessions.resolveAsk(ask.id, { kind: 'decision', chosen: 'Allow' });
    expect(a.sessions.get(session.id)?.state).toBe('working');
    // Answering the ask is not the end of the turn: the message is still held.
    expect(a.repos.queuedMessages.bySession(session.id)).toHaveLength(1);
    expect(stream.sent).toEqual([]);
  });

  it('settle: the oldest queued message goes out as the next turn (one per settle) with its user row', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'first');
    await a.sessions.sendMessage(session.id, 'second');
    expect(a.repos.queuedMessages.bySession(session.id)).toHaveLength(2);

    stream.effect(session.id, { type: 'session', event: 'quiet' });
    // idle for a moment, then straight back to working on the held message
    expect(a.sessions.get(session.id)?.state).toBe('working');
    expect(stream.sent).toEqual([{ id: session.id, text: 'first' }]);
    expect(userRows(a, session.id)).toEqual(['Fix it', 'first']);
    expect(a.repos.queuedMessages.bySession(session.id).map((m) => m.body)).toEqual(['second']);
    a.publisher.flush();
    expect(queueDeltas(win, session.id).at(-1)).toEqual(['second']);

    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(stream.sent.map((m) => m.text)).toEqual(['first', 'second']);
    expect(a.repos.queuedMessages.bySession(session.id)).toEqual([]);
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    expect(stream.sent).toHaveLength(2);
  });

  it("a stream session settles on its own end-of-turn only: the Claude Stop hook (same turn) sends nothing more, an interrupted turn's late result sends nothing", async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'one');
    await a.sessions.sendMessage(session.id, 'two');
    // Claude Code fires Stop and then prints `result` for the same turn: one held message goes out, not two.
    a.sessions.onHook(session.id, 'claude', 'Stop', {});
    expect(stream.sent).toEqual([]);
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(stream.sent).toEqual([{ id: session.id, text: 'one' }]);
    expect(a.sessions.get(session.id)?.state).toBe('working');
    a.sessions.onHook(session.id, 'claude', 'Stop', {}); // the next turn's Stop, before its result
    expect(stream.sent).toHaveLength(1);
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(stream.sent.map((m) => m.text)).toEqual(['one', 'two']);
    // The other order — result first, then the hook — sends one as well.
    await a.sessions.sendMessage(session.id, 'three');
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    a.sessions.onHook(session.id, 'claude', 'Stop', {});
    expect(stream.sent.map((m) => m.text)).toEqual(['one', 'two', 'three']);
  });

  it('a pty session settles through the Claude Stop hook / the Codex notify hook', async () => {
    const { app: a } = app();
    const cli = a.repos.discovery.cli('claude')!;
    a.repos.discovery.saveCli({ ...cli, capabilities: {} }); // no stream-json → pty runner
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    expect(session.runner).toBe('pty');
    await a.sessions.sendMessage(session.id, 'after stop');
    expect(pty.writes).toEqual([]);
    a.sessions.onHook(session.id, 'claude', 'Stop', {});
    await typed();
    expect(pty.writes).toEqual([
      { id: session.id, data: 'after stop' },
      { id: session.id, data: '\r' },
    ]);
    pty.writes.length = 0;

    const { session: codex } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    await a.sessions.sendMessage(codex.id, 'after notify');
    expect(pty.writes).toEqual([]); // held, not typed into the TUI mid-turn
    a.sessions.onHook(codex.id, 'codex', 'notify', { type: 'agent-turn-complete' });
    await typed();
    expect(pty.writes).toEqual([
      { id: codex.id, data: 'after notify' },
      { id: codex.id, data: '\r' },
    ]);
    expect(userRows(a, codex.id)).toEqual(['Fix it', 'after notify']);
  });

  it('a pty session without hooks (gemini TUI) drains on its quiet timer', async () => {
    vi.useFakeTimers();
    try {
      const { app: a } = app();
      // Gemini's pty launch writes `.gemini/settings.json` into the worktree: re-point the fixture's literal
      // `~/code/…` path at a temp dir so nothing lands inside the repo.
      const fixture = a.repos.worktrees.get(ids.worktree.featPromo)!;
      a.repos.worktrees.upsert({ ...fixture, path: mkdtempSync(join(tmpdir(), 'styx-gemini-')) });
      const { session } = await a.sessions.spawn(spawnInput('gemini', ids.worktree.featPromo));
      expect(session.runner).toBe('pty');
      pty.data(session.id, 'thinking…');
      await a.sessions.sendMessage(session.id, 'later');
      expect(pty.writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(3100);
      expect(pty.writes[0]).toEqual({ id: session.id, data: 'later' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Codex over the app-server steers: a mid-turn message goes to the runner at once, nothing is queued', async () => {
    const { app: a } = app();
    codexAppServer(a);
    const { session } = await a.sessions.spawn(spawnInput('codex', ids.worktree.testFlaky));
    expect(session.runner).toBe('stream');
    expect(session.state).toBe('working');
    await a.sessions.sendMessage(session.id, 'also check the tests');
    expect(stream.sent).toEqual([{ id: session.id, text: 'also check the tests' }]);
    expect(a.repos.queuedMessages.bySession(session.id)).toEqual([]);
    expect(userRows(a, session.id)).toEqual(['Fix it', 'also check the tests']);
  });

  it('send now: the held message is written to the CLI mid-turn (it buffers it), the user row appears, the queue shrinks', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'one');
    await a.sessions.sendMessage(session.id, 'two');
    const [one, two] = a.repos.queuedMessages.bySession(session.id);
    await a.bus.dispatch(sender, 'session.sendQueued', { sessionId: session.id, messageId: two!.id });
    expect(stream.sent).toEqual([{ id: session.id, text: 'two' }]);
    expect(userRows(a, session.id)).toEqual(['Fix it', 'two']);
    expect(a.repos.queuedMessages.bySession(session.id).map((m) => m.id)).toEqual([one!.id]);
    a.publisher.flush();
    expect(queueDeltas(win, session.id).at(-1)).toEqual(['one']);
    // A message that is not in this session's queue is refused.
    await expect(
      a.bus.dispatch(sender, 'session.sendQueued', { sessionId: ids.session.codex, messageId: one!.id }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('take back: unqueue drops the row and publishes; a stale id is a no-op', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'never mind');
    const m = a.repos.queuedMessages.bySession(session.id)[0]!;
    await a.bus.dispatch(sender, 'session.unqueue', { sessionId: session.id, messageId: m.id });
    expect(a.repos.queuedMessages.bySession(session.id)).toEqual([]);
    a.publisher.flush();
    expect(queueDeltas(win, session.id).at(-1)).toEqual([]);
    a.sessions.unqueue(session.id, m.id); // already gone
    expect(stream.sent).toEqual([]);
    expect(userRows(a, session.id)).toEqual(['Fix it']);
  });

  it('stop returns every held message to the composer: rows removed, a system line, and the bodies on an event', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'alpha');
    await a.sessions.sendMessage(session.id, 'beta');
    a.sessions.interrupt(session.id);
    expect(a.repos.queuedMessages.bySession(session.id)).toEqual([]);
    expect(systemLines(a, session.id)).toEqual([
      '2 queued messages returned to the composer.',
      'interrupted',
    ]);
    a.publisher.flush();
    expect(win.events('queue.returned')).toEqual([{ sessionId: session.id, bodies: ['alpha', 'beta'] }]);
    expect(queueDeltas(win, session.id).at(-1)).toEqual([]);
    // Nothing held went out behind the stop, and the CLI's own end-of-turn after the interrupt sends nothing.
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(stream.sent).toEqual([]);

    // One message: singular copy.
    await a.sessions.sendMessage(session.id, 'gamma'); // idle now: goes straight out
    expect(stream.sent).toEqual([{ id: session.id, text: 'gamma' }]);
    await a.sessions.sendMessage(session.id, 'delta'); // working again: held
    a.sessions.interrupt(session.id);
    expect(systemLines(a, session.id).at(-2)).toBe('1 queued message returned to the composer.');
    expect(win.events('queue.returned').at(-1)).toEqual({ sessionId: session.id, bodies: ['delta'] });
  });

  it('a session that ends with messages held returns them too, so nothing is lost with the process', async () => {
    const { app: a, win } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'orphan');
    a.sessions.stop(session.id);
    expect(a.sessions.get(session.id)?.state).toBe('idle');
    expect(a.repos.queuedMessages.bySession(session.id)).toEqual([]);
    a.publisher.flush();
    expect(win.events('queue.returned')).toEqual([{ sessionId: session.id, bodies: ['orphan'] }]);
  });

  it('a process that is gone relaunches and delivers rather than queueing; what was held goes out on the next settle', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await a.sessions.sendMessage(session.id, 'held');
    stream.live.delete(session.id); // the CLI died without an exit event reaching us; the row still says working
    await a.sessions.sendMessage(session.id, 'wake up');
    expect(stream.spawned).toHaveLength(2);
    expect(stream.sent).toEqual([{ id: session.id, text: 'wake up' }]);
    expect(a.repos.queuedMessages.bySession(session.id).map((m) => m.body)).toEqual(['held']);
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    expect(stream.sent.map((m) => m.text)).toEqual(['wake up', 'held']);
  });

  it('attachments: a held message keeps its files and images as paths; nothing is dropped, and they go out with it', async () => {
    const { app: a } = app();
    // The fixture worktree path is a literal `~/code/…`: re-point it at a temp dir so the test never writes into
    // the repo.
    const fixture = a.repos.worktrees.get(ids.worktree.featPromo)!;
    const root = join(mkdtempSync(join(tmpdir(), 'styx-queue-')), 'wt');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    a.repos.worktrees.upsert({ ...fixture, path: root });
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    const png = {
      kind: 'image' as const,
      name: 'shot.png',
      mediaType: 'image/png' as const,
      data: Buffer.from('png').toString('base64'),
    };
    await a.sessions.sendMessage(session.id, 'review', [{ kind: 'file', path: 'src/a.ts' }, png]);
    const held = a.repos.queuedMessages.bySession(session.id);
    expect(held).toHaveLength(1);
    // Paths, never contents: a held row is persisted and mirrored to the renderer, so the file is read again
    // (confined, fresh) only when the message goes out.
    expect(held[0]!.body).toBe('review');
    expect(held[0]!.files[0]).toBe('src/a.ts');
    expect(held[0]!.files[1]).toMatch(new RegExp(`^${ATTACHMENTS_DIR}/${session.id}/[0-9a-f]+/shot\\.png$`));
    expect(held[0]!.body).not.toContain('export const a = 1;');
    expect(systemLines(a, session.id)).toEqual([]);
    expect(stream.sent).toEqual([]);
    // When it goes out the file is inlined for the CLI, while the transcript row keeps metadata only.
    stream.effect(session.id, { type: 'session', event: 'quiet' });
    // The held message is read from disk and inlined before it goes out; wait for it rather than sleep.
    await vi.waitFor(() => expect(stream.sent.at(-1)?.text ?? '').toContain('<file path="src/a.ts">'));
    expect(stream.sent.at(-1)?.text).toContain('export const a = 1;');
    // The image waited on disk and goes out as an image block after all.
    expect(stream.sent.at(-1)?.blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
    ]);
    const row = a.repos.transcripts.last(session.id).findLast((m) => m.payload.kind === 'user');
    expect(row?.body).toBe('review');
  });

  it('a terminal Claude keeps the conversation its hooks report, so Reopen resumes it', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    a.repos.sessions.upsert({ ...a.sessions.get(session.id)!, cliSessionId: null });
    a.sessions.onHook(session.id, 'claude', 'SessionStart', { session_id: 'pty-conv-1' });
    expect(a.sessions.get(session.id)?.cliSessionId).toBe('pty-conv-1');
    a.sessions.onHook(session.id, 'claude', 'PreToolUse', { session_id: '' });
    expect(a.sessions.get(session.id)?.cliSessionId).toBe('pty-conv-1');
  });

  it('a message to a finished session reopens it and goes out; an empty one is invalid (unchanged by the queue)', async () => {
    const { app: a } = app();
    const { session } = await a.sessions.spawn(spawnInput('claude', ids.worktree.featPromo));
    await expect(a.sessions.sendMessage(session.id, '')).rejects.toMatchObject({ code: 'invalid-input' });
    a.sessions.stop(session.id);
    a.sessions.markDone(session.id);
    a.sessions.archive(session.id);
    // Writing to it picks the thread up again (owner request): out of the archive, relaunched, message delivered.
    await a.sessions.sendMessage(session.id, 'late');
    expect(a.sessions.get(session.id)).toMatchObject({ archivedAt: null });
    expect(a.sessions.get(session.id)?.state).not.toBe('done');
    expect(a.repos.transcripts.last(session.id).map((m) => m.body)).toContain('late');
    expect(stream.spawned).toHaveLength(2);
    expect(stream.sent.at(-1)?.text).toContain('late');
  });
});
