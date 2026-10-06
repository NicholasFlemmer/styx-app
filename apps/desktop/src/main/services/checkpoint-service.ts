import {
  copy,
  fill,
  newId,
  type Checkpoint,
  type DeviceSession,
  type DevRun,
  type ProjectId,
  type SessionId,
} from '@styx/core';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import { confine } from './confine';
import type { GitRunner } from './git';
import { logger } from './logger';
import type { ScreenSide, ScreensStore } from './screens-store';
import type { TranscriptService } from './transcript-service';

/** The longest a turn waits for its `before` snapshot before the message goes out anyway. */
export const BASE_WAIT_MS = 15_000;

/** Every checkpoint ref lives here, out of `refs/heads` and `refs/tags`: nothing lands on the user's branch. */
export const CHECKPOINT_REF_ROOT = 'refs/styx/checkpoints';

export const checkpointRef = (sessionId: string, turn: number, which: 'base' | 'after'): string =>
  `${CHECKPOINT_REF_ROOT}/${sessionId}/${turn}/${which}`;

export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** A screenshot source that hangs (a simulator mid-boot) must never hold the session's chain: give up after this. */
export const SCREEN_CAPTURE_TIMEOUT_MS = 5000;

/** Canonical order of a checkpoint's screenshots, whichever side landed first. */
export const SCREEN_SIDES: readonly ScreenSide[] = ['before', 'after'];

/** Commits are written with a fixed identity and never signed: a signing prompt would hang the capture. */
const COMMIT_CONFIG = [
  '-c',
  'user.name=Styx',
  '-c',
  'user.email=styx@localhost',
  '-c',
  'commit.gpgsign=false',
];

export interface CheckpointFile {
  path: string;
  added: number;
  removed: number;
}

/** One turn taken out of the live worktree: the tree to restore, or the files that stop it. */
type UndoTree = { ok: true; tree: string } | { ok: false; files: string[] };

export interface CheckpointDiff {
  patch: string;
  files: CheckpointFile[];
}

export interface CheckpointServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  git: GitRunner;
  transcript: TranscriptService;
  /**
   * A Styx line for the session's agent (SessionService.tell): shown in the chat now and sent ahead of the agent's
   * next turn, so it knows a turn of its was undone.
   */
  tell: (sessionId: SessionId, text: string) => void;
  /** Re-diffs the session's worktree once a revert has rewritten it (HunkService). */
  rescanHunks: (sessionId: SessionId) => Promise<unknown>;
  /** Where the before / after pictures live (served as `styx-device://checkpoint/<id>/<side>`). */
  screens: ScreensStore;
  /**
   * A PNG of the running app for the project right now — the mirrored device, else the design window's page —
   * or null when nothing is running (normal, not an error). The container decides the source (`screenshotSourceFor`).
   */
  screenshot: (projectId: ProjectId) => Promise<Buffer | null>;
  /** Retention pass period (hourly by default). */
  pruneMs?: number;
  /** How long a screenshot may take before the turn goes on without it. */
  captureTimeoutMs?: number;
}

/** How many of a session's newest turns keep their Before / After pictures on disk. */
export const SCREENS_KEEP_TURNS = 40;

/** Which picture the design window can give for a project: the mirrored device, the loaded web page, or none. */
export type ScreenshotSource = 'device' | 'preview' | null;

/**
 * The design window is one window showing one thing, so a checkpoint screenshot is only taken when what it shows
 * is this project's app: a device session (its mirror owns the picture; the device answers null until it is
 * ready, and the page under it is never a stand-in for a mobile app), else a live *web* run (a device-platform run
 * without a device session has no page), else the project's saved dev URL when nothing runs (the user runs the
 * server themselves). Pure so the rule is testable; the container wires it.
 */
export const screenshotSourceFor = (input: {
  projectId: string;
  devices: readonly { projectId: string; phase: DeviceSession['phase'] }[];
  runs: readonly {
    projectId: string;
    phase: DevRun['phase'];
    platform: DevRun['platform'];
    url: string | null;
  }[];
  devUrl: string | null;
  /** What the (single) design window has loaded right now; the page is only this project's when it matches. */
  loadedUrl: string | null;
}): ScreenshotSource => {
  const device = input.devices.find(
    (d) => d.projectId === input.projectId && (d.phase === 'booting' || d.phase === 'ready'),
  );
  if (device !== undefined) return 'device';
  if (input.loadedUrl === null) return null;
  const live = input.runs.find((r) => r.projectId === input.projectId && r.phase !== 'exited');
  if (live !== undefined)
    return live.platform === 'web' && sameUrl(live.url, input.loadedUrl) ? 'preview' : null;
  return sameUrl(input.devUrl, input.loadedUrl) ? 'preview' : null;
};

/** `localhost:3000` and `http://localhost:3000/` are the same page; anything unparsable is not. */
const sameUrl = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return false;
  const norm = (raw: string): string | null => {
    const text = raw.trim();
    if (text === '') return null;
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).href;
    } catch {
      return null;
    }
  };
  const x = norm(a);
  return x !== null && x === norm(b);
};

/** `screens` with `side` added, in canonical order (before → after) whichever landed first. */
export const withScreen = (screens: readonly ScreenSide[], side: ScreenSide): ScreenSide[] =>
  SCREEN_SIDES.filter((s) => s === side || screens.includes(s));

/** `--numstat` lines → per-file counts; a binary file counts as a file with no lines. */
export const parseNumstat = (stdout: string): CheckpointFile[] => {
  const out: CheckpointFile[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    out.push({
      path: m[3] ?? '',
      added: m[1] === '-' ? 0 : Number(m[1]),
      removed: m[2] === '-' ? 0 : Number(m[2]),
    });
  }
  return out;
};

export const sumNumstat = (
  files: readonly CheckpointFile[],
): Pick<Checkpoint, 'files' | 'added' | 'removed'> => ({
  files: files.length,
  added: files.reduce((n, f) => n + f.added, 0),
  removed: files.reduce((n, f) => n + f.removed, 0),
});

/**
 * Turn checkpoints (ADR-0020): every agent turn's workspace state, before and after, kept as commits under
 * `refs/styx/checkpoints/<session>/<turn>/{base,after}` so a turn can be diffed and reverted without a commit on
 * any branch. The user's index and HEAD are never touched: each snapshot goes through a temporary index file
 * (`GIT_INDEX_FILE`), `write-tree` and `commit-tree`.
 *
 * Turn hooks arrive fire-and-forget from SessionService; per session they run in order through a promise chain
 * so a settle never overlaps the next turn's base capture. Capture failures are logged and never break a turn.
 *
 * Screens: at each turn's start and settle a picture of the running app (`deps.screenshot`) is kept beside the
 * refs (`ScreensStore`) and named on the row (`screens`). The picture is taken inside the same queued operation,
 * after the row is inserted and published: a capture costs about what the git snapshot costs and the chain is
 * already off the turn's critical path, so awaiting it keeps a strict before → after order (and `settled()`
 * honest) with no extra bookkeeping. An app that is not running answers null, which is the normal case and
 * changes nothing; a slow source is abandoned after `captureTimeoutMs`.
 */
/** Pathspec magic that keeps secret files out of a capture (see `isSecretFile` in logger.ts for the same list). */
const SECRET_PATHSPECS = [
  ':(glob,exclude)**/.env',
  ':(glob,exclude)**/.env.*',
  ':(glob,exclude)**/*.pem',
  ':(glob,exclude)**/*.key',
  ':(glob,exclude)**/*.p12',
  ':(glob,exclude)**/*.pfx',
  ':(glob,exclude)**/id_rsa*',
  ':(glob,exclude)**/id_ed25519*',
  ':(glob,exclude)**/.npmrc',
  ':(glob,exclude)**/.netrc',
  ':(glob,exclude)**/credentials.json',
];

/**
 * `confine` for a path that may be a symlink: the parent must resolve inside the worktree and the leaf is taken
 * as-is (an agent-made `link -> /etc` is unlinked, never followed). Returns the absolute path to act on.
 */
const confineParent = (root: string, rel: string): string => {
  const parent = confine(root, dirname(rel));
  return join(parent, basename(rel));
};

export class CheckpointService {
  private readonly chains = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CheckpointServiceDeps) {}

  // --- lifecycle -----------------------------------------------------------

  /** Retention: refs of archived / deleted sessions (or vanished worktrees) go on startup and hourly. */
  start(): void {
    void this.prune().catch((e: unknown) =>
      logger.warn('checkpoint: prune failed', { error: (e as Error).message }),
    );
    if (this.timer) return;
    this.timer = setInterval(
      () =>
        void this.prune().catch((e: unknown) =>
          logger.warn('checkpoint: prune failed', { error: (e as Error).message }),
        ),
      this.deps.pruneMs ?? PRUNE_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- turn hooks ------------------------------------------------------------

  /**
   * Records the turn's baseline. Resolves once the `before` snapshot is taken (or skipped, or failed), not after
   * the screen picture: the caller hands the message to the agent only then, or the agent's first edits can land
   * before the snapshot and count as "before" (they'd be missing from the turn's changes and from Undo). Capped
   * at BASE_WAIT_MS so a wedged git can delay a turn but never stop it. Never rejects.
   */
  onTurnStarted(sessionId: SessionId, messageId: string): Promise<void> {
    let ready: () => void = () => undefined;
    const baseReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const cap = setTimeout(ready, BASE_WAIT_MS);
    cap.unref?.();
    void this.enqueue(sessionId, () => this.startTurn(sessionId, messageId, ready))
      .catch((e: unknown) =>
        logger.warn('checkpoint: turn start failed', { sessionId, error: (e as Error).message }),
      )
      .finally(() => {
        clearTimeout(cap);
        ready();
      });
    return baseReady;
  }

  onTurnSettled(sessionId: SessionId): void {
    void this.enqueue(sessionId, () => this.settleTurn(sessionId)).catch((e: unknown) =>
      logger.warn('checkpoint: turn settle failed', { sessionId, error: (e as Error).message }),
    );
  }

  /** Resolves once every queued operation for the session has run (tests and callers that must observe the row). */
  settled(sessionId: SessionId): Promise<void> {
    return (this.chains.get(sessionId) ?? Promise.resolve()).catch(() => undefined);
  }

  private enqueue(sessionId: SessionId, op: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.chains.set(sessionId, next);
    return next;
  }

  private async startTurn(sessionId: SessionId, messageId: string, onBase: () => void): Promise<void> {
    const { repos, clock } = this.deps;
    const session = repos.sessions.get(sessionId);
    if (!session) return;
    const worktree = repos.worktrees.get(session.worktreeId);
    if (!worktree || !(await this.isRepo(worktree.path))) return; // plain folder: nothing to snapshot
    const rows = repos.checkpoints.bySession(sessionId);
    const last = rows.at(-1);
    // A turn still open when the next one starts (no settle signal came) settles now, on the same snapshot; its
    // `after` picture is this turn's `before`, taken once below.
    const open = last !== undefined && last.ref === null ? last : null;
    const carried = open === null ? null : await this.settleRow(open, worktree.path, { snap: false });
    const turn = (last?.turn ?? 0) + 1;
    const baseRef = checkpointRef(sessionId, turn, 'base');
    try {
      const sha = carried ?? (await this.capture(worktree.path));
      await this.git(['update-ref', baseRef, sha], worktree.path);
    } catch (e) {
      logger.warn('checkpoint: base capture failed', { sessionId, turn, error: (e as Error).message });
      return;
    }
    const row: Checkpoint = {
      id: newId<'CheckpointId'>(),
      sessionId,
      worktreeId: worktree.id,
      turn,
      messageId,
      baseRef,
      ref: null,
      files: 0,
      added: 0,
      removed: 0,
      createdAt: clock.now(),
      settledAt: null,
      revertedAt: null,
      screens: [],
    };
    repos.checkpoints.upsert(row);
    this.publish(sessionId);
    onBase(); // the baseline is down: the agent may start; the screen picture follows
    const shot = await this.snap(session.projectId);
    if (open !== null && carried !== null) await this.attach(open, 'after', shot);
    await this.attach(row, 'before', shot);
  }

  private async settleTurn(sessionId: SessionId): Promise<void> {
    const { repos } = this.deps;
    const open = repos.checkpoints.bySession(sessionId).findLast((c) => c.ref === null);
    if (open === undefined) return;
    const worktree = repos.worktrees.get(open.worktreeId);
    if (!worktree) return;
    await this.settleRow(open, worktree.path);
  }

  /**
   * Captures `after`, fills the numstat and publishes, then keeps the `after` picture (unless the caller takes it:
   * a carried turn shares the next turn's `before`); returns the after commit (null when the capture failed).
   */
  private async settleRow(
    row: Checkpoint,
    worktreePath: string,
    opts: { snap: boolean } = { snap: true },
  ): Promise<string | null> {
    const { repos, clock, transcript } = this.deps;
    const ref = checkpointRef(row.sessionId, row.turn, 'after');
    let sha: string;
    let files: CheckpointFile[];
    try {
      sha = await this.capture(worktreePath);
      await this.git(['update-ref', ref, sha], worktreePath);
      files = await this.numstat(worktreePath, row.baseRef, ref);
    } catch (e) {
      logger.warn('checkpoint: settle capture failed', {
        sessionId: row.sessionId,
        turn: row.turn,
        error: (e as Error).message,
      });
      return null;
    }
    repos.checkpoints.upsert({ ...row, ref, ...sumNumstat(files), settledAt: clock.now() });
    this.publish(row.sessionId);
    if (files.length > 0)
      transcript.system(row.sessionId, fill(copy.checkpoints.settled, { n: row.turn, files: files.length }));
    if (opts.snap) {
      const session = repos.sessions.get(row.sessionId);
      if (session) await this.attach(row, 'after', await this.snap(session.projectId));
    }
    return sha;
  }

  // --- screens -----------------------------------------------------------------

  /** The app's picture right now, or null: nothing running (normal), a failing source, or one slower than the timeout. */
  private async snap(projectId: ProjectId): Promise<Buffer | null> {
    let timer: NodeJS.Timeout | undefined;
    // A source that rejects after the timeout has passed would otherwise surface as an unhandled rejection.
    const pending = Promise.resolve().then(() => this.deps.screenshot(projectId));
    pending.catch(() => undefined);
    try {
      const png = await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.deps.captureTimeoutMs ?? SCREEN_CAPTURE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      return png === null || png.length === 0 ? null : png;
    } catch (e) {
      logger.debug('checkpoint: screenshot skipped', { projectId, error: (e as Error).message });
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Keeps `png` as the row's `side` and names it on the row; nothing changes when there is no picture. */
  private async attach(row: Checkpoint, side: ScreenSide, png: Buffer | null): Promise<void> {
    if (png === null) return;
    const { repos, screens } = this.deps;
    try {
      await screens.putScreen(row.id, side, png);
    } catch (e) {
      logger.warn('checkpoint: could not keep screenshot', {
        checkpointId: row.id,
        side,
        error: (e as Error).message,
      });
      return;
    }
    // Re-read: the row was settled since `row` was taken, or pruned (then the file must not outlive it).
    const fresh = repos.checkpoints.get(row.id);
    if (fresh === null) {
      await screens.dropScreens(row.id).catch(() => undefined);
      return;
    }
    repos.checkpoints.upsert({ ...fresh, screens: withScreen(fresh.screens, side) });
    this.publish(fresh.sessionId);
  }

  // --- commands ----------------------------------------------------------------

  /** The turn's change: `base..after` once settled, `base` against the live worktree while the turn runs. */
  async diff(checkpointId: string): Promise<CheckpointDiff> {
    const { repos } = this.deps;
    const cp =
      repos.checkpoints.get(checkpointId) ?? fail('not-found', `checkpoint ${checkpointId} not found`);
    const worktree = repos.worktrees.get(cp.worktreeId) ?? fail('not-found', 'worktree missing');
    const path = worktree.path;
    if (cp.ref !== null) {
      const files = await this.numstat(path, cp.baseRef, cp.ref);
      const r = await this.git(['diff', '--no-color', '--no-renames', '-U3', cp.baseRef, cp.ref], path);
      return { patch: r.stdout, files };
    }
    return this.withTempIndex(path, async (env) => {
      const stat = await this.git(['diff', '--cached', '--numstat', '--no-renames', cp.baseRef], path, {
        env,
      });
      const r = await this.git(['diff', '--cached', '--no-color', '--no-renames', '-U3', cp.baseRef], path, {
        env,
      });
      return { patch: r.stdout, files: parseNumstat(stat.stdout) };
    });
  }

  /**
   * Undoes this turn's own changes and nothing else (issue #1): the turn's reverse diff (`after` → `base`) is
   * applied to the worktree as it is now, so later turns and the person's own edits stay. The reverse patch is
   * applied with a 3-way fallback to a temporary index holding the live worktree; only when every file applies
   * cleanly is the result written back (`restore`), so a conflict changes nothing and is refused with the files
   * named. For the latest turn with nothing after it the result is the old "restore to before the turn". The
   * index and HEAD stay as they are. Only this turn is marked reverted; the agent is told (`tell`), and the hunks
   * are re-scanned.
   */
  async revert(checkpointId: string): Promise<void> {
    const { repos, clock } = this.deps;
    const cp =
      repos.checkpoints.get(checkpointId) ?? fail('not-found', `checkpoint ${checkpointId} not found`);
    const session = repos.sessions.get(cp.sessionId) ?? fail('not-found', 'session missing');
    if (session.state === 'working' || session.state === 'needs-you')
      fail('invalid-transition', 'The agent is still working. Wait for the turn to finish before reverting.');
    // Reverting twice would apply the reverse patch again (or fail): say so instead.
    if (cp.revertedAt !== null) fail('invalid-transition', 'This turn was already reverted.');
    const worktree = repos.worktrees.get(cp.worktreeId) ?? fail('not-found', 'worktree missing');
    await this.enqueue(cp.sessionId, async () => {
      // The click may land after a queued message started the next turn: check again inside the queue, and
      // never rewrite a worktree another live session is working in.
      const live = repos.sessions.get(cp.sessionId);
      if (live && (live.state === 'working' || live.state === 'needs-you'))
        fail(
          'invalid-transition',
          'The agent is still working. Wait for the turn to finish before reverting.',
        );
      const other = repos.sessions
        .byProject(session.projectId)
        .find((s) => s.id !== cp.sessionId && s.worktreeId === cp.worktreeId && s.state !== 'done');
      if (other) fail('invalid-transition', `Another session (${other.agent}) is working in this worktree.`);
      const path = worktree.path;
      const base = await this.resolve(path, cp.baseRef);
      if (base === null) fail('git-error', `checkpoint ${cp.baseRef} is gone`);
      // A turn that never settled (no settle signal) ends now: everything since its base is its change.
      const after = cp.ref === null ? await this.tryCapture(path) : await this.resolve(path, cp.ref);
      if (after === null) fail('git-error', `checkpoint ${cp.ref ?? cp.baseRef} is gone`);
      let undone: UndoTree;
      try {
        undone = await this.undoTree(path, after, base);
      } catch (e) {
        fail('git-error', (e as Error).message);
      }
      if (!undone.ok)
        fail(
          'invalid-transition',
          fill(copy.checkpoints.revertConflict, { n: cp.turn, files: undone.files.join(', ') }),
          { reason: 'conflict', files: undone.files },
        );
      try {
        await this.restore(path, undone.tree);
      } catch (e) {
        fail('git-error', (e as Error).message);
      }
      const fresh = repos.checkpoints.get(cp.id);
      if (fresh !== null) repos.checkpoints.upsert({ ...fresh, revertedAt: clock.now() });
      this.publish(cp.sessionId);
      // In the chat, and owed to the agent ahead of its next turn: its own turn is no longer in the files.
      this.deps.tell(cp.sessionId, fill(copy.checkpoints.revertDone, { n: cp.turn }));
    });
    await this.deps.rescanHunks(cp.sessionId).catch(() => undefined);
  }

  /** Drops refs, rows and screenshots of sessions that are gone or archived, or whose worktree no longer exists. */
  async prune(): Promise<void> {
    const { repos, screens } = this.deps;
    const dropped = new Set<string>();
    const keep = (sessionId: string): boolean => {
      const session = repos.sessions.get(sessionId);
      if (!session || session.archivedAt !== null) return false;
      const worktree = repos.worktrees.get(session.worktreeId);
      return worktree !== null && existsSync(worktree.path);
    };
    // Refs live in each project's repo (a linked worktree shares its refs with the main checkout).
    for (const project of repos.projects.all()) {
      if (!existsSync(project.path) || !(await this.isRepo(project.path))) continue;
      const r = await this.git(
        ['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_ROOT}/`],
        project.path,
        { reject: false },
      );
      for (const ref of r.stdout.split('\n').filter(Boolean)) {
        const sessionId = ref.slice(CHECKPOINT_REF_ROOT.length + 1).split('/')[0] ?? '';
        if (sessionId === '' || keep(sessionId)) continue;
        await this.git(['update-ref', '-d', ref], project.path, { reject: false });
        dropped.add(sessionId);
      }
    }
    for (const sessionId of repos.checkpoints.sessionIds()) {
      if (keep(sessionId)) continue;
      for (const row of repos.checkpoints.bySession(sessionId)) {
        repos.checkpoints.remove(row.id);
        await screens.dropScreens(row.id);
      }
      dropped.add(sessionId);
    }
    for (const sessionId of dropped) this.publish(sessionId as SessionId);
    if (dropped.size > 0) logger.info('checkpoint: pruned sessions', { count: dropped.size });
    // Pictures are the bulk (a Retina phone shot is megabytes): a live session keeps them for its newest turns
    // only; the rows and refs of older turns stay, so Review still shows the patch.
    for (const sessionId of repos.checkpoints.sessionIds()) {
      const withScreens = repos.checkpoints
        .bySession(sessionId)
        .filter((c) => c.screens.length > 0)
        .sort((a, b) => b.turn - a.turn);
      let trimmed = false;
      for (const row of withScreens.slice(SCREENS_KEEP_TURNS)) {
        await screens.dropScreens(row.id);
        repos.checkpoints.upsert({ ...row, screens: [] });
        trimmed = true;
      }
      if (trimmed) this.publish(sessionId as SessionId);
    }
  }

  // --- git mechanics -----------------------------------------------------------

  /**
   * A commit of the worktree as it is now (tracked + untracked, ignores honoured), written through a temporary
   * index so the user's index is untouched; HEAD is its parent when there is one so `git diff` between
   * checkpoints reads like any range.
   */
  async capture(worktreePath: string): Promise<string> {
    return this.withTempIndex(worktreePath, async (env) => {
      const tree = (await this.git(['write-tree'], worktreePath, { env })).stdout.trim();
      const head = await this.resolve(worktreePath, 'HEAD');
      const commit = await this.git(
        [
          ...COMMIT_CONFIG,
          'commit-tree',
          tree,
          ...(head === null ? [] : ['-p', head]),
          '-m',
          'styx checkpoint',
        ],
        worktreePath,
      );
      return commit.stdout.trim();
    });
  }

  private async tryCapture(worktreePath: string): Promise<string | null> {
    try {
      return await this.capture(worktreePath);
    } catch (e) {
      logger.warn('checkpoint: capture failed', { error: (e as Error).message });
      return null;
    }
  }

  /**
   * The worktree as it is now with one turn's change taken out: `diff after base` (written by git to a file, so no
   * byte is re-encoded on the way) applied with `apply --cached --3way` to a temporary index holding the live
   * worktree. git apply is all-or-nothing; a 3-way merge that leaves unmerged entries is a conflict too. Either
   * way the files are named and nothing is written; when it applies, the resulting tree is returned for `restore`.
   */
  private async undoTree(worktreePath: string, after: string, base: string): Promise<UndoTree> {
    const names = await this.git(['diff', '--name-only', '--no-renames', '-z', after, base], worktreePath);
    const touched = names.stdout.split('\0').filter(Boolean);
    return this.withTempIndex(worktreePath, async (env) => {
      if (touched.length > 0) {
        const dir = await mkdtemp(join(tmpdir(), 'styx-undo-'));
        try {
          const patch = join(dir, 'undo.patch');
          // Explicit prefixes and no textconv / external diff: a user's diff config must not change the patch.
          await this.git(
            [
              'diff',
              '--binary',
              '--full-index',
              '--no-renames',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              '--no-relative',
              '--src-prefix=a/',
              '--dst-prefix=b/',
              `--output=${patch}`,
              after,
              base,
            ],
            worktreePath,
          );
          const index = env['GIT_INDEX_FILE'] ?? '';
          const clean = join(dir, 'clean-index');
          await copyFile(index, clean);
          const r = await this.apply(worktreePath, patch, index, null);
          if (r !== 0)
            return { ok: false, files: await this.conflictFiles(worktreePath, patch, clean, touched) };
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      const tree = (await this.git(['write-tree'], worktreePath, { env })).stdout.trim();
      return { ok: true, tree };
    });
  }

  /** `git apply --cached --3way` of the patch (or one path of it) to the index file; exit 1 also means conflicts. */
  private async apply(
    worktreePath: string,
    patch: string,
    index: string,
    only: string | null,
  ): Promise<number> {
    const include = only === null ? [] : [`--include=${only.replace(/[*?[\\]/g, (c) => `\\${c}`)}`];
    const r = await this.git(
      ['apply', '--cached', '--3way', '--whitespace=nowarn', ...include, patch],
      worktreePath,
      { env: { GIT_INDEX_FILE: index }, reject: false },
    );
    return r.exitCode;
  }

  /**
   * Which files stop an undo: git apply stops at the first file it cannot apply, so each path of the patch is tried
   * on its own against a fresh copy of the live index. Only reached when the whole patch failed.
   */
  private async conflictFiles(
    worktreePath: string,
    patch: string,
    clean: string,
    touched: readonly string[],
  ): Promise<string[]> {
    const probe = `${clean}.probe`;
    const files: string[] = [];
    for (const path of touched) {
      await copyFile(clean, probe);
      if ((await this.apply(worktreePath, patch, probe, path)) !== 0) files.push(path);
    }
    return files.length > 0 ? files.sort() : [...touched];
  }

  /**
   * Runs `fn` with a temporary index that holds the working tree exactly: seeded from HEAD (so tracked files that
   * an ignore rule happens to match stay tracked), then `add -A` for every modification, addition and deletion.
   */
  private async withTempIndex<T>(
    worktreePath: string,
    fn: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'styx-checkpoint-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    try {
      if ((await this.resolve(worktreePath, 'HEAD')) !== null)
        await this.git(['read-tree', 'HEAD'], worktreePath, { env });
      // Secret files by convention never become blobs in the shared .git, even when the repo forgot to ignore
      // them (a checkpoint ref is local, but `push --mirror` / `bundle --all` would carry it).
      await this.git(['add', '-A', '--', '.', ...SECRET_PATHSPECS], worktreePath, { env });
      return await fn(env);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async numstat(worktreePath: string, from: string, to: string): Promise<CheckpointFile[]> {
    const r = await this.git(['diff', '--numstat', '--no-renames', from, to], worktreePath);
    return parseNumstat(r.stdout);
  }

  /** Writes a captured tree back over the working tree (the merge resolver's Undo; ADR-0025 phase B). */
  restoreTree(worktreePath: string, rev: string): Promise<void> {
    return this.restore(worktreePath, rev);
  }

  /**
   * Working tree → `base`: name-status of the live tree (temp index) against base decides each path — `A` (not in
   * base) is deleted, `M` / `D` are written back from base. Only paths that differ are touched, and every one
   * is confined to the worktree before anything is removed.
   */
  private async restore(worktreePath: string, base: string): Promise<void> {
    // Two passes. First every modified / deleted path is written back from base — that also restores the
    // base's ignore rules (.gitignore, .git/info/exclude). Only then is the live tree re-read against base to
    // find what is genuinely new: a file the turn merely un-ignored (a .env it took out of .gitignore) is ignored
    // again by now and no longer shows as added, so it survives. Every path is validated before anything moves.
    const nameStatus = async (): Promise<{ added: string[]; other: string[] }> => {
      const status = await this.withTempIndex(worktreePath, (env) =>
        this.git(['diff', '--cached', '--name-status', '--no-renames', '-z', base], worktreePath, { env }),
      );
      const parts = status.stdout.split('\0');
      const added: string[] = [];
      const other: string[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const kind = parts[i] ?? '';
        const rel = parts[i + 1] ?? '';
        if (rel === '') continue;
        (kind.startsWith('A') ? added : other).push(rel);
      }
      return { added, other };
    };
    const first = await nameStatus();
    if (first.other.length > 0) {
      for (const rel of first.other) confineParent(worktreePath, rel);
      await this.git(
        [
          '--literal-pathspecs',
          'restore',
          `--source=${base}`,
          '--worktree',
          '--no-overlay',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        worktreePath,
        { input: `${first.other.join('\0')}\0` },
      );
    }
    const second = await nameStatus();
    const doomed = second.added.map((rel) => confineParent(worktreePath, rel));
    for (const abs of doomed) await rm(abs, { force: true });
  }

  private async resolve(worktreePath: string, rev: string): Promise<string | null> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], worktreePath, {
      reject: false,
    });
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  }

  private async isRepo(path: string): Promise<boolean> {
    const r = await this.git(['rev-parse', '--is-inside-work-tree'], path, { reject: false });
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  }

  private git(
    args: string[],
    cwd: string,
    opts: { reject?: boolean; input?: string; env?: Record<string, string> } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.deps.git.run(args, cwd, opts);
  }

  private publish(sessionId: SessionId): void {
    this.deps.publisher.checkpointsReplace(sessionId, this.deps.repos.checkpoints.bySession(sessionId));
  }
}
