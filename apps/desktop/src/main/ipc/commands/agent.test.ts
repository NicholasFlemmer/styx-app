import { commandResultSchema } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { PtyService } from '../../services/pty-service';
import { makeTestApp } from '../../test-support';

/** In-memory pty: records spawns, lets the test end the login command. */
class FakePty extends PtyService {
  readonly spawned: { id: string; shell: string; args: string[]; cwd: string }[] = [];
  private readonly live = new Set<string>();
  constructor() {
    super('darwin');
  }
  override async resolveLoginPath(): Promise<string> {
    return '/usr/local/bin:/usr/bin';
  }
  override async spawn(opts: { id: string; cwd: string; shell?: string; args?: string[] }) {
    this.spawned.push({ id: opts.id, shell: opts.shell ?? '', args: opts.args ?? [], cwd: opts.cwd });
    this.live.add(opts.id);
    return { pid: 4242 };
  }
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void {
    this.exit(id, 0);
  }
  override has(id: string): boolean {
    return this.live.has(id);
  }
  override killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  exit(id: string, code: number): void {
    this.live.delete(id);
    this.emit('exit', id, code, undefined);
  }
}

const CODEX_STATUS = 'Logged in using ChatGPT\n';

function setup() {
  const pty = new FakePty();
  const exec = vi.fn(async (bin: string, args: string[]) => {
    if (bin.endsWith('/codex') && args.join(' ') === 'login status')
      return { stdout: CODEX_STATUS, exitCode: 0 };
    if (bin.endsWith('/claude')) return { stdout: '{"loggedIn":false}', exitCode: 0 };
    return { stdout: '', exitCode: 1 };
  });
  const openExternal = vi.fn(async (_url: string) => undefined);
  return { ...makeTestApp({ pty, exec, openExternal }), pty, exec, openExternal };
}

describe('agent.* (agent connections)', () => {
  it('agent.verify runs the CLI status command and returns the persisted row (validated output)', async () => {
    const { app, sender, exec, clock, win } = setup();
    const r = await app.bus.dispatch(sender, 'agent.verify', { agent: 'claude' });
    expect(commandResultSchema('agent.verify').safeParse(r).success).toBe(true);
    expect(r).toMatchObject({
      ok: true,
      value: { cli: { agent: 'claude', authState: 'signed-out', account: null, verifiedAt: clock.now() } },
    });
    expect(exec).toHaveBeenCalledWith('/opt/homebrew/bin/claude', ['auth', 'status', '--json']);
    expect(app.repos.discovery.cli('claude')).toMatchObject({
      authState: 'signed-out',
      verifiedAt: clock.now(),
    });
    app.publisher.flush();
    const set = win
      .batches()
      .flatMap((b) => b.deltas)
      .find((d) => d.op === 'discovery.set') as
      { clis: { agent: string; account: string | null }[] } | undefined;
    expect(set?.clis.find((c) => c.agent === 'claude')?.account).toBeNull();
    // Shell needs nothing; the handler still answers with a valid row.
    const shell = await app.bus.dispatch(sender, 'agent.verify', { agent: 'shell' });
    expect(commandResultSchema('agent.verify').safeParse(shell).success).toBe(true);
    expect(shell).toMatchObject({ ok: true, value: { cli: { agent: 'shell', authState: 'n/a' } } });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('agent.login spawns the sign-in in a term: pty, reports over agent.login, and re-verifies on exit', async () => {
    const { app, sender, pty, win, exec } = setup();
    const r = await app.bus.dispatch(sender, 'agent.login', { agent: 'codex' });
    expect(commandResultSchema('agent.login').safeParse(r).success).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    const { terminalId, command } = r.value;
    expect(command).toBe('codex login');
    expect(app.terminals.isTerminal(terminalId)).toBe(true);
    expect(pty.spawned).toEqual([
      { id: terminalId, shell: '/opt/homebrew/bin/codex', args: ['login'], cwd: expect.any(String) },
    ]);
    expect(win.events('agent.login')).toEqual([{ terminalId, agent: 'codex', status: 'running' }]);
    pty.exit(terminalId, 0);
    expect(win.events('agent.login').at(-1)).toEqual({
      terminalId,
      agent: 'codex',
      status: 'exited',
      exitCode: 0,
    });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('/opt/homebrew/bin/codex', ['login', 'status']));
    await vi.waitFor(() =>
      expect(app.repos.discovery.cli('codex')).toMatchObject({ authState: 'signed-in', account: 'ChatGPT' }),
    );
    expect(await app.bus.dispatch(sender, 'agent.login', { agent: 'shell' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(pty.spawned).toHaveLength(1);
  });

  it('agent.installGuide opens the docs page; shell has none; inputs are validated', async () => {
    const { app, sender, openExternal } = setup();
    const r = await app.bus.dispatch(sender, 'agent.installGuide', { agent: 'gemini' });
    expect(commandResultSchema('agent.installGuide').safeParse(r).success).toBe(true);
    expect(r).toEqual({ ok: true, value: {} });
    expect(openExternal).toHaveBeenCalledWith('https://github.com/google-gemini/gemini-cli');
    expect(await app.bus.dispatch(sender, 'agent.installGuide', { agent: 'shell' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(await app.bus.dispatch(sender, 'agent.verify', { agent: 'vim' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
  });
});
