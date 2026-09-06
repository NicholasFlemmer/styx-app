import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_LABEL,
  copy,
  fill,
  headAsk,
  newId,
  repoHasGit,
  openAskCount,
  sessionTransition,
  type Agent,
  type AskId,
  type CliInstall,
  type PendingAsk,
  type Project,
  type Runner,
  type Session,
  type SessionEffect,
  type SessionEvent,
  type SessionId,
  type SessionToggles,
  type Worktree,
  type WorktreeId,
} from '@styx/core';
import { buildAgentLaunch, type AgentLaunch, type AgentLaunchContext } from '../agents';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import { projectSettingsFor } from '../store/projection';
import type { Publisher } from '../store/publisher';
import { toCliInstall, versionSatisfies, type DetectService } from './detect-service';
import type { GitService } from './git';
import { worktreeLocation } from './git';
import { isPolicyFile } from './hunk-service';
import { logger, redact } from './logger';
import type { NotificationService } from './notification-service';
import type { PtyLog } from './pty-log';
import type { PtyService } from './pty-service';
import type { ActivityService } from './activity-service';
import type { StreamEffect, StreamRunnerLike } from './stream-runner';
import type { TranscriptService } from './transcript-service';

export const QUIET_MS = 3000;

/** Hook payloads (`styx hook <agent>` → broker `hook`) are untyped JSON from the CLI. */
export type HookAgent = 'claude' | 'codex' | 'gemini' | 'cursor' | 'shell';

export interface SessionServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  pty: PtyService;
  stream: StreamRunnerLike;
  ptyLog: PtyLog;
  git: GitService;
  detect: DetectService;
  transcript: TranscriptService;
  activity: ActivityService;
  notifications: NotificationService | null;
  /**
   * Re-run CLI detection before every spawn / relaunch and on window focus so the launch uses the binary that is on
   * the machine now (`claude update` mid-session). Off for fixture profiles and most tests, whose rows are fake.
   */
  redetectClis?: boolean;
  /** Broker endpoint + paths injected into every agent pty (plan §6). */
  runtime: {
    brokerEndpoint: string;
    shimDir: string;
    cliPath: string;
    exePath: string;
    userData: string;
    platform: NodeJS.Platform;
  };
}

/** Late-bound collaborators (GrantService, HunkService and the broker host depend on SessionService in turn). */
export interface SessionHooks {
  revokeSessionGrants: (sessionId: SessionId) => void;
  /** Reject a broker request that was held on an ask which is now cancelled. */
  cancelHeldAsk: (ask: PendingAsk) => void;
  /** Hunk watcher lifecycle for agent worktrees. */
  watchWorktree: (session: Session, worktree: Worktree) => void;
  unwatchWorktree: (worktreeId: WorktreeId) => void;
  /** `PostToolUse Edit|Write` and stream tool results re-diff the worktree. */
  rescanHunks: (sessionId: SessionId) => void;
}

export interface SpawnInput {
  projectId: string;
  agent: Agent;
  worktree: { kind: 'new'; base: string; branch: string } | { kind: 'existing'; worktreeId: string };
  firstMessage: string;
  toggles: SessionToggles;
  model: string | null;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const PERMISSION_OPTIONS = ['Allow', 'Deny'] as const;

/** `cli.binary.<agent>` in app_settings: a path picked with "Locate binary"; wins over detection while the file exists. */
export const CLI_BINARY_KEY_PREFIX = 'cli.binary.';
export const cliBinaryKey = (agent: string): string => `${CLI_BINARY_KEY_PREFIX}${agent}`;

const OUTDATED_NEED =
  /does not support this model;?\s*version\s+(\d+\.\d+(?:\.\d+)?)\s+or newer is required/i;
const OUTDATED_HAVE = /Claude Code\s+(\d+\.\d+(?:\.\d+)?)/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const PTY_TAIL = 2000;

/**
 * Claude Code's "API Error: 400 Claude Code 2.1.199 does not support this model; version 2.1.251 or newer is required"
 * (stream `result`/`assistant` text or pty output): the CLI runs but its default model needs a newer release.
 */
export function parseCliOutdated(text: string): { have: string | null; need: string } | null {
  const need = OUTDATED_NEED.exec(text)?.[1];
  if (need === undefined) return null;
  return { have: OUTDATED_HAVE.exec(text)?.[1] ?? null, need };
}

/**
 * ADR-0010: Claude Code streams when its CLI advertises stream-json (print-only, so that implies `-p`); cursor-agent
 * additionally needs `--print` in its help. Everything else (codex, gemini, shell) is a TUI in xterm.
 */
export function runnerFor(agent: Agent, cli: Pick<CliInstall, 'capabilities'> | null): Runner {
  const caps = cli?.capabilities ?? {};
  if (agent === 'claude' && caps['streamJson'] === true) return 'stream';
  if (agent === 'cursor' && caps['streamJson'] === true && caps['printMode'] === true) return 'stream';
  return 'pty';
}

/**
 * Owns session rows, their processes (pty or stream runner), and the session state machine (core
 * `machines/session`): every transition is write DB → effects → `store.delta`.
 */
export class SessionService {
  private hooks: SessionHooks | null = null;
  private readonly quietTimers = new Map<string, NodeJS.Timeout>();
  private readonly launches = new Map<string, AgentLaunch>();
  /** Asks opened from a CLI hook (`permission_prompt` / `agent_needs_input`), cancelled once the agent moves on. */
  private readonly hookAsks = new Map<string, AskId>();
  /** Stream `can_use_tool` requests waiting on a decision ask: askId → request id. */
  private readonly permissionAsks = new Map<string, { sessionId: string; requestId: string }>();
  /** Last ANSI-stripped output per pty session, scanned for the CLI-outdated message across chunk boundaries. */
  private readonly ptyTails = new Map<string, string>();
  /** When the outdated banner was last raised per session (the error arrives as assistant text and as a result). */
  private readonly outdatedAt = new Map<string, number>();

  constructor(private readonly deps: SessionServiceDeps) {
    deps.pty.on('data', (id, data) => this.onPtyData(id, data));
    deps.pty.on('exit', (id, exitCode) => this.onPtyExit(id, exitCode));
    deps.stream.on('effect', (id, effect) => this.onStreamEffect(id, effect));
    deps.stream.on('exit', (id, exitCode) => this.onStreamExit(id, exitCode));
  }

  bind(hooks: SessionHooks): void {
    this.hooks = hooks;
  }

  get(id: string): Session | null {
    return this.deps.repos.sessions.get(id);
  }

  require(id: string): Session {
    return this.deps.repos.sessions.get(id) ?? fail('not-found', `session ${id} not found`);
  }

  /** True while a pty or stream process is attached. */
  isRunning(id: string): boolean {
    return this.deps.pty.has(id) || this.deps.stream.has(id);
  }

  // --- spawn ---------------------------------------------------------------

  async spawn(input: SpawnInput): Promise<{ session: Session; worktree: Worktree; token: string }> {
    const { repos, clock } = this.deps;
    const project =
      repos.projects.get(input.projectId) ?? fail('not-found', `project ${input.projectId} not found`);
    const repo =
      repos.repos.byProject(project.id) ?? fail('not-found', `project ${project.name} has no repo`);
    const settings = projectSettingsFor(repos, project.id);
    const now = clock.now();
    const sessionId = newId<'SessionId'>();

    let worktree: Worktree;
    if (input.worktree.kind === 'existing') {
      worktree =
        repos.worktrees.get(input.worktree.worktreeId) ??
        fail('not-found', `worktree ${input.worktree.worktreeId} not found`);
    } else if (!repoHasGit(repo)) {
      // Plain folder: no worktree isolation exists; sessions run in the folder itself (the spawn modal offers only that).
      fail('git-error', `${project.name} is not a git repository: agents work in the folder itself`);
    } else {
      const branch = input.worktree.branch;
      const path =
        settings.worktreeLocation.value === 'inside'
          ? join(project.path, '.styx', 'worktrees', branch.replace(/[^A-Za-z0-9._-]+/g, '-'))
          : worktreeLocation(project.path, branch);
      await this.deps.git.worktreeAdd(project.path, { branch, base: input.worktree.base, path });
      const head = await this.deps.git.headCommit(path);
      worktree = {
        id: newId<'WorktreeId'>(),
        repoId: repo.id,
        projectId: project.id,
        branch,
        path,
        isMain: false,
        owner: { kind: 'session', sessionId },
        baseCommit: head,
        headCommit: head,
        changes: { added: 0, removed: 0, files: 0 },
        pr: null,
        conflict: null,
        mergedAt: null,
        createdAt: now,
        archivedAt: null,
      };
    }

    const token = randomBytes(32).toString('hex');
    const session: Session = {
      id: sessionId,
      projectId: project.id,
      worktreeId: worktree.id,
      agent: input.agent,
      runner: runnerFor(input.agent, repos.discovery.cli(input.agent)),
      model: input.model,
      state: 'idle',
      pausedReason: null,
      note: null,
      firstMessage: input.firstMessage || null,
      toggles: input.toggles,
      pid: null,
      exitCode: null,
      startedAt: now,
      lastActivityAt: null,
      endedAt: null,
      archivedAt: null,
    };
    repos.transaction(() => {
      repos.sessions.upsert(session);
      repos.sessions.setBrokerTokenHash(session.id, sha256(token));
      const previousOwner =
        worktree.owner.kind === 'session' ? repos.sessions.get(worktree.owner.sessionId) : null;
      const reassign =
        input.worktree.kind === 'new' ||
        worktree.owner.kind === 'user' ||
        previousOwner === null ||
        previousOwner.state === 'done';
      if (reassign) {
        worktree = {
          ...worktree,
          owner: worktree.isMain ? worktree.owner : { kind: 'session', sessionId },
          baseCommit: worktree.baseCommit ?? worktree.headCommit,
        };
        repos.worktrees.upsert(worktree);
      }
      repos.projects.upsert({ ...project, lastActivityAt: now }, repos.projects.settings(project.id));
    });
    this.deps.publisher.upsert('sessions', [session.id]);
    this.deps.publisher.upsert('worktrees', [worktree.id]);
    this.deps.publisher.upsert('projects', [project.id]);
    if (input.firstMessage) this.deps.transcript.user(session.id, input.firstMessage);
    this.deps.activity.append({
      who: AGENT_LABEL[session.agent],
      what:
        worktree.branch === null
          ? `${project.name} · spawned in folder`
          : `${project.name} · spawned on ${worktree.branch}`,
      projectId: project.id,
      sessionId: session.id,
    });

    await this.launch(session, worktree, project, token);
    this.hooks?.watchWorktree(this.require(session.id), worktree);
    return { session: this.require(session.id), worktree, token };
  }

  private async launch(
    session: Session,
    worktree: Worktree,
    project: Project,
    token: string,
    opts: { replayFirstMessage: boolean } = { replayFirstMessage: true },
  ): Promise<void> {
    const { repos, runtime } = this.deps;
    if (this.deps.redetectClis === true && session.agent !== 'shell') await this.refreshClis();
    const cli = repos.discovery.cli(session.agent);
    // A relaunch (process gone, user sent another message) replays nothing: the CLI starts clean at the next turn.
    const firstMessage = opts.replayFirstMessage ? session.firstMessage : null;
    const binary = session.agent === 'shell' ? this.deps.pty.defaultShell() : (cli?.binary ?? null);
    if (session.agent !== 'shell' && (binary === null || cli?.found === false)) {
      this.applyEvent(session.id, { type: 'error', reason: 'cli-missing' });
      return;
    }
    const runner = runnerFor(session.agent, cli);
    if (runner !== session.runner) {
      repos.sessions.upsert({ ...session, runner });
      this.deps.publisher.upsert('sessions', [session.id]);
      session = this.require(session.id);
    }
    const env: Record<string, string> = {
      STYX_SESSION_ID: session.id,
      STYX_BROKER: runtime.brokerEndpoint,
      STYX_TOKEN: token,
      STYX_PROJECT_ID: project.id,
      STYX_WORKTREE: worktree.path,
      STYX_SHIM_DIR: runtime.shimDir,
      STYX_CLI: runtime.cliPath,
      STYX_EXE: runtime.exePath,
      MCP_TIMEOUT: '60000',
      PATH: `${runtime.shimDir}${runtime.platform === 'win32' ? ';' : ':'}${await this.deps.pty.resolveLoginPath()}`,
    };
    const ctx: AgentLaunchContext = {
      agent: session.agent,
      binary: binary ?? '',
      sessionId: session.id,
      worktreePath: worktree.path,
      firstMessage,
      model: session.model,
      runner,
      autoApproveEdits: session.toggles.autoApproveEdits,
      configDir: join(runtime.userData, 'agents', session.id),
      shimDir: runtime.shimDir,
      platform: runtime.platform,
      env,
    };
    const launch = await buildAgentLaunch(ctx);
    this.launches.set(session.id, launch);
    try {
      let pid: number;
      if (launch.stream) {
        const r = await this.deps.stream.spawn({
          id: session.id,
          command: launch.command,
          args: launch.args,
          cwd: worktree.path,
          env: { ...env, ...launch.env },
          input: launch.stream,
          worktreePath: worktree.path,
          firstMessage,
        });
        pid = r.pid;
        if (firstMessage) this.render(session.id, `> ${firstMessage}\r\n`);
      } else {
        const r = await this.deps.pty.spawn({
          id: session.id,
          cwd: worktree.path,
          shell: launch.command,
          args: launch.args,
          env: { ...env, ...launch.env },
        });
        pid = r.pid;
      }
      const s = this.require(session.id);
      repos.sessions.upsert({ ...s, pid });
      this.deps.publisher.upsert('sessions', [s.id]);
      this.applyEvent(session.id, { type: 'start' });
      if (!launch.stream && launch.typeFirstMessage && firstMessage) {
        setTimeout(() => this.deps.pty.write(session.id, `${firstMessage}\r`), 400).unref?.();
      }
    } catch (e) {
      logger.error('session spawn failed', { sessionId: session.id, error: (e as Error).message });
      this.launches.delete(session.id);
      void launch.cleanup().catch(() => undefined);
      this.applyEvent(session.id, { type: 'error', reason: 'cli-missing' });
    }
  }

  // --- input / control -----------------------------------------------------

  /**
   * Delivers a user turn. When the runner process is gone (the CLI exited on an API error, say) the CLI is relaunched
   * first — fresh spawn with the currently detected binary, same session and worktree, nothing replayed — and the
   * message goes to the new process; a failed relaunch pauses the session with `cli-missing` and its banner.
   */
  async sendMessage(sessionId: string, body: string): Promise<void> {
    const s = this.require(sessionId);
    if (s.state === 'done') fail('invalid-transition', 'session has finished');
    this.deps.transcript.user(s.id, body);
    if (!this.isRunning(s.id) && s.state !== 'paused') {
      const ok = await this.relaunch(s);
      if (!ok) return;
    }
    if (this.deps.stream.has(s.id)) {
      this.deps.stream.send(s.id, body);
      this.render(s.id, `> ${body}\r\n`);
    } else if (this.deps.pty.has(s.id)) this.deps.pty.write(s.id, `${body}\r`);
    this.applyEvent(s.id, { type: 'activity' });
  }

  /** Spawns the CLI again for a live session whose process is gone (replays nothing). True when a process is attached. */
  private async relaunch(s: Session): Promise<boolean> {
    const { repos } = this.deps;
    const worktree = repos.worktrees.get(s.worktreeId) ?? fail('not-found', 'worktree missing');
    const project = repos.projects.get(s.projectId) ?? fail('not-found', 'project missing');
    const token = randomBytes(32).toString('hex');
    repos.sessions.setBrokerTokenHash(s.id, sha256(token));
    // Never started (paused at launch) → the first message is still owed; otherwise the transcript already has it.
    await this.launch(this.require(s.id), worktree, project, token, {
      replayFirstMessage: s.lastActivityAt === null,
    });
    if (!this.isRunning(s.id)) return false;
    this.hooks?.watchWorktree(this.require(s.id), worktree);
    return true;
  }

  /** Raw bytes from the terminal pane. Stream sessions have no TTY, so typed input is ignored there. */
  ptyInput(sessionId: string, data: string): void {
    if (this.deps.stream.has(sessionId)) return;
    this.deps.pty.write(sessionId, data);
  }

  ptyResize(sessionId: string, cols: number, rows: number): void {
    this.deps.pty.resize(sessionId, cols, rows);
  }

  stop(sessionId: string): void {
    const s = this.require(sessionId);
    if (this.deps.stream.has(s.id)) {
      this.deps.stream.kill(s.id);
      return; // `finish` follows from the stream exit event
    }
    if (this.deps.pty.has(s.id)) {
      this.deps.pty.kill(s.id);
      return; // `finish` follows from the pty exit event
    }
    if (s.state !== 'done') this.applyEvent(s.id, { type: 'finish', exitCode: null });
  }

  archive(sessionId: string): void {
    const s = this.require(sessionId);
    if (s.state !== 'done') fail('invalid-transition', 'only finished sessions can be archived');
    this.deps.repos.sessions.upsert({ ...s, archivedAt: this.deps.clock.now() });
    this.deps.publisher.upsert('sessions', [s.id]);
  }

  /**
   * Leaves `paused` once its reason is gone: cli-missing → re-detect and respawn; conflict → the worktree merges
   * cleanly again; auth-expired → no expired target remains in the project. The process is relaunched when none is
   * attached any more.
   */
  async resume(sessionId: string): Promise<void> {
    const s = this.require(sessionId);
    if (s.state !== 'paused') fail('invalid-transition', 'session is not paused');
    const { repos } = this.deps;
    const worktree = repos.worktrees.get(s.worktreeId) ?? fail('not-found', 'worktree missing');
    const project = repos.projects.get(s.projectId) ?? fail('not-found', 'project missing');

    if (s.pausedReason === 'cli-missing') {
      await this.refreshClis();
      const cli = repos.discovery.cli(s.agent);
      if (s.agent !== 'shell' && !cli?.found)
        fail('cli-missing', fill(copy.errors.spawnCliMissing, { cli: s.agent }));
    } else if (s.pausedReason === 'conflict') {
      const repo = repos.repos.byProject(project.id);
      const conflict =
        worktree.branch === null
          ? null
          : await this.deps.git
              .detectConflict(project.path, worktree.branch, repo?.defaultBranch ?? 'main')
              .catch(() => worktree.conflict);
      if (conflict) {
        if ((conflict.file ?? null) !== (worktree.conflict?.file ?? null)) {
          repos.worktrees.upsert({ ...worktree, conflict });
          this.deps.publisher.upsert('worktrees', [worktree.id]);
        }
        fail(
          'git-error',
          fill(copy.errors.conflict.text, {
            branch: worktree.branch ?? '',
            file: conflict.file,
            agent: AGENT_LABEL[s.agent],
          }),
        );
      }
      if (worktree.conflict !== null) {
        repos.worktrees.upsert({ ...worktree, conflict: null });
        this.deps.publisher.upsert('worktrees', [worktree.id]);
      }
    } else if (s.pausedReason === 'auth-expired') {
      const expired = repos.targets.byProject(project.id).find((t) => t.health === 'expired');
      if (expired) fail('provider-error', `${expired.name} ${expired.env} is still expired`);
    }

    this.applyEvent(s.id, { type: 'resolve' });
    if (!this.isRunning(s.id)) await this.relaunch(this.require(s.id));
  }

  /**
   * Re-detects every agent CLI (PATH, IDE extension bundles, manual picks) and persists the rows; `discovery.set` goes
   * out only when something other than `checkedAt` changed. A `cli-outdated:<agent>` banner clears once the detected
   * version satisfies the release the CLI asked for. Cheap after the first run: DetectService caches per binary.
   */
  async refreshClis(): Promise<CliInstall[]> {
    const { repos, publisher } = this.deps;
    const overrides: Partial<Record<Exclude<Agent, 'shell'>, string>> = {};
    for (const agent of ['claude', 'codex', 'gemini', 'cursor'] as const) {
      const picked = repos.settings.kv.get<string>(cliBinaryKey(agent));
      if (picked === undefined) continue;
      if (existsSync(picked)) overrides[agent] = picked;
      else repos.settings.kv.delete(cliBinaryKey(agent)); // a vanished pick is forgotten so detection is honest again
    }
    const found = await this.deps.detect.detectClis(overrides);
    const now = this.deps.clock.now();
    const before = repos.discovery.clis();
    const clis = found.map((c) => toCliInstall(c, now));
    repos.discovery.replaceClis(clis);
    const strip = (list: CliInstall[]) => JSON.stringify(list.map(({ checkedAt: _c, ...rest }) => rest));
    if (strip(before) !== strip(clis)) publisher.discoverySet(repos.discovery.ides(), clis);
    for (const c of clis) this.clearOutdatedBanner(c);
    return clis;
  }

  /** `cli-outdated:<agent>` goes away once the detected version is at least the one the CLI demanded (`meta`). */
  private clearOutdatedBanner(cli: CliInstall): void {
    const { repos, publisher } = this.deps;
    const key = `cli-outdated:${cli.agent}`;
    const n = repos.notifications.byBannerKey(key);
    if (!n || n.state === 'resolved') return;
    if (!cli.found || n.meta === null || !versionSatisfies(cli.version, n.meta)) return;
    repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: this.deps.clock.now() });
    publisher.upsert('notifications', [n.id]);
    publisher.sendEvent('banner.clear', { bannerKey: key });
  }

  /**
   * The CLI reported that its default model needs a newer release: a persistent `cli-outdated:<agent>` banner (the
   * session itself stays where the machine put it) and a `system` line in the chat with the CLI's own message.
   */
  private raiseOutdatedBanner(
    session: Session,
    message: string,
    info: { have: string | null; need: string },
  ): void {
    const { repos, publisher, clock } = this.deps;
    if (session.agent !== 'claude') return; // the copy names Claude Code; no other CLI emits this message
    const now = clock.now();
    const last = this.outdatedAt.get(session.id);
    if (last !== undefined && now - last < 5000) return;
    this.outdatedAt.set(session.id, now);
    const version = info.have ?? repos.discovery.cli(session.agent)?.version ?? '';
    const text = fill(copy.errors.cliOutdated.text, { version }).replace(/\s{2,}/g, ' ');
    const bannerKey = `cli-outdated:${session.agent}`;
    const existing = repos.notifications.byBannerKey(bannerKey);
    const id = existing?.id ?? `banner-${bannerKey}`;
    repos.notifications.upsert({
      id,
      kind: 'error-banner',
      sessionId: session.id,
      askId: null,
      projectId: session.projectId,
      title: text,
      body: '',
      meta: info.need,
      osDelivered: false,
      state: 'shown',
      bannerKey,
      createdAt: existing?.createdAt ?? now,
      resolvedAt: null,
    });
    publisher.upsert('notifications', [id]);
    publisher.sendEvent('banner.set', {
      bannerKey,
      kind: 'cli-outdated',
      text,
      cta: copy.errors.cliOutdated.cta,
      action: { kind: 'install-guide', agent: session.agent },
      sessionId: session.id,
      reason: null,
    });
    const line =
      message
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim() ?? message;
    this.deps.transcript.system(session.id, redact(line.length > 300 ? `${line.slice(0, 299)}…` : line));
  }

  /** Kill every live process (shutdown). */
  killAll(): void {
    for (const t of this.quietTimers.values()) clearTimeout(t);
    this.quietTimers.clear();
    this.deps.stream.killAll();
    this.deps.pty.killAll();
    this.deps.ptyLog.closeAll();
  }

  // --- pty events ----------------------------------------------------------

  /** Text for the session's terminal pane (and its log). */
  private render(id: string, text: string): void {
    this.deps.publisher.pty(id, text);
    this.deps.ptyLog.write(id, text);
  }

  private onPtyData(id: string, data: string): void {
    this.deps.publisher.pty(id, data);
    const s = this.deps.repos.sessions.get(id);
    if (!s) return; // user terminals share the pty service
    this.deps.ptyLog.write(id, data);
    const tail = `${this.ptyTails.get(id) ?? ''}${data.replace(ANSI, '')}`.slice(-PTY_TAIL);
    const outdated = parseCliOutdated(tail);
    if (outdated !== null)
      this.raiseOutdatedBanner(s, tail.slice(Math.max(0, tail.search(OUTDATED_HAVE))), outdated);
    this.ptyTails.set(id, outdated === null ? tail : '');
    this.applyEvent(id, { type: 'activity' });
    const prev = this.quietTimers.get(id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.quietTimers.delete(id);
      this.applyEvent(id, { type: 'quiet' });
    }, QUIET_MS);
    t.unref?.();
    this.quietTimers.set(id, t);
  }

  private onPtyExit(id: string, exitCode: number): void {
    this.deps.publisher.ptyExit(id, exitCode);
    const s = this.deps.repos.sessions.get(id);
    if (!s) return;
    this.deps.ptyLog.close(id);
    this.onProcessExit(s, exitCode);
  }

  private onProcessExit(s: Session, exitCode: number | null): void {
    this.ptyTails.delete(s.id);
    const launch = this.launches.get(s.id);
    if (launch) {
      void launch.cleanup().catch(() => undefined);
      this.launches.delete(s.id);
    }
    if (s.state === 'done') {
      // A SessionEnd hook already finished it; keep the real exit code.
      if (s.exitCode === null && exitCode !== null) {
        this.deps.repos.sessions.upsert({ ...s, exitCode });
        this.deps.publisher.upsert('sessions', [s.id]);
      }
      return;
    }
    this.applyEvent(s.id, { type: 'finish', exitCode });
  }

  // --- stream events -------------------------------------------------------

  private onStreamEffect(id: string, effect: StreamEffect): void {
    const s = this.deps.repos.sessions.get(id);
    if (!s) return;
    switch (effect.type) {
      case 'init':
        return;
      case 'render':
        this.render(id, effect.text);
        return;
      case 'transcript': {
        this.deps.transcript.append(s.id, effect.body, effect.payload);
        const outdated = effect.payload.kind === 'agent' ? parseCliOutdated(effect.body) : null;
        if (outdated !== null) this.raiseOutdatedBanner(s, effect.body, outdated);
        return;
      }
      case 'note':
        this.setNote(s.id, effect.note);
        return;
      case 'session':
        this.applyEvent(s.id, { type: effect.event });
        return;
      case 'rescan':
        this.hooks?.rescanHunks(s.id);
        return;
      case 'error': {
        const outdated = parseCliOutdated(effect.message);
        if (outdated !== null) this.raiseOutdatedBanner(s, effect.message, outdated);
        else this.deps.transcript.system(s.id, redact(`error: ${effect.message}`));
        return;
      }
      case 'permission':
        this.onPermissionRequest(s, effect.requestId, effect.toolName, effect.input);
        return;
    }
  }

  private onStreamExit(id: string, exitCode: number | null): void {
    this.render(id, `— exited${exitCode !== null ? ` (${exitCode})` : ''}\r\n`);
    this.deps.publisher.ptyExit(id, exitCode);
    const s = this.deps.repos.sessions.get(id);
    if (!s) return;
    this.deps.ptyLog.close(id);
    this.onProcessExit(s, exitCode);
  }

  /** `can_use_tool` from the stream: edits pass when the toggle says so, everything else is an Allow/Deny decision. */
  private onPermissionRequest(
    s: Session,
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const editPath =
      typeof input['file_path'] === 'string'
        ? input['file_path']
        : typeof input['notebook_path'] === 'string'
          ? input['notebook_path']
          : '';
    // Edits to `.styx/project.json` (grant policy) are never auto-approved, whatever the toggle says (H-1).
    if (s.toggles.autoApproveEdits && EDIT_TOOL.test(toolName) && !isPolicyFile(editPath)) {
      this.deps.stream.respondPermission(s.id, requestId, true);
      return;
    }
    const hint =
      typeof input['command'] === 'string'
        ? input['command']
        : typeof input['file_path'] === 'string'
          ? input['file_path']
          : '';
    const prompt = `${toolName}${hint ? `: ${hint.split('\n')[0]?.slice(0, 160) ?? ''}` : ''}`;
    const ask = this.openAsk(s.id, { kind: 'decision', prompt, options: [...PERMISSION_OPTIONS] }, null);
    this.permissionAsks.set(ask.id, { sessionId: s.id, requestId });
  }

  // --- CLI hooks (`styx hook <agent>`) --------------------------------------

  /**
   * Maps agent lifecycle hooks onto the session machine (plan §5). Claude Code: SessionStart/UserPromptSubmit/
   * PreToolUse/PostToolUse → activity (PostToolUse Edit|Write also rescans hunks); Stop → quiet; SessionEnd → finish
   * (reason `clear` only ends the turn); Notification permission_prompt|agent_needs_input → a `question` ask
   * (needs-you) unless one is already open; idle_prompt|agent_completed → quiet. Codex `notify`
   * agent-turn-complete → quiet + rescan. Anything else: stop/end/idle/complete → quiet, otherwise activity.
   */
  onHook(sessionId: string, agent: HookAgent, event: string, payload: unknown): void {
    const s = this.deps.repos.sessions.get(sessionId);
    if (!s) return;
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    if (agent === 'claude') {
      switch (event) {
        case 'SessionStart':
        case 'UserPromptSubmit':
        case 'PreToolUse':
          this.agentMovedOn(s);
          this.applyEvent(s.id, { type: 'activity' });
          return;
        case 'PostToolUse': {
          this.agentMovedOn(s);
          this.applyEvent(s.id, { type: 'activity' });
          if (EDIT_TOOL.test(String(p['tool_name'] ?? ''))) this.hooks?.rescanHunks(s.id);
          return;
        }
        case 'Stop':
          this.agentMovedOn(s);
          this.hooks?.rescanHunks(s.id);
          this.applyEvent(s.id, { type: 'quiet' });
          return;
        case 'SubagentStop':
          this.applyEvent(s.id, { type: 'activity' });
          return;
        case 'SessionEnd':
          this.agentMovedOn(s);
          if (p['reason'] === 'clear') this.applyEvent(s.id, { type: 'quiet' });
          else this.applyEvent(s.id, { type: 'finish', exitCode: null });
          return;
        case 'Notification': {
          const message = typeof p['message'] === 'string' ? p['message'] : null;
          const kind = String(p['notification_type'] ?? '');
          if (message) this.setNote(s.id, message);
          if (kind === 'permission_prompt' || kind === 'agent_needs_input') {
            this.openHookAsk(
              s,
              message ?? (kind === 'permission_prompt' ? 'Permission requested' : 'Input requested'),
            );
            return;
          }
          this.applyEvent(s.id, { type: 'quiet' });
          return;
        }
        default:
          return;
      }
    }
    if (agent === 'codex') {
      const type = String(p['type'] ?? event);
      if (/turn-complete|agent-turn-complete/.test(type)) {
        const msg = typeof p['last-assistant-message'] === 'string' ? p['last-assistant-message'] : null;
        if (msg) this.setNote(s.id, msg.slice(0, 200));
        this.applyEvent(s.id, { type: 'quiet' });
        this.hooks?.rescanHunks(s.id);
      } else this.applyEvent(s.id, { type: 'activity' });
      return;
    }
    this.applyEvent(s.id, { type: /stop|end|idle|complete/i.test(event) ? 'quiet' : 'activity' });
  }

  /** The CLI is waiting in its own TUI: a `system` line + a `question` ask so the board shows needs-you. */
  private openHookAsk(s: Session, message: string): void {
    const { repos } = this.deps;
    if (openAskCount(repos.pendingAsks.openBySession(s.id)) > 0) return;
    this.deps.transcript.system(s.id, `${AGENT_LABEL[s.agent]} is waiting in the terminal: ${message}`);
    const ask = this.openAsk(s.id, { kind: 'question', prompt: message }, null, { silent: true });
    this.hookAsks.set(s.id, ask.id);
  }

  /** The agent continued (the user answered in the terminal): drop the hook ask so needs-you clears. */
  private agentMovedOn(s: Session): void {
    const askId = this.hookAsks.get(s.id);
    if (!askId) return;
    this.hookAsks.delete(s.id);
    const ask = this.deps.repos.pendingAsks.get(askId);
    if (ask && ask.state === 'open') this.cancelAsk(ask);
  }

  private cancelAsk(ask: PendingAsk): void {
    const { repos, publisher, clock } = this.deps;
    const now = clock.now();
    repos.pendingAsks.upsert({ ...ask, state: 'cancelled', resolvedAt: now });
    publisher.upsert('pendingAsks', [ask.id]);
    for (const n of repos.notifications.byAsk(ask.id)) {
      if (n.state === 'resolved') continue;
      repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: now });
      publisher.upsert('notifications', [n.id]);
    }
    this.deps.notifications?.onAskResolved(ask.id, repos.pendingAsks.openAll().length);
    this.applyEvent(ask.sessionId, { type: 'ask-resolved', askId: ask.id });
  }

  // --- state machine -------------------------------------------------------

  /** Applies a core session event; invalid transitions are ignored (logged at debug). Returns the new session or null. */
  applyEvent(sessionId: string, event: SessionEvent): Session | null {
    const { repos, clock } = this.deps;
    const s = repos.sessions.get(sessionId);
    if (!s) return null;
    const open = openAskCount(repos.pendingAsks.openBySession(s.id));
    const t = sessionTransition(s.state, event, {
      now: clock.now(),
      sessionId: s.id,
      openAskCount: open,
      pausedReason: s.pausedReason,
      notifyWhenNeedsMe: s.toggles.notifyWhenNeedsMe,
    });
    if (t === null) {
      logger.debug('session: invalid transition', { sessionId, state: s.state, event: event.type });
      return s;
    }
    const now = clock.now();
    const next: Session = {
      ...s,
      state: t.state,
      pausedReason: t.pausedReason,
      lastActivityAt: event.type === 'activity' || event.type === 'start' ? now : s.lastActivityAt,
      endedAt: t.state === 'done' ? (s.endedAt ?? now) : null,
      exitCode: event.type === 'finish' ? event.exitCode : s.exitCode,
      pid: t.state === 'done' ? null : s.pid,
    };
    if (t.state === 'done' && next.endedAt === null) next.endedAt = now;
    const changed = JSON.stringify(next) !== JSON.stringify(s);
    if (changed) {
      repos.sessions.upsert(next);
      this.deps.publisher.upsert('sessions', [next.id]);
    }
    for (const effect of t.effects) this.runEffect(effect, next);
    if (t.state === 'done' && s.state !== 'done') {
      this.hookAsks.delete(s.id);
      const project = repos.projects.get(next.projectId);
      this.deps.activity.append({
        who: AGENT_LABEL[next.agent],
        what: `${project?.name ?? ''} · finished${next.exitCode !== null && next.exitCode !== 0 ? ` (exit ${next.exitCode})` : ''}`,
        projectId: next.projectId,
        sessionId: next.id,
      });
    }
    return next;
  }

  setNote(sessionId: string, rawNote: string | null): void {
    const s = this.require(sessionId);
    const note = rawNote === null ? null : redact(rawNote); // `report_status` notes are agent text
    if (s.note === note) return;
    this.deps.repos.sessions.upsert({ ...s, note });
    this.deps.publisher.upsert('sessions', [s.id]);
  }

  private runEffect(effect: SessionEffect, session: Session): void {
    const { repos, publisher, clock } = this.deps;
    switch (effect.type) {
      case 'notify':
        this.notifyAsk(session, effect.askId);
        return;
      case 'promoteAsk': {
        const head = headAsk(repos.pendingAsks.openBySession(session.id));
        if (head) this.notifyAsk(session, head.id);
        return;
      }
      case 'cancelOpenAsks': {
        const now = clock.now();
        const ids: string[] = [];
        for (const a of repos.pendingAsks.openBySession(session.id)) {
          repos.pendingAsks.upsert({ ...a, state: 'cancelled', resolvedAt: now });
          ids.push(a.id);
          this.hooks?.cancelHeldAsk(a);
          const perm = this.permissionAsks.get(a.id);
          if (perm) {
            this.permissionAsks.delete(a.id);
            this.deps.stream.respondPermission(perm.sessionId, perm.requestId, false, 'Session stopped');
          }
          for (const n of repos.notifications.byAsk(a.id)) {
            repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: now });
            publisher.upsert('notifications', [n.id]);
          }
        }
        publisher.upsert('pendingAsks', ids);
        this.deps.notifications?.onAskResolved('', repos.pendingAsks.openAll().length);
        return;
      }
      case 'cancelTimers': {
        const t = this.quietTimers.get(session.id);
        if (t) clearTimeout(t);
        this.quietTimers.delete(session.id);
        this.hooks?.unwatchWorktree(session.worktreeId);
        return;
      }
      case 'revokeSessionGrants':
        this.hooks?.revokeSessionGrants(session.id);
        return;
      case 'setBanner':
        this.setBanner(session, effect.reason);
        return;
      case 'clearBanner':
        this.clearBanner(session);
        return;
      case 'postSystemMessage':
        this.deps.transcript.system(session.id, effect.body);
        return;
    }
  }

  private notifyAsk(session: Session, askId: AskId): void {
    const { repos, publisher } = this.deps;
    const ask = repos.pendingAsks.get(askId);
    if (!ask || ask.state !== 'open') return;
    const project = repos.projects.get(session.projectId);
    const worktree = repos.worktrees.get(session.worktreeId);
    const agentLabel = AGENT_LABEL[session.agent];
    let title = `${agentLabel} needs you`;
    let meta = `${project?.name ?? ''} · ${worktree?.branch ?? ''}`;
    if (ask.payload.kind === 'grant') {
      const grant = repos.grants.get(ask.payload.grantId);
      const target = grant ? repos.targets.get(grant.targetId) : null;
      if (grant && target) {
        title = fill(copy.toast.title, {
          agent: agentLabel,
          target: `${target.name} ${target.env}`,
          scope: grant.scope.join(' + '),
        });
        meta = fill(copy.toast.meta, {
          project: project?.name ?? '',
          branch: worktree?.branch ?? '',
          reason: grant.reason,
        });
      }
    } else if (ask.payload.kind === 'plan') {
      title = `${agentLabel} · ${ask.payload.summary}`;
    } else {
      title = `${agentLabel} · ${ask.payload.prompt}`;
    }
    const existing = repos.notifications
      .byAsk(ask.id)
      .find((n) => n.state === 'shown' || n.state === 'later');
    if (!existing) {
      const id = `notif-${ask.id}`;
      repos.notifications.upsert({
        id,
        kind: 'needs-you',
        sessionId: session.id,
        askId: ask.id,
        projectId: session.projectId,
        title,
        body: meta,
        meta: null,
        osDelivered: this.deps.notifications !== null && !this.deps.notifications.dnd,
        state: 'shown',
        bannerKey: null,
        createdAt: this.deps.clock.now(),
        resolvedAt: null,
      });
      publisher.upsert('notifications', [id]);
    }
    publisher.sendEvent('ask.opened', { askId: ask.id, sessionId: session.id, projectId: session.projectId });
    this.deps.notifications?.onAskOpened(
      {
        askId: ask.id,
        sessionId: session.id,
        projectName: project?.name ?? '',
        branch: worktree?.branch ?? null,
        agentLabel,
        title,
        meta,
      },
      repos.pendingAsks.openAll().length,
    );
  }

  private setBanner(session: Session, reason: 'cli-missing' | 'conflict' | 'auth-expired'): void {
    const { repos, publisher } = this.deps;
    const worktree = repos.worktrees.get(session.worktreeId);
    const agentLabel = AGENT_LABEL[session.agent];
    let text: string;
    let cta: string;
    let action:
      | { kind: 'install-guide'; agent: Agent }
      | { kind: 'resolve'; worktreeId: WorktreeId }
      | { kind: 'reconnect'; targetId: never };
    let bannerKey: string;
    if (reason === 'cli-missing') {
      const n =
        repos.sessions
          .all()
          .filter(
            (s) => s.agent === session.agent && s.state === 'paused' && s.pausedReason === 'cli-missing',
          ).length || 1;
      text =
        n === 1
          ? fill(copy.errors.cliMissing.textOne, { cli: session.agent })
          : fill(copy.errors.cliMissing.text, { cli: session.agent, n });
      cta = copy.errors.cliMissing.cta;
      action = { kind: 'install-guide', agent: session.agent };
      bannerKey = `cli-missing:${session.agent}`;
    } else if (reason === 'conflict') {
      text = fill(copy.errors.conflict.text, {
        branch: worktree?.branch ?? '',
        file: worktree?.conflict?.file ?? '',
        agent: agentLabel,
      });
      cta = copy.errors.conflict.cta;
      action = { kind: 'resolve', worktreeId: session.worktreeId };
      bannerKey = `conflict:${session.worktreeId}`;
    } else {
      // auth-expired banners are raised by TargetService with the target id; here we only mark the session.
      return;
    }
    const existing = repos.notifications.byBannerKey(bannerKey);
    const id = existing?.id ?? `banner-${bannerKey}`;
    repos.notifications.upsert({
      id,
      kind: 'error-banner',
      sessionId: session.id,
      askId: null,
      projectId: session.projectId,
      title: text,
      body: '',
      meta: null,
      osDelivered: false,
      state: 'shown',
      bannerKey,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      resolvedAt: null,
    });
    publisher.upsert('notifications', [id]);
    publisher.sendEvent('banner.set', {
      bannerKey,
      kind: reason,
      text,
      cta,
      action,
      sessionId: session.id,
      reason,
    });
  }

  private clearBanner(session: Session): void {
    const { repos, publisher } = this.deps;
    const keys = [`cli-missing:${session.agent}`, `conflict:${session.worktreeId}`];
    for (const key of keys) {
      const n = repos.notifications.byBannerKey(key);
      if (!n || n.state === 'resolved') continue;
      const stillPaused = repos.sessions
        .all()
        .some(
          (s) =>
            s.id !== session.id &&
            s.state === 'paused' &&
            (key.startsWith('cli-missing') ? s.agent === session.agent : s.worktreeId === session.worktreeId),
        );
      if (stillPaused) continue;
      repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: this.deps.clock.now() });
      publisher.upsert('notifications', [n.id]);
      publisher.sendEvent('banner.clear', { bannerKey: key });
    }
  }

  /**
   * Marks the head ask resolved and moves the session on (used by ask.respond and GrantService). Asks that did not
   * come from the broker are answered into the process: stream permission decisions reply to the `can_use_tool`
   * request, hook questions are typed/sent as the next user turn.
   */
  resolveAsk(askId: string, resolution: PendingAsk['resolution']): PendingAsk {
    const { repos, publisher, clock } = this.deps;
    const ask = repos.pendingAsks.get(askId) ?? fail('not-found', `ask ${askId} not found`);
    if (ask.state !== 'open') fail('invalid-transition', 'ask is not open');
    const now = clock.now();
    const next: PendingAsk = { ...ask, state: 'resolved', resolution, resolvedAt: now };
    repos.pendingAsks.upsert(next);
    publisher.upsert('pendingAsks', [ask.id]);
    for (const n of repos.notifications.byAsk(ask.id)) {
      if (n.state === 'resolved') continue;
      repos.notifications.upsert({ ...n, state: 'acted', resolvedAt: now });
      publisher.upsert('notifications', [n.id]);
    }
    this.deps.notifications?.onAskResolved(ask.id, repos.pendingAsks.openAll().length);
    this.applyEvent(ask.sessionId, { type: 'ask-resolved', askId: ask.id });
    const perm = this.permissionAsks.get(ask.id);
    if (perm) {
      this.permissionAsks.delete(ask.id);
      const allow = resolution?.kind === 'decision' && resolution.chosen === PERMISSION_OPTIONS[0];
      this.deps.stream.respondPermission(perm.sessionId, perm.requestId, allow);
    } else if (this.hookAsks.get(ask.sessionId) === ask.id) {
      this.hookAsks.delete(ask.sessionId);
      const answer = resolution?.kind === 'question' ? resolution.answer.trim() : '';
      if (answer) {
        if (this.deps.stream.has(ask.sessionId)) this.deps.stream.send(ask.sessionId, answer);
        else if (this.deps.pty.has(ask.sessionId)) this.deps.pty.write(ask.sessionId, `${answer}\r`);
      }
    }
    return next;
  }

  /** Opens a non-grant ask (plan / decision / question) from the broker, a stream permission request or a CLI hook. */
  openAsk(
    sessionId: string,
    rawPayload: Exclude<PendingAsk['payload'], { kind: 'grant' }>,
    brokerRequestId: string | null,
    opts: { silent?: boolean } = {},
  ): PendingAsk {
    const { repos, publisher, clock } = this.deps;
    const payload = redact(rawPayload); // `ask_user` prompts/options are agent text
    const s = this.require(sessionId);
    const ask: PendingAsk = {
      id: newId<'AskId'>(),
      sessionId: s.id,
      kind: payload.kind,
      grantId: null,
      payload,
      state: 'open',
      resolution: null,
      position: repos.pendingAsks.nextPosition(s.id),
      brokerRequestId,
      createdAt: clock.now(),
      resolvedAt: null,
    };
    repos.pendingAsks.upsert(ask);
    publisher.upsert('pendingAsks', [ask.id]);
    if (!opts.silent) {
      if (payload.kind === 'plan')
        this.deps.transcript.append(s.id, payload.summary, { kind: 'agent' }, ask.id);
      else if (payload.kind === 'decision')
        this.deps.transcript.append(
          s.id,
          payload.prompt,
          { kind: 'decision', options: payload.options, chosen: null },
          ask.id,
        );
      else this.deps.transcript.append(s.id, payload.prompt, { kind: 'agent' }, ask.id);
    }
    this.setNote(s.id, payload.kind === 'plan' ? payload.summary : payload.prompt);
    this.applyEvent(s.id, { type: 'ask', askId: ask.id });
    return ask;
  }
}
