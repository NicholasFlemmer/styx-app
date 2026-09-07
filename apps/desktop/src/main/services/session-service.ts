import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AGENT_LABEL,
  MODEL_ALIASES,
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
  type MessagePayload,
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
  type Effort,
  type PermissionMode,
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
import type { StreamBlockKind, StreamEffect, StreamRunnerLike } from './stream-runner';
import type { TranscriptService } from './transcript-service';

export const QUIET_MS = 3000;
/** A live stream row is patched at most once per this interval (≈30 fps), with a trailing flush. */
export const STREAM_FLUSH_MS = 33;
/** Partial deltas are session activity, but the machine hears about it at most once per this interval. */
export const STREAM_ACTIVITY_MS = 1000;

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
  permissionMode?: PermissionMode;
  effort?: Effort | null;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const PERMISSION_OPTIONS = ['Allow', 'Deny'] as const;

/**
 * `can_use_tool` for Claude Code's AskUserQuestion (claude 2.1.263): one or more questions with labelled options.
 * The answer is an *allow* whose `updatedInput` carries `{questions, answers: {[question]: label}}`.
 */
const askUserQuestionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        options: z.array(z.object({ label: z.string().min(1) })).default([]),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
});

/** `can_use_tool` for ExitPlanMode: the plan markdown; allow = leave plan mode, deny (with a note) = keep planning. */
const exitPlanModeInput = z.object({ plan: z.string().default('') });

/** A stream `can_use_tool` request waiting on an ask, by ask id. */
type PermissionAsk =
  | { kind: 'tool'; sessionId: string; requestId: string }
  | { kind: 'plan'; sessionId: string; requestId: string }
  | { kind: 'question'; sessionId: string; requestId: string; question: string };

/** One AskUserQuestion request: answers collected across its questions until every ask has resolved. */
interface QuestionRequest {
  sessionId: string;
  questions: unknown;
  remaining: number;
  answers: Record<string, string>;
}

/**
 * One text / thinking block streaming into a transcript row (`streamStart` … `streamStop` / `streamFinal`). The row
 * is created by the first flush that has something to show: the CLI emits thinking blocks that stay empty (a
 * signature only), and those must not leave a "Thought for 0s" row behind.
 */
interface LiveStream {
  messageId: string | null;
  kind: StreamBlockKind;
  startedAt: number;
  /** Everything received so far; the row body lags it by at most one flush. */
  buffer: string;
  dirty: boolean;
  lastFlushAt: number;
  timer: NodeJS.Timeout | null;
  /** The row's payload has been settled (`streaming` dropped / thinking `done`). */
  settled: boolean;
}

/** The settled payload for a row still marked as streaming; null when the row is not streaming. */
const settledPayload = (payload: MessagePayload, durationMs: number | null): MessagePayload | null => {
  if (payload.kind === 'agent' && payload.streaming === true) return { kind: 'agent' };
  if (payload.kind === 'thinking' && payload.status === 'streaming')
    return { kind: 'thinking', status: 'done', durationMs };
  return null;
};

const modelLabel = (model: string | null): string => {
  if (model === null) return copy.session.models.default;
  const alias = MODEL_ALIASES.find((a) => a === model);
  return alias ? copy.session.models[alias] : model;
};

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
  /** Stream `can_use_tool` requests waiting on an ask (tool decision, plan approval, clarifying question). */
  private readonly permissionAsks = new Map<string, PermissionAsk>();
  /** AskUserQuestion requests by request id; removed once answered or denied (so a request is answered once). */
  private readonly questionRequests = new Map<string, QuestionRequest>();
  /** Last ANSI-stripped output per pty session, scanned for the CLI-outdated message across chunk boundaries. */
  private readonly ptyTails = new Map<string, string>();
  /** When the outdated banner was last raised per session (the error arrives as assistant text and as a result). */
  private readonly outdatedAt = new Map<string, number>();
  /** Live stream rows per session, by block key (`<messageId>:<index>` from the parser). */
  private readonly liveStreams = new Map<SessionId, Map<string, LiveStream>>();
  /** Last time a partial delta was reported as `activity`, per session. */
  private readonly streamActivityAt = new Map<string, number>();

  constructor(private readonly deps: SessionServiceDeps) {
    deps.pty.on('data', (id, data) => this.onPtyData(id, data));
    deps.pty.on('exit', (id, exitCode) => this.onPtyExit(id, exitCode));
    deps.stream.on('effect', (id, effect) => this.onStreamEffect(id, effect));
    deps.stream.on('exit', (id, exitCode) => this.onStreamExit(id, exitCode));
    this.sweepStreaming();
  }

  /**
   * Rows left `streaming` by a previous process (crash, force quit) settle at startup: an agent row is just done, a
   * thinking row is done with an unknown duration. Nothing is live yet, so this only touches the DB.
   */
  sweepStreaming(): void {
    const { repos } = this.deps;
    for (const sessionId of repos.transcripts.sessionIds()) {
      let changed: SessionId | null = null;
      for (const m of repos.transcripts.last(sessionId, 200)) {
        const payload = settledPayload(m.payload, null);
        if (payload === null) continue;
        repos.transcripts.upsert({ ...m, payload });
        changed = m.sessionId;
      }
      if (changed !== null) this.republishTranscript(changed);
    }
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
      permissionMode: input.permissionMode ?? 'default',
      effort: input.effort ?? null,
      cliSessionId: null,
      costUsd: 0,
      numTurns: 0,
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
      permissionMode: session.permissionMode,
      effort: session.effort,
      // A relaunch resumes the CLI's own conversation (`--resume`); the first launch has no id yet.
      resumeSessionId: session.cliSessionId,
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

  /**
   * Live session settings (Claude Code parity): the row is updated and published; a running stream gets
   * `set_model` / `set_permission_mode` immediately, effort applies at the next (re)launch (no restart). A model or
   * mode that actually changed leaves a `system` line in the chat.
   */
  configure(
    sessionId: string,
    changes: {
      model?: string | null | undefined;
      permissionMode?: PermissionMode | undefined;
      effort?: Effort | null | undefined;
    },
  ): void {
    const s = this.require(sessionId);
    if (s.state === 'done') fail('invalid-transition', 'session has finished');
    const next: Session = {
      ...s,
      ...(changes.model !== undefined ? { model: changes.model } : {}),
      ...(changes.permissionMode !== undefined ? { permissionMode: changes.permissionMode } : {}),
      ...(changes.effort !== undefined ? { effort: changes.effort } : {}),
    };
    this.deps.repos.sessions.upsert(next);
    this.deps.publisher.upsert('sessions', [s.id]);
    const modelChanged = next.model !== s.model;
    const modeChanged = next.permissionMode !== s.permissionMode;
    if (this.deps.stream.has(s.id)) {
      if (modelChanged) this.deps.stream.setModel(s.id, next.model);
      if (modeChanged) this.deps.stream.setPermissionMode(s.id, next.permissionMode);
    }
    if (modelChanged)
      this.deps.transcript.system(
        s.id,
        fill(copy.chat.controls.modelChanged, { model: modelLabel(next.model) }),
      );
    if (modeChanged)
      this.deps.transcript.system(
        s.id,
        fill(copy.chat.controls.modeChanged, { mode: copy.session.permissionModes[next.permissionMode] }),
      );
  }

  /**
   * Stops the current turn, not the session: stream `interrupt` control request (then a `system` line and `quiet`,
   * since the CLI ends the turn without a further result the machine could wait on); Ctrl+C on a pty, whose own
   * Stop hook ends the turn.
   */
  interrupt(sessionId: string): void {
    const s = this.require(sessionId);
    if (this.deps.stream.has(s.id)) {
      this.deps.stream.interrupt(s.id);
      this.finaliseStreams(s.id);
      this.deps.transcript.system(s.id, copy.chat.controls.interrupted);
      this.applyEvent(s.id, { type: 'quiet' });
    } else if (this.deps.pty.has(s.id)) this.deps.pty.write(s.id, '\x03');
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
    for (const sessionId of [...this.liveStreams.keys()]) this.finaliseStreams(sessionId);
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
      case 'init': {
        // The CLI's own session id makes a later relaunch `--resume`; a default model becomes the reported one.
        const next: Session = {
          ...s,
          cliSessionId: effect.chatId ?? s.cliSessionId,
          model: s.model ?? effect.model,
        };
        if (next.cliSessionId !== s.cliSessionId || next.model !== s.model) {
          this.deps.repos.sessions.upsert(next);
          this.deps.publisher.upsert('sessions', [s.id]);
        }
        return;
      }
      case 'usage': {
        // `total_cost_usd` / `num_turns` are running totals for the CLI session; after `--resume` they carry on, so
        // the stored value only ever grows.
        const next: Session = {
          ...s,
          costUsd: effect.costUsd === null ? s.costUsd : Math.max(s.costUsd, effect.costUsd),
          numTurns: effect.numTurns === null ? s.numTurns : Math.max(s.numTurns, effect.numTurns),
        };
        if (next.costUsd !== s.costUsd || next.numTurns !== s.numTurns) {
          this.deps.repos.sessions.upsert(next);
          this.deps.publisher.upsert('sessions', [s.id]);
        }
        return;
      }
      case 'toolResult':
        this.patchToolLine(s.id, effect.toolUseId, effect.ok, effect.detail);
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
      case 'streamStart':
        this.onStreamStart(s, effect.key, effect.kind);
        return;
      case 'streamDelta':
        this.onStreamDelta(s.id, effect.key, effect.text);
        return;
      case 'streamStop':
        this.onStreamStop(s.id, effect.key);
        return;
      case 'streamFinal':
        this.onStreamFinal(s, effect.key, effect.body);
        return;
      case 'streamUsage':
        return; // output tokens of the message in flight: nothing shows them yet
    }
  }

  private onStreamExit(id: string, exitCode: number | null): void {
    this.render(id, `— exited${exitCode !== null ? ` (${exitCode})` : ''}\r\n`);
    this.deps.publisher.ptyExit(id, exitCode);
    const s = this.deps.repos.sessions.get(id);
    if (!s) return;
    this.finaliseStreams(s.id);
    this.deps.ptyLog.close(id);
    this.onProcessExit(s, exitCode);
  }

  // --- partial messages ----------------------------------------------------

  /** A text / thinking block begins; its row (marked as streaming) appears with the first non-blank text. */
  private onStreamStart(s: Session, key: string, kind: StreamBlockKind): void {
    let live = this.liveStreams.get(s.id);
    if (!live) {
      live = new Map();
      this.liveStreams.set(s.id, live);
    }
    live.set(key, {
      messageId: null,
      kind,
      startedAt: this.deps.clock.now(),
      buffer: '',
      dirty: false,
      lastFlushAt: Number.NEGATIVE_INFINITY,
      timer: null,
      settled: false,
    });
    this.streamActivity(s.id);
  }

  /** Text lands in the buffer; the row is patched now if the last flush is old enough, else on a trailing timer. */
  private onStreamDelta(sessionId: SessionId, key: string, text: string): void {
    const entry = this.liveStreams.get(sessionId)?.get(key);
    if (!entry) return;
    entry.buffer += text;
    entry.dirty = true;
    this.streamActivity(sessionId);
    const elapsed = this.deps.clock.now() - entry.lastFlushAt;
    if (elapsed >= STREAM_FLUSH_MS) {
      this.flushStream(sessionId, entry);
      return;
    }
    if (entry.timer !== null) return;
    const t = setTimeout(() => {
      entry.timer = null;
      this.flushStream(sessionId, entry);
    }, STREAM_FLUSH_MS - elapsed);
    t.unref?.();
    entry.timer = t;
  }

  /** The block ended: the row settles (`streaming` dropped / thinking done with its duration) and is republished. */
  private onStreamStop(sessionId: SessionId, key: string): void {
    const entry = this.liveStreams.get(sessionId)?.get(key);
    if (!entry) return;
    this.flushStream(sessionId, entry);
    if (this.settleStream(entry)) this.republishTranscript(sessionId);
  }

  /**
   * The complete block from the `assistant` event (the CLI sends it *before* the block's `content_block_stop`): the
   * row body is reconciled to it, the row settles, and the block is forgotten — the stop that follows is a no-op.
   */
  private onStreamFinal(s: Session, key: string, body: string): void {
    const live = this.liveStreams.get(s.id);
    const entry = live?.get(key);
    if (!live || !entry) return;
    if (body !== entry.buffer) {
      entry.buffer = body;
      entry.dirty = true;
    }
    this.flushStream(s.id, entry);
    if (this.settleStream(entry)) this.republishTranscript(s.id);
    live.delete(key);
    if (live.size === 0) this.liveStreams.delete(s.id);
    const outdated = entry.kind === 'text' ? parseCliOutdated(body) : null;
    if (outdated !== null) this.raiseOutdatedBanner(s, body, outdated);
  }

  /** Process exit, interrupt, session end: every live block flushes and settles so no row streams forever. */
  private finaliseStreams(sessionId: SessionId): void {
    const live = this.liveStreams.get(sessionId);
    if (!live) return;
    this.liveStreams.delete(sessionId);
    let changed = false;
    for (const entry of live.values()) {
      this.flushStream(sessionId, entry);
      if (this.settleStream(entry)) changed = true;
    }
    if (changed) this.republishTranscript(sessionId);
  }

  private flushStream(sessionId: SessionId, entry: LiveStream): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty) return;
    if (entry.messageId === null) {
      if (entry.buffer.trim() === '') return; // nothing to show yet: no row (an empty block never gets one)
      const payload: MessagePayload =
        entry.kind === 'text'
          ? { kind: 'agent', streaming: true }
          : { kind: 'thinking', status: 'streaming', durationMs: null };
      entry.messageId = this.deps.transcript.append(sessionId, entry.buffer, payload).id; // redacts
    } else {
      this.deps.transcript.patch(sessionId, entry.messageId, entry.buffer); // redacts
    }
    entry.dirty = false;
    entry.lastFlushAt = this.deps.clock.now();
  }

  /** Writes the settled payload (once); the caller republishes. Returns whether the row changed. */
  private settleStream(entry: LiveStream): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    if (entry.messageId === null) return false;
    const row = this.deps.repos.transcripts.get(entry.messageId);
    if (!row) return false;
    const payload = settledPayload(row.payload, Math.max(0, this.deps.clock.now() - entry.startedAt));
    if (payload === null) return false;
    this.deps.repos.transcripts.upsert({ ...row, payload });
    return true;
  }

  /** Payload changes have no delta of their own: the session's recent transcript is re-sent whole. */
  private republishTranscript(sessionId: SessionId): void {
    const { repos, publisher } = this.deps;
    publisher.emit({ op: 'transcript.replace', sessionId, messages: repos.transcripts.last(sessionId, 200) });
  }

  /** Partial output is activity, reported to the machine at most once per STREAM_ACTIVITY_MS. */
  private streamActivity(sessionId: SessionId): void {
    const now = this.deps.clock.now();
    const last = this.streamActivityAt.get(sessionId);
    if (last !== undefined && now - last < STREAM_ACTIVITY_MS) return;
    this.streamActivityAt.set(sessionId, now);
    this.applyEvent(sessionId, { type: 'activity' });
  }

  /** A `tool_result` landed: the matching `tool` line gets its status (and the error's first line). */
  private patchToolLine(sessionId: SessionId, toolUseId: string, ok: boolean, detail: string | null): void {
    const { repos } = this.deps;
    const msg = repos.transcripts
      .last(sessionId, 200)
      .find((m) => m.payload.kind === 'tool' && m.payload.toolUseId === toolUseId);
    if (!msg || msg.payload.kind !== 'tool') return;
    repos.transcripts.upsert({
      ...msg,
      payload: {
        ...msg.payload,
        status: ok ? 'ok' : 'error',
        detail: detail === null ? null : redact(detail),
      },
    });
    this.republishTranscript(sessionId);
  }

  /**
   * `can_use_tool` from the stream: edits pass when the toggle says so; AskUserQuestion becomes one decision ask per
   * question (answered together as the request's `updatedInput`); ExitPlanMode becomes a plan ask; everything else
   * is an Allow/Deny decision. In `bypassPermissions` / `dontAsk` the CLI should not ask at all — if it does, the
   * request is handled like any other.
   */
  private onPermissionRequest(
    s: Session,
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    if (toolName === 'AskUserQuestion') {
      const parsed = askUserQuestionInput.safeParse(input);
      if (parsed.success) {
        this.openQuestionAsks(s, requestId, input['questions'], parsed.data.questions);
        return;
      }
    } else if (toolName === 'ExitPlanMode') {
      const parsed = exitPlanModeInput.safeParse(input);
      const ask = this.openAsk(
        s.id,
        { kind: 'plan', summary: parsed.success ? parsed.data.plan : '', files: [] },
        null,
      );
      this.setNote(s.id, copy.session.plan.header);
      this.permissionAsks.set(ask.id, { kind: 'plan', sessionId: s.id, requestId });
      return;
    }
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
    this.permissionAsks.set(ask.id, { kind: 'tool', sessionId: s.id, requestId });
  }

  /** One ask per AskUserQuestion question: a decision over its labels (+ "Other…"), or free text when it has none. */
  private openQuestionAsks(
    s: Session,
    requestId: string,
    rawQuestions: unknown,
    questions: z.infer<typeof askUserQuestionInput>['questions'],
  ): void {
    this.questionRequests.set(requestId, {
      sessionId: s.id,
      questions: rawQuestions,
      remaining: questions.length,
      answers: {},
    });
    for (const q of questions) {
      const prompt = q.header ? `${q.header} — ${q.question}` : q.question;
      const labels = q.options.map((o) => o.label);
      const ask =
        labels.length > 0
          ? this.openAsk(
              s.id,
              { kind: 'decision', prompt, options: [...labels, copy.session.question.other] },
              null,
            )
          : this.openAsk(s.id, { kind: 'question', prompt }, null);
      this.permissionAsks.set(ask.id, { kind: 'question', sessionId: s.id, requestId, question: q.question });
    }
  }

  /** Answers the stream request an ask was holding, once the ask resolved. */
  private answerPermission(perm: PermissionAsk, resolution: PendingAsk['resolution']): void {
    const { stream } = this.deps;
    switch (perm.kind) {
      case 'tool': {
        const allow = resolution?.kind === 'decision' && resolution.chosen === PERMISSION_OPTIONS[0];
        stream.respondPermission(perm.sessionId, perm.requestId, allow);
        return;
      }
      case 'plan': {
        if (resolution?.kind === 'plan' && resolution.outcome === 'approved') {
          stream.respondPermission(perm.sessionId, perm.requestId, true);
          // The CLI leaves plan mode on approval; mirror that so the controls agree with it.
          const s = this.deps.repos.sessions.get(perm.sessionId);
          if (s && s.state !== 'done' && s.permissionMode === 'plan')
            this.configure(s.id, { permissionMode: 'default' });
          return;
        }
        const note = resolution?.kind === 'plan' ? (resolution.note?.trim() ?? '') : '';
        stream.respondPermission(perm.sessionId, perm.requestId, false, note || copy.session.plan.rejectedNote);
        return;
      }
      case 'question': {
        const req = this.questionRequests.get(perm.requestId);
        if (!req) return; // already denied (session stopped) — nothing left to answer
        let answer: string;
        if (resolution?.kind === 'decision') {
          if (resolution.chosen === copy.session.question.other) {
            // "Other…": the same question again as free text; its answer is the value.
            const ask = this.openAsk(perm.sessionId, { kind: 'question', prompt: perm.question }, null);
            this.permissionAsks.set(ask.id, perm);
            return;
          }
          answer = resolution.chosen;
        } else answer = resolution?.kind === 'question' ? resolution.answer.trim() : '';
        req.answers[perm.question] = answer;
        req.remaining -= 1;
        if (req.remaining > 0) return;
        this.questionRequests.delete(perm.requestId);
        stream.respondPermission(perm.sessionId, perm.requestId, true, undefined, {
          questions: req.questions,
          answers: req.answers,
        });
        return;
      }
    }
  }

  /** Denies the request behind a cancelled ask; an AskUserQuestion request is denied once, whatever its asks. */
  private denyPermission(perm: PermissionAsk, message: string): void {
    if (perm.kind === 'question') {
      if (!this.questionRequests.delete(perm.requestId)) return;
    }
    this.deps.stream.respondPermission(perm.sessionId, perm.requestId, false, message);
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
            this.denyPermission(perm, 'Session stopped');
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
        this.finaliseStreams(session.id);
        this.streamActivityAt.delete(session.id);
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
   * request, hook questions are typed/sent as the next user turn. Answering an ask that already resolved (a double
   * click) is a no-op that returns the row; only a cancelled ask is an error.
   */
  resolveAsk(askId: string, resolution: PendingAsk['resolution']): PendingAsk {
    const { repos, publisher, clock } = this.deps;
    const ask = repos.pendingAsks.get(askId) ?? fail('not-found', `ask ${askId} not found`);
    if (ask.state === 'resolved') return ask;
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
      this.answerPermission(perm, resolution);
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
