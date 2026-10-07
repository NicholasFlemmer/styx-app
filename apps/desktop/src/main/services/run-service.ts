import type { DevPlatform, DevRun, Project, ProjectId, Worktree } from '@styx/core';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import { logger, redactArgv } from './logger';
import type { ProjectService } from './project-service';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

export interface RunServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  terminals: TerminalService;
  pty: PtyService;
  projects: ProjectService;
  /**
   * The login shell used to run the command string (`$SHELL -lc`; on Windows the project's Shell (Windows) setting);
   * injectable for tests.
   */
  shell: (projectId: ProjectId) => string;
  platform: NodeJS.Platform;
  /**
   * Does a URL answer, and with a page? Defaults to an HTTP GET with a short timeout; injectable for tests (a
   * plain boolean means "answers, kind unknown").
   */
  probe?: (url: string) => Promise<boolean | ProbeAnswer>;
}

/** What a probe learned: nothing listening, or a server that does / does not serve HTML (null = could not tell). */
export type ProbeAnswer = { up: false } | { up: true; page: boolean | null };
const toAnswer = (r: boolean | ProbeAnswer): ProbeAnswer =>
  typeof r === 'boolean' ? { up: r, page: null } : r;

/** How often unanswered URL candidates are re-probed, and for how long after the run started. */
export const PROBE_INTERVAL_MS = 1000;
export const PROBE_WINDOW_MS = 120_000;

/**
 * Any HTTP response counts (a 404 or a 405 to HEAD still means a server is listening); a refused connection, a
 * reset or a timeout means nothing is there yet.
 */
export const httpProbe = (url: string): Promise<ProbeAnswer> =>
  new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ up: false });
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    // GET, not HEAD: the content type says whether this is the page a person opens (a frontend) or an API that
    // happens to listen first (a backend). The body is discarded.
    const req = mod.request(u, { method: 'GET', timeout: 1500 }, (res) => {
      const type = String(res.headers['content-type'] ?? '');
      res.resume();
      resolve({ up: true, page: type === '' ? null : /text\/html/i.test(type) });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false });
    });
    req.on('error', () => resolve({ up: false }));
    req.end();
  });

export type RunSuggestion = {
  command: string;
  source:
    | 'package.json'
    | 'makefile'
    | 'django'
    | 'cargo'
    | 'go'
    | 'expo'
    | 'react-native'
    | 'flutter'
    | 'xcode'
    | 'gradle';
  platform?: DevPlatform;
};

/** An Xcode project / workspace name that may be spliced into a suggested command line. */
const XCODE_NAME = /^[\w .+-]+\.(xcworkspace|xcodeproj)$/;

/** What `run.detect` learned about the folder: commands to try and the platforms the app can run on. */
export type RunDetection = { suggestions: RunSuggestion[]; platforms: DevPlatform[] };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** The first URL a dev server prints for itself: `http://localhost:5173/`, `http://127.0.0.1:8000`, `http://0.0.0.0:3000`. */
const LOCAL_URL = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?[^\s"'<>)]*/;
const LOCAL_URLS = new RegExp(LOCAL_URL.source, 'g');
/** How much recent output is kept for the URL match (a URL split across pty chunks still matches). */
const TAIL = 4096;

/**
 * Finds the dev server's own URL in a chunk of terminal output. ANSI colour is stripped first (Vite and Next
 * both colour theirs), `0.0.0.0` / `[::]` become `localhost` because that is what a browser can open, and a
 * trailing full stop or comma from prose ("listening on http://localhost:3000.") is dropped.
 */
export const sniffLocalUrl = (text: string): string | null => sniffLocalUrls(text)[0] ?? null;

/**
 * Every loopback URL in a chunk of output, in order of appearance and de-duplicated. A dev server often prints
 * more than one (`Local:` plus an API it proxies to, or the port it *wanted* before falling back), so the run
 * probes them and adopts the first that answers rather than trusting the first one printed.
 */
export const sniffLocalUrls = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.replace(ANSI, '').matchAll(LOCAL_URLS)) {
    const candidate = m[0]
      .replace('0.0.0.0', 'localhost')
      .replace('[::]', 'localhost')
      .replace(/[.,;]+$/, '');
    // The prefix match is not enough: `http://localhost@evil.example/` and `http://localhost.evil.example/` both
    // start the same way. Only a real loopback host with no userinfo may become the design window's URL.
    if (isLoopbackUrl(candidate) && !out.includes(candidate)) out.push(candidate);
  }
  return out;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopbackUrl = (text: string): boolean => {
  try {
    const u = new URL(text);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      u.username === '' &&
      u.password === '' &&
      LOOPBACK_HOSTS.has(u.hostname)
    );
  } catch {
    return false;
  }
};

/**
 * Is this a mobile app, and on which platforms? Expo (`app.json` / `app.config.*` with an `expo` dependency),
 * bare React Native (`react-native` dependency with `ios/` or `android/`), Flutter (`pubspec.yaml`), an Xcode
 * project / workspace, a Gradle Android project. A web `dev` script alongside keeps `web` in the list.
 */
export async function detectPlatforms(
  dir: string,
): Promise<{ platforms: DevPlatform[]; suggestions: RunSuggestion[] }> {
  const has = (file: string) => existsSync(join(dir, file));
  const platforms: DevPlatform[] = [];
  const suggestions: RunSuggestion[] = [];
  const add = (p: DevPlatform) => {
    if (!platforms.includes(p)) platforms.push(p);
  };
  let deps: Record<string, unknown> = {};
  let scripts: Record<string, unknown> = {};
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        scripts?: Record<string, unknown>;
      };
      deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      scripts = pkg.scripts ?? {};
    } catch {
      /* unparsable package.json */
    }
  }
  const expo = 'expo' in deps && (has('app.json') || has('app.config.js') || has('app.config.ts'));
  const reactNative = !expo && 'react-native' in deps && (has('ios') || has('android'));
  if (expo) {
    add('ios');
    add('android');
    suggestions.push({ command: 'npx expo run:ios', source: 'expo', platform: 'ios' });
    suggestions.push({ command: 'npx expo run:android', source: 'expo', platform: 'android' });
    if ('react-native-web' in deps || typeof scripts['web'] === 'string') add('web');
  } else if (reactNative) {
    if (has('ios')) {
      add('ios');
      suggestions.push({ command: 'npx react-native run-ios', source: 'react-native', platform: 'ios' });
    }
    if (has('android')) {
      add('android');
      suggestions.push({
        command: 'npx react-native run-android',
        source: 'react-native',
        platform: 'android',
      });
    }
  }
  if (has('pubspec.yaml')) {
    add('ios');
    add('android');
    suggestions.push({ command: 'flutter run -d iphone', source: 'flutter', platform: 'ios' });
    suggestions.push({ command: 'flutter run -d android', source: 'flutter', platform: 'android' });
    if (has('web')) add('web');
  }
  if (!expo && !reactNative && !has('pubspec.yaml')) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      /* unreadable folder */
    }
    // The name goes into a suggested shell line: plain names only, and quoted (a cloned repo names its folders).
    const xcode =
      entries.find((e) => XCODE_NAME.test(e) && /\.xcworkspace$/.test(e)) ??
      entries.find((e) => XCODE_NAME.test(e) && /\.xcodeproj$/.test(e));
    if (xcode !== undefined) {
      add('ios');
      const flag = /\.xcworkspace$/.test(xcode) ? '-workspace' : '-project';
      suggestions.push({
        command: `xcodebuild ${flag} '${xcode}' -scheme <scheme> -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build`,
        source: 'xcode',
        platform: 'ios',
      });
    }
    if (
      has('settings.gradle') ||
      has('settings.gradle.kts') ||
      has('build.gradle') ||
      has('build.gradle.kts')
    ) {
      add('android');
      suggestions.push({ command: './gradlew installDebug', source: 'gradle', platform: 'android' });
    }
  }
  if (platforms.length === 0 || ['dev', 'start', 'serve'].some((s) => typeof scripts[s] === 'string'))
    add('web');
  // A plain web app lists web first; a mobile app lists its device platforms first (the button's default).
  return { platforms, suggestions };
}

/**
 * Suggests run commands from what is in the folder, most specific first: `package.json` scripts (`dev` > `start` >
 * `serve`) through the package manager the lockfile names, a `Makefile` target, Django's `manage.py`, Cargo, Go.
 */
export async function detectRunCommands(dir: string): Promise<RunSuggestion[]> {
  const has = (file: string) => existsSync(join(dir, file));
  const out: RunSuggestion[] = [];
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      const scripts = pkg.scripts ?? {};
      const script = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string');
      if (script !== undefined) {
        const pm = has('pnpm-lock.yaml')
          ? 'pnpm'
          : has('yarn.lock')
            ? 'yarn'
            : has('bun.lockb') || has('bun.lock')
              ? 'bun'
              : 'npm';
        out.push({ command: pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`, source: 'package.json' });
      }
    } catch {
      /* unparsable package.json: no suggestion from it */
    }
  }
  if (has('Makefile')) {
    const text = await readFile(join(dir, 'Makefile'), 'utf8').catch(() => '');
    const target = ['dev', 'run', 'serve'].find((t) => new RegExp(`^${t}\\s*:`, 'm').test(text));
    if (target !== undefined) out.push({ command: `make ${target}`, source: 'makefile' });
  }
  if (has('manage.py')) out.push({ command: 'python manage.py runserver', source: 'django' });
  if (has('Cargo.toml')) out.push({ command: 'cargo run', source: 'cargo' });
  if (has('go.mod')) out.push({ command: 'go run .', source: 'go' });
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.command) ? false : (seen.add(s.command), true)));
}

/** The part of DeviceService a run needs: boot (and mirror) the device a platform run targets. */
export interface DeviceLauncher {
  boot(
    projectId: ProjectId,
    platform: Exclude<DevPlatform, 'web'>,
    device: string | null,
  ): Promise<{ deviceId: string; deviceName: string }>;
}

interface Attached {
  runId: string;
  terminalId: string;
  /** Removes the pty listeners and stops probing: called before the row is replaced or dropped so an old exit cannot clobber a new run. */
  off: () => void;
}

/**
 * "Run locally": one dev-server process per project, started in the project folder, whose first localhost URL
 * feeds the design window (owner request: the URL used to have to be typed in by hand).
 *
 * Main owns the pty, so the run survives the design tab being closed; the renderer attaches an xterm by
 * `terminalId` like any other terminal. The row lives only in memory (`model.runs`, one per project) — a run does
 * not outlive the app, so nothing about it is persisted except the command the user chose (`devCommand`) and the
 * URL it printed (`devUrl`, only when the project had none).
 */
export class RunService {
  private readonly runs = new Map<string, DevRun>();
  private readonly attached = new Map<string, Attached>();

  constructor(private readonly deps: RunServiceDeps) {}

  /** Rows for the snapshot. */
  all(): DevRun[] {
    return [...this.runs.values()];
  }

  /** The simulator / emulator side of a device run (set once by the container; tests may leave it out). */
  bindDevices(devices: DeviceLauncher): void {
    this.devices = devices;
  }
  private devices: DeviceLauncher | null = null;

  /**
   * Where Run locally looks and runs (discrepancy #103): the lane the design window is looking at — its files as
   * they are, committed or not, which is what the person sees in the editor — else the main checkout. A lane of
   * another project is refused; an archived one, or one whose folder is gone, falls back to main.
   */
  private laneOf(project: Project, worktreeId: string | undefined): Worktree | null {
    if (worktreeId === undefined) return null;
    const wt = this.deps.repos.worktrees.get(worktreeId);
    if (wt === null || wt.projectId !== project.id) fail('invalid-input', 'that lane is not in this project');
    return wt.archivedAt === null && !wt.isMain && existsSync(wt.path) ? wt : null;
  }

  async detect(projectId: ProjectId, worktreeId?: string): Promise<RunDetection> {
    const project = this.deps.repos.projects.get(projectId) ?? fail('not-found', 'project not found');
    const dir = this.laneOf(project, worktreeId)?.path ?? project.path;
    const [web, mobile] = await Promise.all([detectRunCommands(dir), detectPlatforms(dir)]);
    // Device suggestions first for a mobile app, web ones first otherwise, in the platforms' order.
    const suggestions =
      mobile.platforms[0] === 'web' ? [...web, ...mobile.suggestions] : [...mobile.suggestions, ...web];
    return { suggestions, platforms: mobile.platforms };
  }

  async start(
    projectId: ProjectId,
    command: string,
    opts: { platform?: DevPlatform; worktreeId?: string } = {},
  ): Promise<{ runId: string; terminalId: string }> {
    const { repos, publisher, clock, pty, terminals } = this.deps;
    const cmd = command.trim();
    if (cmd === '') fail('invalid-input', 'command is empty');
    const project = repos.projects.get(projectId) ?? fail('not-found', 'project not found');
    const lane = this.laneOf(project, opts.worktreeId);
    const cwd = lane?.path ?? project.path;
    const settings = repos.projects.settings(projectId);
    const platform: DevPlatform = opts.platform ?? settings.devPlatform ?? 'web';
    // One run per project: the previous one goes first, listeners and all, so its exit cannot land on this row.
    this.detach(projectId, { kill: true });

    // A device run boots the simulator / emulator first so the design window can mirror it while the app builds;
    // a boot that fails is the run's failure (nothing to show the app on).
    if (platform !== 'web') {
      if (this.devices === null) fail('cli-missing', 'no simulator support in this build');
      await this.devices.boot(projectId, platform, settings.devDevice ?? null);
    }

    const runId = `run:${ulid()}`;
    const terminalId = `term:${ulid()}`;
    this.publish({
      projectId,
      worktreeId: lane?.id ?? null,
      runId,
      terminalId,
      command: cmd,
      platform,
      phase: 'starting',
      url: null,
      exitCode: null,
      startedAt: clock.now(),
      endedAt: null,
    });

    // Listeners go on before the spawn: a process that prints (or dies) immediately must not be missed.
    //
    // Which URL is "the app" (a project with a backend and a frontend prints both, and the API usually listens
    // first): the URL Styx already knows (taught by the agent or typed by the user) wins as soon as it answers;
    // otherwise the first candidate that answers *with a page* wins; a candidate that answers with something else
    // (an API) is shown provisionally while the search goes on, and is replaced the moment a page answers within
    // the probe window. Candidates are probed as they appear and again every second, because a server prints its
    // address before it accepts connections.
    // A device run's output URLs are Metro's / the dev client's, not a page: nothing is adopted or saved.
    let tail = '';
    const known = platform === 'web' ? (settings.devUrl ?? null) : null;
    const candidates: string[] = known !== null && isLoopbackUrl(known) ? [known] : [];
    let probeTimer: NodeJS.Timeout | null = null;
    let probing = false;
    let adopted = false;
    let provisional: string | null = null;
    const startedAt = clock.now();
    const probe = this.deps.probe ?? httpProbe;
    const current = () => {
      const cur = this.runs.get(projectId);
      return cur !== undefined && cur.runId === runId ? cur : undefined;
    };
    const adopt = (url: string, final: boolean) => {
      const cur = current();
      if (adopted || cur === undefined) return;
      if (cur.url !== url) this.publish({ ...cur, url });
      if (!final) {
        provisional = url;
        return;
      }
      adopted = true;
      stopProbe();
      pty.off('data', onData);
      void this.rememberUrl(projectId, url);
    };
    const runProbe = async () => {
      if (probing || adopted) return;
      probing = true;
      try {
        for (const url of [...candidates]) {
          if (adopted || current() === undefined) return;
          const answer = toAnswer(await probe(url));
          if (!answer.up) continue;
          if (url === known || answer.page !== false) {
            adopt(url, true);
            return;
          }
          if (provisional === null) adopt(url, false);
        }
      } finally {
        probing = false;
      }
    };
    const schedule = () => {
      if (adopted || probeTimer !== null || candidates.length === 0) return;
      if (clock.now() - startedAt > PROBE_WINDOW_MS) {
        // Nothing better turned up: what is showing is the app after all.
        if (provisional !== null) adopt(provisional, true);
        return;
      }
      probeTimer = setTimeout(() => {
        probeTimer = null;
        void runProbe().then(schedule);
      }, PROBE_INTERVAL_MS);
      probeTimer.unref?.();
    };
    const stopProbe = () => {
      if (probeTimer !== null) clearTimeout(probeTimer);
      probeTimer = null;
    };
    const onData = (id: string, data: string) => {
      if (id !== terminalId || adopted || platform !== 'web' || current() === undefined) return;
      tail = (tail + data).slice(-TAIL);
      let fresh = false;
      for (const url of sniffLocalUrls(tail)) {
        if (candidates.includes(url)) continue;
        candidates.push(url);
        fresh = true;
      }
      if (fresh) void runProbe().then(schedule);
    };
    const onExit = (id: string, exitCode: number) => {
      if (id !== terminalId) return;
      off();
      this.attached.delete(projectId);
      const cur = this.runs.get(projectId);
      if (cur === undefined || cur.runId !== runId) return;
      this.publish({ ...cur, phase: 'exited', exitCode, endedAt: clock.now() });
      logger.info('run: exited', { project: project.name, command: cmd, exitCode });
    };
    const off = () => {
      stopProbe();
      pty.off('data', onData);
      pty.off('exit', onExit);
    };
    pty.on('data', onData);
    pty.on('exit', onExit);
    this.attached.set(projectId, { runId, terminalId, off });
    // A known URL is probed from the start, whether or not the process ever prints it.
    if (candidates.length > 0) schedule();

    const { file, args } = this.shellArgs(cmd, projectId);
    try {
      await terminals.spawnCommand({
        id: terminalId,
        file,
        args,
        cwd,
        env: terminals.shimEnv(),
      });
    } catch (e) {
      off();
      this.attached.delete(projectId);
      this.runs.delete(projectId);
      publisher.runsSet(projectId, null);
      fail('internal', `could not start ${cmd}: ${(e as Error).message}`);
    }
    const cur = this.runs.get(projectId);
    // The exit handler may already have run (a command that fails at once); only a still-starting row moves on.
    if (cur !== undefined && cur.runId === runId && cur.phase === 'starting')
      this.publish({ ...cur, phase: 'running' });
    logger.info('run: started', { project: project.name, command: redactArgv(cmd.split(/\s+/)).join(' ') });
    await this.rememberCommand(projectId, cmd);
    await this.rememberPlatform(projectId, platform);
    return { runId, terminalId };
  }

  /** Kills the process group (shell, package manager, server); the exit handler publishes `exited` with the code. */
  stop(projectId: ProjectId): void {
    const run = this.runs.get(projectId);
    if (run === undefined || run.phase === 'exited') return;
    this.deps.pty.killGroup(run.terminalId);
  }

  /** Clears the row (the output strip closes). A live run is stopped first. */
  dismiss(projectId: ProjectId): void {
    if (!this.runs.has(projectId)) return;
    this.detach(projectId, { kill: true });
    this.runs.delete(projectId);
    this.deps.publisher.runsSet(projectId, null);
  }

  /** Kills every run (app shutdown). */
  stopAll(): void {
    for (const run of this.runs.values()) if (run.phase !== 'exited') this.deps.pty.killGroup(run.terminalId);
  }

  private publish(run: DevRun): void {
    this.runs.set(run.projectId, run);
    this.deps.publisher.runsSet(run.projectId, run);
  }

  /** Drops the pty listeners of the project's current run and, when asked, kills its process if still alive. */
  private detach(projectId: string, opts: { kill: boolean }): void {
    const a = this.attached.get(projectId);
    if (a === undefined) return;
    a.off();
    this.attached.delete(projectId);
    const run = this.runs.get(projectId);
    if (opts.kill && run !== undefined && run.phase !== 'exited') this.deps.pty.killGroup(a.terminalId);
  }

  /**
   * The command string goes through the user's login shell so `pnpm dev` resolves like it would in their terminal.
   * Windows: PowerShell (`-Command`), or the WSL distro's `sh -lc` when the project's Shell (Windows) is WSL (or
   * `STYX_WIN_SHELL=wsl`) — never `cmd.exe`, which re-parses its command line.
   */
  private shellArgs(command: string, projectId: ProjectId): { file: string; args: string[] } {
    const shell = this.deps.shell(projectId);
    if (this.deps.platform === 'win32') {
      if (/wsl(\.exe)?$/i.test(shell)) return { file: shell, args: ['-e', 'sh', '-lc', command] };
      // Process-scoped Bypass: npm/pnpm/yarn's .ps1 shims are blocked by Windows' default policy otherwise.
      return { file: shell, args: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', command] };
    }
    return { file: shell, args: ['-lc', command] };
  }

  /**
   * Saves the command to `.styx/project.json` (`dev.command`) so the next run starts with it. That file is committed,
   * so a command carrying something that looks like a secret (`API_KEY=… pnpm dev`) is run but never written.
   */
  private async rememberCommand(projectId: ProjectId, command: string): Promise<void> {
    const saved = this.deps.repos.projects.settings(projectId).devCommand ?? null;
    if (saved === command) return;
    if (redactArgv(command.split(/\s+/)).join(' ') !== command) {
      logger.warn('run: devCommand not saved, it carries a secret-looking value');
      return;
    }
    await this.deps.projects
      .setSettings(projectId, { devCommand: command })
      .catch((e: Error) => logger.warn('run: could not save devCommand', { error: e.message }));
  }

  /** The platform the user last ran on, so the next Run locally (and the button's label) start there. */
  private async rememberPlatform(projectId: ProjectId, platform: DevPlatform): Promise<void> {
    const saved = this.deps.repos.projects.settings(projectId).devPlatform ?? 'web';
    if (saved === platform) return;
    await this.deps.projects
      .setSettings(projectId, { devPlatform: platform === 'web' ? null : platform })
      .catch((e: Error) => logger.warn('run: could not save devPlatform', { error: e.message }));
  }

  /**
   * The design window points at the URL the server actually answered on. It replaces whatever was saved: a run is
   * the source of truth while it is alive, and a stale port from last time is exactly what "run it yourself" cannot fix.
   */
  private async rememberUrl(projectId: ProjectId, url: string): Promise<void> {
    const saved = this.deps.repos.projects.settings(projectId).devUrl ?? null;
    if (saved === url) return;
    await this.deps.projects
      .setSettings(projectId, { devUrl: url })
      .catch((e: Error) => logger.warn('run: could not save devUrl', { error: e.message }));
  }
}
