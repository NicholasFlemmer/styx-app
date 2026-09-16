import { fixtures, type DevRun, type ProjectId } from '@styx/core';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { PtyService } from './pty-service';
import { detectRunCommands, sniffLocalUrl, sniffLocalUrls } from './run-service';

/** In-memory pty: records spawns and lets the test feed output and end the process. */
class FakePty extends PtyService {
  readonly spawned: {
    id: string;
    shell: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  readonly killed: string[] = [];
  private readonly live = new Set<string>();
  constructor() {
    super('darwin');
  }
  override defaultShell(): string {
    return '/bin/zsh';
  }
  override async resolveLoginPath(): Promise<string> {
    return '/usr/local/bin:/usr/bin';
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
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void {
    this.killed.push(id);
    this.exit(id, 0);
  }
  override has(id: string): boolean {
    return this.live.has(id);
  }
  override killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  override killGroup(id: string): void {
    this.kill(id);
  }
  data(id: string, chunk: string): void {
    this.emit('data', id, chunk);
  }
  exit(id: string, code: number): void {
    if (!this.live.has(id)) return;
    this.live.delete(id);
    this.emit('exit', id, code, undefined);
  }
}

const acme = fixtures.ids.project.acmeShop as ProjectId;

const tmp = (files: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'styx-run-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
};

/**
 * Demo app whose acme-shop project lives in a fresh temp folder (so `.styx/project.json` can be written). URL
 * probes answer from `answers` (default: everything answers); unlisted URLs answer true.
 */
const setup = (files: Record<string, string> = {}, answers: Record<string, boolean> = {}) => {
  const pty = new FakePty();
  const probed: string[] = [];
  const t = makeTestApp({
    pty,
    probe: async (url: string) => {
      probed.push(url);
      return answers[url] ?? true;
    },
  });
  const dir = tmp(files);
  const project = t.app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  t.app.repos.projects.upsert({ ...project, path: dir }, t.app.repos.projects.settings(acme));
  return { t, pty, dir, probed };
};

/** Adoption follows an async probe: wait for the row to carry a URL (or not, after a tick). */
const adoptedUrl = async (t: TestApp): Promise<string | null> => {
  await new Promise((res) => setTimeout(res, 5));
  return runRows(t).at(-1)?.url ?? null;
};

const runRows = (t: TestApp): (DevRun | null)[] => {
  t.app.publisher.flush();
  return t.win
    .batches()
    .flatMap((b) => b.deltas)
    .filter((d): d is { op: 'runs.set'; projectId: string; run: DevRun | null } => d.op === 'runs.set')
    .map((d) => d.run);
};
const phases = (t: TestApp) => runRows(t).map((r) => (r === null ? null : r.phase));

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

describe('detectRunCommands', () => {
  const table: { name: string; files: Record<string, string>; expected: string[] }[] = [
    { name: 'nothing recognisable', files: { 'README.md': '' }, expected: [] },
    {
      name: 'package.json dev, no lockfile → npm run',
      files: { 'package.json': pkg({ dev: 'vite' }) },
      expected: ['npm run dev'],
    },
    {
      name: 'pnpm lockfile',
      files: { 'package.json': pkg({ dev: 'vite' }), 'pnpm-lock.yaml': '' },
      expected: ['pnpm dev'],
    },
    {
      name: 'yarn lockfile',
      files: { 'package.json': pkg({ dev: 'vite' }), 'yarn.lock': '' },
      expected: ['yarn dev'],
    },
    {
      name: 'bun lockfile (binary)',
      files: { 'package.json': pkg({ dev: 'vite' }), 'bun.lockb': '' },
      expected: ['bun dev'],
    },
    {
      name: 'bun lockfile (text)',
      files: { 'package.json': pkg({ dev: 'vite' }), 'bun.lock': '' },
      expected: ['bun dev'],
    },
    {
      name: 'dev beats start beats serve',
      files: { 'package.json': pkg({ serve: 'x', start: 'node .', dev: 'vite' }) },
      expected: ['npm run dev'],
    },
    {
      name: 'start when there is no dev',
      files: { 'package.json': pkg({ start: 'node .', serve: 'x' }) },
      expected: ['npm run start'],
    },
    { name: 'serve alone', files: { 'package.json': pkg({ serve: 'x' }) }, expected: ['npm run serve'] },
    {
      name: 'package.json without a run script',
      files: { 'package.json': pkg({ test: 'vitest' }) },
      expected: [],
    },
    { name: 'unparsable package.json is skipped', files: { 'package.json': '{not json' }, expected: [] },
    {
      name: 'Makefile dev target',
      files: { Makefile: 'build:\n\tgo build\n\ndev:\n\tair\n' },
      expected: ['make dev'],
    },
    { name: 'Makefile run target', files: { Makefile: 'run: build\n\t./bin/app\n' }, expected: ['make run'] },
    { name: 'Makefile without a run-ish target', files: { Makefile: 'build:\n\tgo build\n' }, expected: [] },
    { name: 'Django', files: { 'manage.py': '' }, expected: ['python manage.py runserver'] },
    { name: 'Cargo', files: { 'Cargo.toml': '' }, expected: ['cargo run'] },
    { name: 'Go', files: { 'go.mod': '' }, expected: ['go run .'] },
    {
      name: 'everything, in order',
      files: {
        'package.json': pkg({ dev: 'vite' }),
        'pnpm-lock.yaml': '',
        Makefile: 'serve:\n\tx\n',
        'manage.py': '',
        'Cargo.toml': '',
        'go.mod': '',
      },
      expected: ['pnpm dev', 'make serve', 'python manage.py runserver', 'cargo run', 'go run .'],
    },
  ];
  it.each(table)('$name', async ({ files, expected }) => {
    const out = await detectRunCommands(tmp(files));
    expect(out.map((s) => s.command)).toEqual(expected);
  });

  it('names its source', async () => {
    const out = await detectRunCommands(tmp({ 'package.json': pkg({ dev: 'vite' }), 'go.mod': '' }));
    expect(out).toEqual([
      { command: 'npm run dev', source: 'package.json' },
      { command: 'go run .', source: 'go' },
    ]);
  });
});

describe('sniffLocalUrl', () => {
  it.each([
    ['plain', 'Local: http://localhost:3000', 'http://localhost:3000'],
    ['trailing slash kept', '➜  Local:   http://localhost:5173/', 'http://localhost:5173/'],
    [
      'ANSI stripped',
      '\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m',
      'http://localhost:5173/',
    ],
    ['0.0.0.0 becomes localhost', 'listening on http://0.0.0.0:8000', 'http://localhost:8000'],
    ['[::] becomes localhost', 'http://[::]:4000', 'http://localhost:4000'],
    ['[::1] kept', 'http://[::1]:4000/x', 'http://[::1]:4000/x'],
    [
      '127.0.0.1 with a path',
      'Starting development server at http://127.0.0.1:8000/admin',
      'http://127.0.0.1:8000/admin',
    ],
    ['trailing prose stop dropped', 'ready on http://localhost:3000.', 'http://localhost:3000'],
    ['https', 'https://localhost:8443', 'https://localhost:8443'],
    ['stops at a quote', 'url="http://localhost:3000" ok', 'http://localhost:3000'],
    ['remote hosts are not it', 'see https://vitejs.dev/config', null],
    ['nothing', 'compiling...', null],
  ])('%s', (_name, text, expected) => {
    expect(sniffLocalUrl(text)).toBe(expected);
  });
});

describe('RunService', () => {
  it('detect reads the project folder', async () => {
    const { t } = setup({ 'package.json': pkg({ dev: 'next dev' }), 'yarn.lock': '' });
    expect(await t.app.runs.detect(acme)).toEqual([{ command: 'yarn dev', source: 'package.json' }]);
    await expect(t.app.runs.detect('proj:nope' as ProjectId)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('start spawns the command through the login shell in the project folder and publishes starting → running', async () => {
    const { t, pty, dir } = setup();
    const r = await t.app.runs.start(acme, 'pnpm dev');
    expect(r.runId).toMatch(/^run:/);
    expect(r.terminalId).toMatch(/^term:/);
    const spawned = pty.spawned.at(-1);
    expect(spawned).toMatchObject({
      id: r.terminalId,
      shell: '/bin/zsh',
      args: ['-lc', 'pnpm dev'],
      cwd: dir,
    });
    // The shim env user terminals get rides along (the dev server may shell out to `styx`).
    expect(Object.keys(spawned?.env ?? {})).toEqual(expect.arrayContaining(['STYX_SHIM_DIR', 'STYX_BROKER']));
    expect(phases(t)).toEqual(['starting', 'running']);
    const row = runRows(t).at(-1);
    expect(row).toMatchObject({
      projectId: acme,
      runId: r.runId,
      terminalId: r.terminalId,
      command: 'pnpm dev',
      url: null,
      exitCode: null,
      endedAt: null,
      startedAt: t.clock.now(),
    });
    expect(t.app.runs.all()).toEqual([row]);
    expect(t.app.publisher.snapshot().runs).toEqual([row]);
  });

  it('an empty command and an unknown project are refused', async () => {
    const { t } = setup();
    await expect(t.app.runs.start(acme, '   ')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(t.app.runs.start('proj:nope' as ProjectId, 'x')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('adopts the first localhost URL that answers, through ANSI and across split chunks, once', async () => {
    const { t, pty, probed } = setup();
    const r = await t.app.runs.start(acme, 'pnpm dev');
    pty.data(r.terminalId, '\x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://local');
    expect(await adoptedUrl(t)).toBeNull();
    pty.data(r.terminalId, 'host:\x1b[1m5173\x1b[22m/\x1b[39m\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:5173/');
    expect(runRows(t).at(-1)).toMatchObject({ phase: 'running', url: 'http://localhost:5173/' });
    expect(probed).toEqual(['http://localhost:5173/']);
    // A later URL (the network one) does not replace an adopted one, and is not probed.
    pty.data(r.terminalId, '➜  Network: http://localhost:9999/\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:5173/');
    expect(probed).toEqual(['http://localhost:5173/']);
    // Output for some other pty is ignored.
    pty.data('term:other', 'http://localhost:1\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:5173/');
  });

  it('a URL that refuses is skipped: the API a Next app prints first loses to the Local one that answers', async () => {
    const { t, pty, probed } = setup({}, { 'http://localhost:3001': false });
    const r = await t.app.runs.start(acme, 'pnpm dev');
    pty.data(r.terminalId, 'API proxy → http://localhost:3001\n');
    expect(await adoptedUrl(t)).toBeNull();
    pty.data(r.terminalId, '   - Local:        http://localhost:3000\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:3000');
    expect(probed).toEqual(['http://localhost:3001', 'http://localhost:3001', 'http://localhost:3000']);
  });

  it('re-probes on the interval until the server answers', async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const pty = new FakePty();
      const probed: string[] = [];
      const t = makeTestApp({
        pty,
        probe: async (url: string) => {
          probed.push(url);
          return up;
        },
      });
      // The fixture project's path is a literal `~/code/acme-shop`; the run persists dev.url / dev.command into
      // `<path>/.styx/project.json`, so point it at a temp dir (a relative `~` would land inside the repo).
      const project = t.app.repos.projects.get(acme);
      if (!project) throw new Error('fixture project');
      t.app.repos.projects.upsert({ ...project, path: tmp() }, t.app.repos.projects.settings(acme));
      const r = await t.app.runs.start(acme, 'pnpm dev');
      pty.data(r.terminalId, 'Local: http://localhost:3000\n');
      await vi.advanceTimersByTimeAsync(10);
      expect(runRows(t).at(-1)?.url).toBeNull();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(probed.length).toBeGreaterThanOrEqual(3);
      up = true;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(runRows(t).at(-1)?.url).toBe('http://localhost:3000');
      const n = probed.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probed.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sniffLocalUrls lists every loopback URL once, in order, and drops look-alike hosts', () => {
    expect(
      sniffLocalUrls(
        'api http://localhost:3001 and http://localhost@evil.example/ then http://0.0.0.0:3000/ http://localhost:3001',
      ),
    ).toEqual(['http://localhost:3001', 'http://localhost:3000/']);
  });

  it('the URL that answered becomes devUrl, replacing a stale one from an earlier run', async () => {
    const { t, pty, dir } = setup();
    const r = await t.app.runs.start(acme, 'pnpm dev');
    pty.data(r.terminalId, 'ready http://0.0.0.0:3000\n');
    // The save is a `.styx/project.json` write: poll rather than guess at its tick count.
    await vi.waitFor(() => expect(t.app.repos.projects.settings(acme).devUrl).toBe('http://localhost:3000'));
    expect(existsSync(join(dir, '.styx', 'project.json'))).toBe(true);

    // A saved port from last time that nothing listens on is exactly what a fresh run must correct.
    const second = setup({}, { 'http://localhost:3001': false });
    await second.t.app.projects.setSettings(acme, { devUrl: 'http://localhost:3001' });
    const r2 = await second.t.app.runs.start(acme, 'pnpm dev');
    second.pty.data(r2.terminalId, 'ready http://localhost:3000\n');
    expect(await adoptedUrl(second.t)).toBe('http://localhost:3000');
    await vi.waitFor(() =>
      expect(second.t.app.repos.projects.settings(acme).devUrl).toBe('http://localhost:3000'),
    );
  });

  it('the URL Styx already knows wins as soon as it answers, even when the process prints another one first', async () => {
    // Backend + frontend behind one script: the API prints (and listens) first; the agent taught Styx the frontend.
    const { t, pty, probed } = setup();
    await t.app.projects.setSettings(acme, { devUrl: 'http://localhost:5173' });
    const r = await t.app.runs.start(acme, 'pnpm dev');
    pty.data(r.terminalId, 'api listening on http://localhost:4000\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:5173');
    // The known URL was probed without ever being printed.
    expect(probed[0]).toBe('http://localhost:5173');
  });

  it('with nothing known, an API that answers is shown provisionally and replaced by the first page that answers', async () => {
    const page = (url: string) => ({ up: true, page: url.includes('5173') });
    const pty = new FakePty();
    const t = makeTestApp({ pty, probe: async (url: string) => page(url) });
    const project = t.app.repos.projects.get(acme);
    if (!project) throw new Error('fixture project');
    t.app.repos.projects.upsert({ ...project, path: tmp() }, t.app.repos.projects.settings(acme));
    const r = await t.app.runs.start(acme, 'pnpm dev');
    pty.data(r.terminalId, 'api listening on http://localhost:4000\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:4000');
    // Provisional: nothing saved yet, and the search is still on.
    expect(t.app.repos.projects.settings(acme).devUrl).toBeUndefined();
    pty.data(r.terminalId, '  Local: http://localhost:5173/\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:5173/');
    await vi.waitFor(() => expect(t.app.repos.projects.settings(acme).devUrl).toBe('http://localhost:5173/'));
    // Adopted for good: a later URL changes nothing.
    pty.data(r.terminalId, 'also http://localhost:9999\n');
    expect(await adoptedUrl(t)).toBe('http://localhost:5173/');
  });

  it('persists the command as devCommand when it differs from the saved one', async () => {
    const { t } = setup();
    expect(t.app.repos.projects.settings(acme).devCommand).toBeUndefined();
    await t.app.runs.start(acme, 'pnpm dev');
    expect(t.app.repos.projects.settings(acme).devCommand).toBe('pnpm dev');
    t.app.publisher.flush();
    const settingsDeltas = t.win
      .batches()
      .flatMap((b) => b.deltas)
      .filter((d) => d.op === 'settings.set');
    expect(settingsDeltas.length).toBeGreaterThan(0);
    await t.app.runs.start(acme, 'pnpm dev');
    expect(t.app.repos.projects.settings(acme).devCommand).toBe('pnpm dev');
    await t.app.runs.start(acme, 'make dev');
    expect(t.app.repos.projects.settings(acme).devCommand).toBe('make dev');
  });

  it('exit publishes exited with the code; stop kills the process and the exit handler reports it', async () => {
    const { t, pty } = setup();
    const r = await t.app.runs.start(acme, 'pnpm dev');
    t.clock.advance(5_000);
    pty.exit(r.terminalId, 3);
    expect(runRows(t).at(-1)).toMatchObject({ phase: 'exited', exitCode: 3, endedAt: t.clock.now() });
    // Output after exit changes nothing.
    pty.data(r.terminalId, 'http://localhost:1\n');
    expect(await adoptedUrl(t)).toBeNull();
    // Stopping an exited run is a no-op.
    t.app.runs.stop(acme);
    expect(pty.killed).toEqual([]);

    const second = setup();
    const r2 = await second.t.app.runs.start(acme, 'pnpm dev');
    second.t.app.runs.stop(acme);
    expect(second.pty.killed).toEqual([r2.terminalId]);
    expect(phases(second.t)).toEqual(['starting', 'running', 'exited']);
    expect(runRows(second.t).at(-1)?.exitCode).toBe(0);
  });

  it('a command that dies before start returns still ends up exited, not running', async () => {
    const pty = new FakePty();
    const original = pty.spawn.bind(pty);
    pty.spawn = async (opts) => {
      const out = await original(opts);
      pty.exit(opts.id, 127);
      return out;
    };
    const t = makeTestApp({ pty });
    const project = t.app.repos.projects.get(acme);
    if (!project) throw new Error('fixture project');
    t.app.repos.projects.upsert({ ...project, path: tmp() }, t.app.repos.projects.settings(acme));
    await t.app.runs.start(acme, 'nope');
    expect(phases(t)).toEqual(['starting', 'exited']);
    expect(runRows(t).at(-1)?.exitCode).toBe(127);
  });

  it('a failed spawn drops the row and fails the command', async () => {
    const pty = new FakePty();
    pty.spawn = async () => {
      throw new Error('posix_spawn failed');
    };
    const t = makeTestApp({ pty });
    const project = t.app.repos.projects.get(acme);
    if (!project) throw new Error('fixture project');
    t.app.repos.projects.upsert({ ...project, path: tmp() }, t.app.repos.projects.settings(acme));
    await expect(t.app.runs.start(acme, 'pnpm dev')).rejects.toMatchObject({ code: 'internal' });
    expect(phases(t)).toEqual(['starting', null]);
    expect(t.app.runs.all()).toEqual([]);
  });

  it('starting again replaces the run: the old process is killed and its exit cannot touch the new row', async () => {
    const { t, pty } = setup();
    const r1 = await t.app.runs.start(acme, 'pnpm dev');
    const r2 = await t.app.runs.start(acme, 'pnpm dev --port 4000');
    expect(pty.killed).toEqual([r1.terminalId]);
    const row = runRows(t).at(-1);
    expect(row).toMatchObject({ runId: r2.runId, phase: 'running', command: 'pnpm dev --port 4000' });
    expect(t.app.runs.all()).toHaveLength(1);
    // The first pty's data / exit are for a run that no longer exists.
    pty.data(r1.terminalId, 'http://localhost:1\n');
    expect(runRows(t).at(-1)?.url).toBeNull();
  });

  it('dismiss clears an exited run; a live one is stopped first', async () => {
    const { t, pty } = setup();
    const r = await t.app.runs.start(acme, 'pnpm dev');
    pty.exit(r.terminalId, 0);
    t.app.runs.dismiss(acme);
    expect(runRows(t).at(-1)).toBeNull();
    expect(t.app.runs.all()).toEqual([]);
    t.app.runs.dismiss(acme); // nothing to clear

    const second = setup();
    const r2 = await second.t.app.runs.start(acme, 'pnpm dev');
    second.t.app.runs.dismiss(acme);
    expect(second.pty.killed).toEqual([r2.terminalId]);
    expect(runRows(second.t).at(-1)).toBeNull();
    expect(second.t.app.runs.all()).toEqual([]);
  });

  it('stopAll kills every live run (shutdown)', async () => {
    const { t, pty } = setup();
    const r = await t.app.runs.start(acme, 'pnpm dev');
    t.app.runs.stopAll();
    expect(pty.killed).toEqual([r.terminalId]);
  });

  it('windows: PowerShell gets -Command, WSL gets sh -lc', async () => {
    const { RunService } = await import('./run-service');
    const calls: { file: string; args: string[] }[] = [];
    const fake = {
      repos: { projects: { get: () => ({ path: '/p', name: 'p' }), settings: () => ({ devCommand: 'x' }) } },
      publisher: { runsSet: () => undefined },
      clock: { now: () => 1 },
      terminals: {
        spawnCommand: async (c: { file: string; args: string[] }) => {
          calls.push({ file: c.file, args: c.args });
          return 'term:x';
        },
        shimEnv: () => ({}),
      },
      pty: { on: () => undefined, off: () => undefined, kill: () => undefined },
      projects: { setSettings: async () => undefined },
    };
    const ps = new RunService({
      ...(fake as unknown as ConstructorParameters<typeof RunService>[0]),
      shell: () => 'powershell.exe',
      platform: 'win32',
    });
    await ps.start(acme, 'npm run dev');
    expect(calls.at(-1)).toEqual({ file: 'powershell.exe', args: ['-NoLogo', '-Command', 'npm run dev'] });
    const wsl = new RunService({
      ...(fake as unknown as ConstructorParameters<typeof RunService>[0]),
      shell: () => 'wsl.exe',
      platform: 'win32',
    });
    await wsl.start(acme, 'npm run dev');
    expect(calls.at(-1)).toEqual({ file: 'wsl.exe', args: ['-e', 'sh', '-lc', 'npm run dev'] });
  });
});
