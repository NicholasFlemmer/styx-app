import {
  CHANNELS,
  SIGNED_OUT,
  type AccountState,
  type UpdateState,
  type ActivityRow,
  type AgentChange,
  type AppSettings,
  type CliInstall,
  type Delta,
  type Deploy,
  type Checkpoint,
  type QueuedMessage,
  type AgentLimits,
  type DevRun,
  type DeviceSession,
  type EffectiveProjectSettings,
  type EventName,
  type EventPayload,
  type IdeInstall,
  type ReadModelSnapshot,
  type SessionId,
  type TableName,
  type TranscriptMessage,
} from '@styx/core';
import type { Repos } from '../db/repos';
import { TRANSCRIPT_PAGE, TRANSCRIPT_WINDOW, buildSnapshot } from './projection';

/** The slice of `WebContents` the publisher needs (fakeable in tests). */
export interface WindowLike {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export interface PublisherDeps {
  repos: Repos;
  popouts: () => string[];
  /** Coalescing window; deltas emitted within it become one `store.delta` batch. */
  tickMs?: number;
}

/** In-memory slices that ride in the snapshot (main-owned processes: local runs and deploys; the latest CLI limits). Bound after the services exist. */
export interface SnapshotExtras {
  runs: () => DevRun[];
  devices: () => DeviceSession[];
  deploys: () => Deploy[];
  limits: () => Record<string, AgentLimits>;
  /** The Styx account (ADR-0026), owned by AccountService in memory and persisted per machine. */
  account: () => AccountState;
  /** Updates in place (#119), owned by UpdateService in memory. */
  update?: () => UpdateState;
}

/** The single `styx:evt` channel carries every main → renderer event as `{ name, payload }`. */
export const EVENT_CHANNEL = 'styx:evt';

/**
 * Sequences and fans out store deltas to every registered window (plan §7). Every mutation path is:
 * write DB → `upsert`/`remove`/… → one `store.delta { seq, deltas }` per ≤16 ms tick.
 */
/** 64 KB of output per pty, 16 ptys: a screenful of scrollback, never a memory sink. */
const PTY_BACKLOG_CHARS = 64 * 1024;
const PTY_BACKLOG_PTYS = 16;

export class Publisher {
  private seqNo = 0;
  private pending: Delta[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly windows = new Map<number, WindowLike>();
  private readonly ptyPending = new Map<string, string>();
  private readonly ptySeq = new Map<string, number>();
  /**
   * The last stretch of each pty's output, so a terminal that attaches after the process started (the run
   * output strip, a reopened login) can show what was already printed instead of a blank until the next byte.
   * Bounded per pty and in the number of ptys remembered; a pty's entry goes when it exits and one more exits after.
   */
  private readonly ptyBacklog = new Map<string, string>();
  private readonly ptyExited: string[] = [];
  private ptyTimer: NodeJS.Timeout | null = null;
  /** Sessions whose transcript was opened further back than the default window ("Show earlier messages"). */
  private readonly transcriptWindows = new Map<string, number>();
  private readonly tickMs: number;
  private extras: SnapshotExtras = {
    runs: () => [],
    devices: () => [],
    deploys: () => [],
    limits: () => ({}),
    account: () => SIGNED_OUT,
  };

  constructor(private readonly deps: PublisherDeps) {
    this.tickMs = deps.tickMs ?? 16;
  }

  /** Services that own in-memory state register it here so a fresh window's snapshot includes it. */
  bindExtras(extras: Partial<SnapshotExtras>): void {
    this.extras = { ...this.extras, ...extras };
  }

  get seq(): number {
    return this.seqNo;
  }

  // --- window registry ------------------------------------------------------

  register(w: WindowLike): void {
    this.windows.set(w.id, w);
  }

  unregister(id: number): void {
    this.windows.delete(id);
  }

  isRegistered(id: number): boolean {
    const w = this.windows.get(id);
    return w !== undefined && !w.isDestroyed();
  }

  window(id: number): WindowLike | null {
    return this.windows.get(id) ?? null;
  }

  private live(): WindowLike[] {
    const out: WindowLike[] = [];
    for (const [id, w] of this.windows) {
      if (w.isDestroyed()) this.windows.delete(id);
      else out.push(w);
    }
    return out;
  }

  // --- deltas --------------------------------------------------------------

  emit(...deltas: Delta[]): void {
    if (deltas.length === 0) return;
    this.pending.push(...deltas);
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.tickMs);
  }

  /** Sends the pending batch now (also invoked before events and snapshots so ordering is preserved). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const deltas = this.pending;
    this.pending = [];
    this.seqNo += 1;
    const batch = { seq: this.seqNo, deltas };
    for (const w of this.live()) w.send(CHANNELS.store, batch);
  }

  /** Re-reads rows through the repos so the delta always reflects committed DB state. */
  upsert<N extends TableName>(table: N, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const rows = this.deps.repos.rowsOf(table, ids);
    if (rows.length > 0) this.emit({ op: 'upsert', table, rows } as unknown as Delta);
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) this.emit({ op: 'remove', table, ids: missing });
  }

  remove(table: TableName, ids: readonly string[]): void {
    if (ids.length > 0) this.emit({ op: 'remove', table, ids: [...ids] });
  }

  /** How many of a session's latest rows the renderer holds. */
  transcriptWindow(sessionId: string): number {
    return this.transcriptWindows.get(sessionId) ?? TRANSCRIPT_WINDOW;
  }

  /** Re-sends a session's transcript within its current window (after a row was rewritten in place). */
  transcriptReplace(sessionId: SessionId): void {
    this.emit({
      op: 'transcript.replace',
      sessionId,
      messages: this.deps.repos.transcripts.last(sessionId, this.transcriptWindow(sessionId)),
    });
  }

  /** "Show earlier messages": widens the session's window by a page and re-sends it, so a long thread reads from the top. */
  transcriptEarlier(sessionId: SessionId): void {
    this.transcriptWindows.set(sessionId, this.transcriptWindow(sessionId) + TRANSCRIPT_PAGE);
    this.transcriptReplace(sessionId);
  }

  transcriptAppend(sessionId: SessionId, messages: TranscriptMessage[]): void {
    if (messages.length > 0) this.emit({ op: 'transcript.append', sessionId, messages });
  }

  transcriptPatch(sessionId: SessionId, messageId: string, body: string): void {
    this.emit({ op: 'transcript.patch', sessionId, messageId, body });
  }

  hunksReplace(sessionId: SessionId, hunks: AgentChange[]): void {
    this.emit({ op: 'hunks.replace', sessionId, hunks });
  }

  discoverySet(ides: IdeInstall[], clis: CliInstall[]): void {
    this.emit({ op: 'discovery.set', ides, clis });
  }

  settingsSet(app?: AppSettings, project?: Record<string, EffectiveProjectSettings>): void {
    this.emit({
      op: 'settings.set',
      ...(app !== undefined ? { app } : {}),
      ...(project !== undefined ? { project } : {}),
    });
  }

  activityAppend(rows: ActivityRow[]): void {
    if (rows.length > 0) this.emit({ op: 'activity.append', rows });
  }

  popoutsSet(): void {
    this.emit({ op: 'popouts.set', sessionIds: this.deps.popouts() as SessionId[] });
  }

  runsSet(projectId: string, run: DevRun | null): void {
    this.emit({ op: 'runs.set', projectId: projectId as DevRun['projectId'], run });
  }

  devicesSet(projectId: string, device: DeviceSession | null): void {
    this.emit({ op: 'devices.set', projectId: projectId as DeviceSession['projectId'], device });
  }

  deploysSet(deploy: Deploy): void {
    this.emit({ op: 'deploys.set', deploy });
  }

  checkpointsReplace(sessionId: SessionId, checkpoints: Checkpoint[]): void {
    this.emit({ op: 'checkpoints.replace', sessionId, checkpoints });
  }

  queueReplace(sessionId: SessionId, messages: QueuedMessage[]): void {
    this.emit({ op: 'queue.replace', sessionId, messages });
  }

  limitsSet(limits: AgentLimits): void {
    this.emit({ op: 'limits.set', limits });
  }

  accountSet(account: AccountState): void {
    this.emit({ op: 'account.set', account });
  }

  updateSet(update: UpdateState): void {
    this.emit({ op: 'update.set', update });
  }

  // --- snapshot ------------------------------------------------------------

  snapshot(): ReadModelSnapshot {
    this.flush();
    return buildSnapshot(
      {
        repos: this.deps.repos,
        popouts: this.deps.popouts,
        transcriptWindow: (sid) => this.transcriptWindow(sid),
        runs: this.extras.runs,
        devices: this.extras.devices,
        deploys: this.extras.deploys,
        limits: this.extras.limits,
        account: this.extras.account,
        ...(this.extras.update !== undefined ? { update: this.extras.update } : {}),
      },
      this.seqNo,
    );
  }

  // --- events --------------------------------------------------------------

  sendEvent<E extends EventName>(name: E, payload: EventPayload<E>): void {
    this.flush();
    for (const w of this.live()) w.send(EVENT_CHANNEL, { name, payload });
  }

  // --- pty bytes -----------------------------------------------------------

  /** Bytes are coalesced per pty id and sent on `styx:pty` as `{ id, data, seq }` at most once per tick. */
  pty(id: string, data: string): void {
    this.ptyPending.set(id, (this.ptyPending.get(id) ?? '') + data);
    if (this.ptyTimer === null) this.ptyTimer = setTimeout(() => this.flushPty(), this.tickMs);
  }

  flushPty(): void {
    if (this.ptyTimer !== null) {
      clearTimeout(this.ptyTimer);
      this.ptyTimer = null;
    }
    if (this.ptyPending.size === 0) return;
    const windows = this.live();
    for (const [id, data] of this.ptyPending) {
      const seq = (this.ptySeq.get(id) ?? 0) + 1;
      this.ptySeq.set(id, seq);
      for (const w of windows) w.send(CHANNELS.pty, { id, data, seq });
      // What went out is what a late terminal may ask for; the seq says up to which batch.
      const kept = (this.ptyBacklog.get(id) ?? '') + data;
      this.ptyBacklog.set(id, kept.length > PTY_BACKLOG_CHARS ? kept.slice(-PTY_BACKLOG_CHARS) : kept);
      if (this.ptyBacklog.size > PTY_BACKLOG_PTYS) {
        const oldest = this.ptyBacklog.keys().next().value;
        if (oldest !== undefined && oldest !== id) this.ptyBacklog.delete(oldest);
      }
    }
    this.ptyPending.clear();
  }

  ptyExit(id: string, exitCode: number | null): void {
    this.flushPty();
    this.ptyPending.delete(id);
    // The seq stays (a late backlog read after the exit still names its last batch); the backlog outlives the
    // exit by one more exit: a failed run's strip opens after the process is gone.
    this.ptyExited.push(id);
    while (this.ptyExited.length > 1) {
      const gone = this.ptyExited.shift() ?? '';
      this.ptyBacklog.delete(gone);
      this.ptySeq.delete(gone);
    }
    this.sendEvent('pty.exit', { id, exitCode });
  }

  /** What a pty printed so far (bounded) and the seq of the last batch it covers, for a terminal attaching late. */
  ptyBacklogOf(id: string): { data: string; seq: number } {
    this.flushPty();
    return { data: this.ptyBacklog.get(id) ?? '', seq: this.ptySeq.get(id) ?? 0 };
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.ptyTimer !== null) clearTimeout(this.ptyTimer);
    this.timer = null;
    this.ptyTimer = null;
    this.windows.clear();
  }
}
