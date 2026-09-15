import type { DevRun, ProjectId } from '@styx/core';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  /** The login shell used to run the command string (`$SHELL -lc`); injectable for tests. */
  shell: () => string;
  platform: NodeJS.Platform;
  /** Does a URL answer? Defaults to an HTTP HEAD with a short timeout; injectable for tests. */
  probe?: (url: string) => Promise<boolean>;
}

/** How often unanswered URL candidates are re-probed, and for how long after the run started. */
export const PROBE_INTERVAL_MS = 1000;
export const PROBE_WINDOW_MS = 120_000;

/**
 * Any HTTP response counts (a 404 or a 405 to HEAD still means a server is listening); a refused connection, a
 * reset or a timeout means nothing is there yet.
 */
export const httpProbe = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'HEAD', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });

export type RunSuggestion = {
  command: string;
  source: 'package.json' | 'makefile' | 'django' | 'cargo' | 'go';
};

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

  async detect(projectId: ProjectId): Promise<RunSuggestion[]> {
    const project = this.deps.repos.projects.get(projectId) ?? fail('not-found', 'project not found');
    return detectRunCommands(project.path);
  }

  async start(projectId: ProjectId, command: string): Promise<{ runId: string; terminalId: string }> {
    const { repos, publisher, clock, pty, terminals } = this.deps;
    const cmd = command.trim();
    if (cmd === '') fail('invalid-input', 'command is empty');
    const project = repos.projects.get(projectId) ?? fail('not-found', 'project not found');
    // One run per project: the previous one goes first, listeners and all, so its exit cannot land on this row.
    this.detach(projectId, { kill: true });

    const runId = `run:${ulid()}`;
    const terminalId = `term:${ulid()}`;
    this.publish({
      projectId,
      runId,
      terminalId,
      command: cmd,
      phase: 'starting',
      url: null,
      exitCode: null,
      startedAt: clock.now(),
      endedAt: null,
    });

    // Listeners go on before the spawn: a process that prints (or dies) immediately must not be missed.
    // Every loopback URL the process prints is a candidate; the first one that actually answers becomes the run's URL.
    // Candidates are probed as they appear and again every second, because a server prints its address before it
    // accepts connections and may print an API or a fallback port that is not it.
    let tail = '';
    const candidates: string[] = [];
    let probeTimer: NodeJS.Timeout | null = null;
    let probing = false;
    let adopted = false;
    const startedAt = clock.now();
    const probe = this.deps.probe ?? httpProbe;
    const current = () => {
      const cur = this.runs.get(projectId);
      return cur !== undefined && cur.runId === runId ? cur : undefined;
    };
    const adopt = (url: string) => {
      const cur = current();
      if (adopted || cur === undefined) return;
      adopted = true;
      stopProbe();
      pty.off('data', onData);
      this.publish({ ...cur, url });
      void this.rememberUrl(projectId, url);
    };
    const runProbe = async () => {
      if (probing || adopted) return;
      probing = true;
      try {
        for (const url of [...candidates]) {
          if (adopted || current() === undefined) return;
          if (await probe(url)) {
            adopt(url);
            return;
          }
        }
      } finally {
        probing = false;
      }
    };
    const schedule = () => {
      if (adopted || probeTimer !== null || candidates.length === 0) return;
      if (clock.now() - startedAt > PROBE_WINDOW_MS) return;
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
      if (id !== terminalId || adopted || current() === undefined) return;
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

    const { file, args } = this.shellArgs(cmd);
    try {
      await terminals.spawnCommand({
        id: terminalId,
        file,
        args,
        cwd: project.path,
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
   * Windows: PowerShell (`-Command`), or the WSL distro's `sh -lc` when `STYX_WIN_SHELL=wsl` — never `cmd.exe`,
   * which re-parses its command line.
   */
  private shellArgs(command: string): { file: string; args: string[] } {
    const shell = this.deps.shell();
    if (this.deps.platform === 'win32') {
      if (/wsl(\.exe)?$/i.test(shell)) return { file: shell, args: ['-e', 'sh', '-lc', command] };
      return { file: shell, args: ['-NoLogo', '-Command', command] };
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
