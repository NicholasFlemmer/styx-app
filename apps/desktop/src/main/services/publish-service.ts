import { execa } from 'execa';
import { basename, dirname } from 'node:path';
import {
  AGENT_LABEL,
  copy,
  fill,
  parseUnifiedDiff,
  type Agent,
  type Grant,
  type ProjectId,
  type Target,
  type Worktree,
  type WorktreePr,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import { STRIPPED_ENV } from '../providers/cli-runner';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import type { AuditService } from './audit-service';
import { findOnPath } from './detect-service';
import type { GitService, GitStatus } from './git';
import type { GrantService } from './grant-service';
import { isSecretFile, logger, redactArgv, redactPatch } from './logger';

export type PublishStep = 'commit' | 'push' | 'pr';
export type MessageKind = 'commit' | 'pr';

export interface PublishMessage {
  title: string;
  body: string;
}

export interface PublishResult {
  commit: string | null;
  pushed: boolean;
  pr: { number: number; url: string } | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  /** Extra environment on top of the stripped process env (a grant's `GH_TOKEN`); never logged. */
  env?: Record<string, string>;
  /** Piped to stdin (the diff for the agent). */
  input?: string;
  timeoutMs: number;
}

/**
 * Runs one process by absolute path and waits for it: the agent CLI drafting a message, `gh` opening the PR.
 * Output goes back to the service and nowhere else (the agent's reply is the user's text; `gh` output can name
 * repos); only argv and the exit code are logged. Faked in tests.
 */
export type PublishExec = (file: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export interface PublishServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  git: GitService;
  grants: GrantService;
  activity: ActivityService;
  audit: AuditService;
  exec: PublishExec;
  /** The project's effective default agent and base branch (projection `projectSettingsFor`). */
  projectSettings: (projectId: string) => { defaultAgent: Agent; baseBranch: string };
  /** Where `gh` is looked up: the process PATH first (e2e's fake bin dir), then the login shell's. */
  loginPath: () => Promise<string>;
  /** The process env whose PATH is searched first (default `process.env`; tests point it at a temp bin). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** How long the headless agent gets for a draft (60 s). */
  draftTimeoutMs?: number;
  /** How long one `gh` call gets (30 s). */
  ghTimeoutMs?: number;
}

/** The diff handed to the agent is capped here (numstat block + patch), so a big rename never blows the prompt. */
export const DRAFT_DIFF_LIMIT = 60_000;
const TITLE_MAX = 72;
const DRAFT_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;

/** Non-interactive `gh`: no prompts, no update nag, no colour. */
const GH_ENV: Record<string, string> = {
  NO_COLOR: '1',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PAGER: 'cat',
};
/** The agent CLI: plain output, no terminal tricks. */
const AGENT_ENV: Record<string, string> = { NO_COLOR: '1', TERM: 'dumb' };

/** How `gh` was authorised for a publish: a grant on the project's GitHub target, or the user's own login. */
type GhAccess =
  { kind: 'grant'; grant: Grant; target: Target; env: Record<string, string> } | { kind: 'own' };

interface FileStat {
  path: string;
  added: number;
  removed: number;
}

/**
 * Commit, push and pull request in one step (owner request, modelled on t3code; ADR-0021).
 *
 * `generateMessage` asks the project's default agent — headless, `claude -p` / `codex exec` — for a commit message
 * or a PR title and body from the diff, and falls back to a plain message drafted from the file list when the
 * agent is missing, slow or wrong. This spends one prompt of the user's own subscription per draft, which is the
 * intended trade (the message is editable before anything is sent).
 *
 * `publish` runs the steps up to `through` and reuses what is already done: a clean tree skips the commit, a
 * branch already on its upstream skips the push, an open PR for the branch is returned rather than duplicated.
 * `gh` runs under a `write` grant on the project's GitHub target when one is connected (the same request → issue
 * → use → audit path an agent's shim call takes, with the grant's token in the env, never on argv); without a
 * target it runs with the user's own `gh` login, and the activity row says so.
 */
export class PublishService {
  constructor(private readonly deps: PublishServiceDeps) {}

  // --- message draft ---------------------------------------------------------

  async generateMessage(worktreeId: string, kind: MessageKind): Promise<PublishMessage> {
    const wt = this.requireWorktree(worktreeId);
    const branch = wt.branch ?? fail('invalid-input', copy.publish.noBranch);
    const settings = this.deps.projectSettings(wt.projectId);
    const { stats, patch } = await this.changes(wt, kind);
    const fallback = fallbackDraft(stats, kind, branch);
    if (stats.length === 0) return fallback;
    const agent = settings.defaultAgent;
    const cli = this.deps.repos.discovery.cli(agent);
    const binary = cli?.binary ?? null;
    const invocation = binary === null ? null : agentInvocation(agent, binary, kind);
    if (invocation === null) {
      logger.info('publish: no headless agent for the draft, using the file list', { agent });
      return fallback;
    }
    // Secret files are out of the diff entirely and secret-bearing lines are masked, *before* the cut so a key
    // straddling the limit cannot lose the line that would have matched it.
    const stdin = draftInput(branch, settings.baseBranch, stats, redactPatch(patch));
    let r: ExecResult;
    try {
      r = await this.deps.exec(invocation.file, invocation.args, {
        cwd: wt.path,
        env: AGENT_ENV,
        input: stdin,
        timeoutMs: this.deps.draftTimeoutMs ?? DRAFT_TIMEOUT_MS,
      });
    } catch (e) {
      logger.warn('publish: agent draft failed to start', { agent, error: (e as Error).message });
      return fallback;
    }
    if (r.timedOut || r.exitCode !== 0) {
      logger.warn('publish: agent draft failed', { agent, exitCode: r.exitCode, timedOut: r.timedOut });
      return fallback;
    }
    const text = invocation.parse(r.stdout);
    const parsed = text === null ? null : parseDraft(text);
    if (parsed === null) {
      logger.warn('publish: agent draft unreadable, using the file list', { agent });
      return fallback;
    }
    return parsed;
  }

  // --- publish ---------------------------------------------------------------

  async publish(
    worktreeId: string,
    opts: { through: PublishStep; message: PublishMessage; draft: boolean },
  ): Promise<PublishResult> {
    const holder = { access: null as GhAccess | null };
    try {
      return await this.publishSteps(worktreeId, opts, holder);
    } finally {
      // The grant was minted for this click; nothing (no agent, no later click) may ride on it afterwards.
      const access = holder.access;
      if (access !== null && access.kind === 'grant' && access.grant.duration !== 'always') {
        try {
          this.deps.grants.revoke(access.grant.id, 'worktree.publish', 'policy');
        } catch (e) {
          logger.warn('publish: could not revoke the step grant', { error: (e as Error).message });
        }
      }
    }
  }

  private async publishSteps(
    worktreeId: string,
    opts: { through: PublishStep; message: PublishMessage; draft: boolean },
    holder: { access: GhAccess | null },
  ): Promise<PublishResult> {
    const { git, repos, publisher } = this.deps;
    const wt = this.requireWorktree(worktreeId);
    const branch = wt.branch ?? fail('invalid-input', copy.publish.noBranch);
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    const settings = this.deps.projectSettings(wt.projectId);
    const result: PublishResult = { commit: null, pushed: false, pr: null };
    let access: GhAccess | null = null;
    const done: string[] = [];
    // What cannot work is refused before anything is committed: no remote to push to, main asked for a PR.
    if (opts.through === 'pr' && (wt.isMain || branch === settings.baseBranch))
      fail('invalid-input', copy.publish.mainNoPr);
    const remotes = opts.through === 'commit' ? [] : await git.remotes(wt.path);
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    if (opts.through !== 'commit' && remote === undefined) fail('invalid-input', copy.publish.noRemote);

    // 1. commit — everything, untracked included; a clean tree is not an error, it is a step already done.
    const status = await git.status(wt.path).catch((e: Error) => fail('git-error', e.message));
    if (!status.clean) {
      const text = commitText(opts.message);
      try {
        // Stage by name, never `.`: a secret file (.env, a key) stays out of an app-driven commit even when the
        // repo forgot to ignore it. Deleted paths are staged too (`add -A` on a named path records deletions).
        const staged = statusPaths(status).filter((p) => !isSecretFile(p));
        const skipped = statusPaths(status).filter((p) => isSecretFile(p));
        if (skipped.length > 0)
          logger.info('publish: secret files left unstaged', { count: skipped.length, files: skipped });
        if (staged.length === 0) fail('invalid-input', copy.publish.nothingToCommit);
        await git.add(wt.path, staged);
        await git.commit(wt.path, text, { asUser: true });
      } catch (e) {
        fail(
          'git-error',
          fill(copy.publish.failed, { step: copy.publish.through.commit, error: (e as Error).message }),
        );
      }
      result.commit = await git.headCommit(wt.path);
      await this.refreshHead(wt);
      done.push(fill(copy.publish.steps.commit, { commit: shortSha(result.commit) }));
    }
    if (opts.through === 'commit') {
      this.noteActivity(project.id, project.name, branch, done, null);
      return result;
    }

    // 2. push — `-u origin <branch>`; skipped when the upstream already has everything.
    if (remote === undefined) fail('invalid-input', copy.publish.noRemote);
    const fresh = await git.status(wt.path);
    const upToDate = fresh.upstream !== null && fresh.ahead === 0 && result.commit === null;
    if (!upToDate) {
      access = await this.githubAccess(wt, project.id, branch);
      holder.access = access;
      // The grant's token rides along only where it can be used: an https github.com remote. An ssh remote goes
      // through the user's agent as it always did.
      const token =
        access.kind === 'grant' && remote.host === 'github' && /^https:\/\//i.test(remote.url)
          ? access.env['GH_TOKEN']
          : undefined;
      const use =
        access.kind === 'grant'
          ? this.deps.grants.use(access.grant.id, {
              command: `git push -u ${remote.name} ${branch}`,
              scopeUsed: 'write',
              via: 'app',
              sessionId: null,
            })
          : null;
      try {
        await git.push(wt.path, remote.name, branch, token === undefined ? {} : { token });
      } catch (e) {
        if (use !== null) this.deps.grants.endUse(use.useId, 1);
        fail(
          'git-error',
          fill(copy.publish.failed, { step: copy.publish.through.push, error: (e as Error).message }),
        );
      }
      if (use !== null) this.deps.grants.endUse(use.useId, 0);
      done.push(copy.publish.steps.push);
    }
    result.pushed = true;
    if (opts.through === 'push') {
      this.noteActivity(project.id, project.name, branch, done, access);
      return result;
    }

    // 3. pull request — an open one for the branch is reused, never duplicated.
    access ??= await this.githubAccess(wt, project.id, branch);
    holder.access = access;
    const existing = await this.findPr(access, wt, branch);
    let pr: WorktreePr;
    if (existing !== null) {
      pr = existing;
      logger.info('publish: reusing the open pull request', { branch, number: pr.number });
    } else {
      pr = await this.createPr(access, wt, branch, settings.baseBranch, opts.message, opts.draft);
      const row = this.deps.audit.append({
        actorKind: 'you',
        actorLabel: 'you',
        action: 'opened-pr',
        projectId: project.id,
        worktreeId: wt.id,
        worktreeLabel: branch,
        ...(access.kind === 'grant'
          ? {
              targetId: access.target.id,
              targetLabel: `${access.target.name} ${access.target.env}`,
              grantId: access.grant.id,
            }
          : {}),
        triggeredBy: 'worktree.publish',
        detail: {
          prNumber: pr.number,
          url: pr.url,
          draft: opts.draft,
          via: access.kind === 'grant' ? 'grant' : 'own-gh-login',
        },
      });
      publisher.upsert('auditEntries', [row.id]);
      done.push(fill(copy.publish.steps.pr, { number: pr.number }));
    }
    const current = repos.worktrees.get(wt.id) ?? wt;
    repos.worktrees.upsert({ ...current, pr });
    publisher.upsert('worktrees', [wt.id]);
    result.pr = { number: pr.number, url: pr.url ?? '' };
    this.noteActivity(project.id, project.name, branch, done, access);
    return result;
  }

  // --- gh ----------------------------------------------------------------------

  /**
   * A `write` grant on the project's GitHub target, minted the way an agent's `gh` call would be (policy, audit,
   * token in env only). No connected target → the user's own `gh` login, which the result and the activity say.
   */
  private async githubAccess(wt: Worktree, projectId: string, branch: string): Promise<GhAccess> {
    // The same choice the broker makes for an agent's `gh`: a connected GitHub target of this project, non-prod
    // first (a prod target would force an ask the button cannot answer).
    const candidates = this.deps.repos.targets
      .all()
      .filter((t) => t.provider === 'github' && t.credentialRef !== null && t.projectId === projectId);
    const target = candidates.find((t) => t.env !== 'prod') ?? candidates[0] ?? null;
    if (target === null) return { kind: 'own' };
    const outcome = await this.deps.grants
      .request({
        sessionId: null,
        targetId: target.id,
        scope: ['write'],
        reason: fill(copy.publish.grantReason, { branch }),
        triggeredBy: 'worktree.publish',
        worktreeId: wt.id,
      })
      .catch((e: Error) => {
        // A user decision needs a session to ask in; the button has none, so the policy answer is final here.
        if (/needs a session/.test(e.message)) return fail('forbidden', copy.publish.needsApproval);
        throw e;
      });
    if (outcome.kind === 'denied') fail('forbidden', copy.publish.denied);
    if (outcome.kind !== 'active') fail('invalid-transition', copy.publish.needsApproval);
    const cred = await this.deps.grants.credentialFor(outcome.grant.id);
    return { kind: 'grant', grant: outcome.grant, target, env: cred.env };
  }

  private async gh(access: GhAccess, cwd: string, args: string[]): Promise<ExecResult> {
    const file = await this.ghBinary();
    if (file === null) fail('cli-missing', fill(copy.deploy.cliMissing, { bin: 'gh' }));
    // The persisted use / audit label goes through `redactArgv`: a PR body is collateral (its value is dropped),
    // and a token shape anywhere is masked.
    const use =
      access.kind === 'grant'
        ? this.deps.grants.use(access.grant.id, {
            command: redactArgv(['gh', ...args]).join(' '),
            scopeUsed: args[0] === 'pr' && args[1] === 'view' ? 'read' : 'write',
            via: 'app',
            sessionId: null,
          })
        : null;
    const r = await this.deps.exec(file, args, {
      cwd,
      env: { ...GH_ENV, ...(access.kind === 'grant' ? access.env : {}) },
      timeoutMs: this.deps.ghTimeoutMs ?? GH_TIMEOUT_MS,
    });
    if (use !== null) this.deps.grants.endUse(use.useId, r.exitCode);
    logger.debug('publish: gh ran', { args, exitCode: r.exitCode, via: access.kind });
    return r;
  }

  /** `gh pr view <branch>`: the open (or draft) PR whose head is the branch, or null (none, or merged/closed). */
  private async findPr(access: GhAccess, wt: Worktree, branch: string): Promise<WorktreePr | null> {
    const r = await this.gh(access, wt.path, ['pr', 'view', branch, '--json', 'number,url,state,isDraft']);
    if (r.exitCode !== 0) return null;
    let body: { number?: unknown; url?: unknown; state?: unknown; isDraft?: unknown };
    try {
      body = JSON.parse(r.stdout) as typeof body;
    } catch {
      return null;
    }
    if (typeof body.number !== 'number' || body.state !== 'OPEN') return null;
    return {
      number: body.number,
      state: body.isDraft === true ? 'draft' : 'open',
      url: typeof body.url === 'string' ? body.url : null,
    };
  }

  private async createPr(
    access: GhAccess,
    wt: Worktree,
    branch: string,
    base: string,
    message: PublishMessage,
    draft: boolean,
  ): Promise<WorktreePr> {
    const title = message.title.trim().slice(0, TITLE_MAX * 2) || branch;
    const args = ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', message.body];
    if (draft) args.push('--draft');
    const r = await this.gh(access, wt.path, args);
    if (r.exitCode !== 0)
      fail(
        'provider-error',
        fill(copy.publish.failed, {
          step: copy.publish.through.pr,
          error: r.timedOut
            ? 'gh timed out'
            : r.stderr.trim() || r.stdout.trim() || `gh exited ${r.exitCode}`,
        }),
      );
    const url = parsePrUrl(`${r.stdout}\n${r.stderr}`);
    if (url === null)
      fail(
        'provider-error',
        fill(copy.publish.failed, { step: copy.publish.through.pr, error: 'gh printed no pull request URL' }),
      );
    return { number: url.number, state: draft ? 'draft' : 'open', url: url.url };
  }

  private async ghBinary(): Promise<string | null> {
    const platform = this.deps.platform ?? process.platform;
    return (
      findOnPath('gh', (this.deps.env ?? process.env)['PATH'] ?? '', platform) ??
      findOnPath('gh', await this.deps.loginPath(), platform)
    );
  }

  // --- helpers -------------------------------------------------------------------

  private requireWorktree(id: string): Worktree {
    const wt = this.deps.repos.worktrees.get(id) ?? fail('not-found', `worktree ${id} not found`);
    if (wt.archivedAt !== null) fail('invalid-input', `worktree ${id} is archived`);
    return wt;
  }

  /**
   * What the draft describes: for a commit the uncommitted changes (untracked included); for a PR the whole
   * branch against its base, working tree included. Both fall back to the other when they are empty.
   */
  private async changes(wt: Worktree, kind: MessageKind): Promise<{ stats: FileStat[]; patch: string }> {
    const { git } = this.deps;
    const head = await git.headCommit(wt.path);
    const against: string[] = [];
    const branchBase = wt.isMain ? null : wt.baseCommit;
    if (kind === 'commit') {
      if (head !== null) against.push('HEAD');
      if (branchBase !== null && branchBase !== head) against.push(branchBase);
    } else {
      if (branchBase !== null && branchBase !== head) against.push(branchBase);
      if (head !== null) against.push('HEAD');
    }
    for (const base of against) {
      let patch: string;
      try {
        patch = await git.diffWithUntracked(wt.path, base);
      } catch (e) {
        logger.warn('publish: diff failed', { base, error: (e as Error).message });
        continue;
      }
      const stats = statsOf(patch).filter((s) => !isSecretFile(s.path));
      if (stats.length > 0) return { stats, patch: stripSecretFiles(patch) };
    }
    return { stats: [], patch: '' };
  }

  private async refreshHead(wt: Worktree): Promise<void> {
    const { repos, publisher, git } = this.deps;
    const current = repos.worktrees.get(wt.id) ?? wt;
    const headCommit = await git.headCommit(wt.path);
    repos.worktrees.upsert({ ...current, headCommit, changes: { added: 0, removed: 0, files: 0 } });
    publisher.upsert('worktrees', [wt.id]);
  }

  private noteActivity(
    projectId: ProjectId,
    project: string,
    branch: string,
    done: readonly string[],
    access: GhAccess | null,
  ): void {
    if (done.length === 0) return;
    const step = [...done, ...(access?.kind === 'own' ? [copy.publish.ownAuth] : [])].join(' · ');
    this.deps.activity.append({
      who: 'you',
      what: `${project} · ${fill(copy.publish.activity, { who: '', branch, step }).trimStart()}`,
      projectId,
      sessionId: null,
    });
    logger.info('publish: done', { branch, step, via: access?.kind ?? null });
  }
}

// --- pure helpers (exported for tests) --------------------------------------------

/** Per-file `+a −r` from the patch itself (the same numbers `git diff --numstat` prints, untracked included). */
/** The paths a `git status` names (modified, added, deleted, renamed, untracked), relative to the worktree. */
export const statusPaths = (status: Pick<GitStatus, 'changed'>): string[] => [
  ...new Set(status.changed.map((f) => f.path)),
];

/** Removes every file section of a unified diff whose path is a secret file (see `isSecretFile`). */
export const stripSecretFiles = (patch: string): string => {
  const out: string[] = [];
  let skipping = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\//.exec(line);
      skipping = m?.[1] !== undefined && isSecretFile(m[1]);
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
};

export const statsOf = (patch: string): FileStat[] =>
  parseUnifiedDiff(patch).files.map((f) => ({ path: f.path, added: f.added, removed: f.removed }));

/** The text piped to the agent: branch, a numstat block, then the patch cut to the limit. */
export const draftInput = (
  branch: string,
  base: string,
  stats: readonly FileStat[],
  patch: string,
): string => {
  const head = `Branch: ${branch} (base: ${base})\n\nFiles:\n${stats
    .map((s) => `${s.path} +${s.added} -${s.removed}`)
    .join('\n')}\n\nPatch:\n`;
  const room = Math.max(0, DRAFT_DIFF_LIMIT - head.length);
  const cut =
    patch.length > room
      ? `${patch.slice(0, room)}\n[… patch truncated at ${DRAFT_DIFF_LIMIT} bytes]\n`
      : patch;
  return head + cut;
};

const PROMPTS: Record<MessageKind, string> = {
  commit:
    'Write a git commit message for the diff on stdin. Reply with the message only: a subject line of at most 72 characters in the imperative mood, then a blank line, then a short body saying what changed and why. No code fences, no preamble, no tool calls.',
  pr: 'Write a GitHub pull request title and description for the diff on stdin. Reply with the title on the first line (at most 72 characters, imperative mood), then a blank line, then the description in Markdown: a "Summary" heading with a few bullets, and a "Test plan" heading. No preamble, no tool calls, no code fence around the reply.',
};

interface AgentInvocation {
  file: string;
  args: string[];
  /** The reply text out of the CLI's structured output, or null when it cannot be read. */
  parse: (stdout: string) => string | null;
}

/**
 * How each agent runs headless for one answer. Claude: `-p --output-format json` with every tool off, so it only
 * writes; Codex: `exec --json` in the read-only sandbox, `--ephemeral` so no session is saved; Gemini: `-p` with
 * JSON output. Cursor's agent and the shell have no headless one-shot here → the file-list fallback.
 */
export const agentInvocation = (agent: Agent, binary: string, kind: MessageKind): AgentInvocation | null => {
  const prompt = PROMPTS[kind];
  switch (agent) {
    case 'claude':
      return {
        file: binary,
        args: ['-p', '--output-format', 'json', '--tools', '', prompt],
        parse: parseClaudeJson,
      };
    case 'codex':
      return {
        file: binary,
        args: ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', prompt],
        parse: parseCodexJsonl,
      };
    case 'gemini':
      return { file: binary, args: ['-p', prompt, '--output-format', 'json'], parse: parseGeminiJson };
    case 'cursor':
    case 'shell':
      return null;
  }
};

const parseClaudeJson = (stdout: string): string | null => {
  try {
    const body = JSON.parse(stdout.trim()) as { is_error?: unknown; result?: unknown };
    if (body.is_error === true || typeof body.result !== 'string') return null;
    return body.result;
  } catch {
    return null;
  }
};

const parseCodexJsonl = (stdout: string): string | null => {
  let last: string | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      if (
        ev.type === 'item.completed' &&
        ev.item?.type === 'agent_message' &&
        typeof ev.item.text === 'string'
      )
        last = ev.item.text;
    } catch {
      /* not an event line */
    }
  }
  return last;
};

const parseGeminiJson = (stdout: string): string | null => {
  try {
    const body = JSON.parse(stdout.trim()) as { response?: unknown };
    return typeof body.response === 'string' ? body.response : null;
  } catch {
    return stdout.trim() || null;
  }
};

/** Title = first non-empty line (≤72, quotes / `Subject:` prefixes dropped); body = the rest after the blank line. */
export const parseDraft = (text: string): PublishMessage | null => {
  let t = text.replace(/\r\n/g, '\n').trim();
  // A reply wrapped in one code fence is still a message.
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence?.[1] !== undefined) t = fence[1].trim();
  const lines = t.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1;
  const raw = lines[i];
  if (raw === undefined) return null;
  let title = raw
    .trim()
    .replace(/^(subject|title)\s*:\s*/i, '')
    .replace(/^#+\s*/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (title === '') return null;
  if (title.length > TITLE_MAX) title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  const body = lines
    .slice(i + 1)
    .join('\n')
    .trim();
  return { title, body };
};

/** Without an agent: "Update checkout.ts and validate.ts" / "Update 5 files in src/components", files in the body. */
export const fallbackDraft = (
  stats: readonly FileStat[],
  kind: MessageKind,
  branch: string,
): PublishMessage => {
  const body = stats.map((s) => `- ${s.path} (+${s.added} −${s.removed})`).join('\n');
  if (stats.length === 0) return { title: kind === 'pr' ? branch : 'Update', body: '' };
  const names = stats.map((s) => basename(s.path));
  let title: string;
  if (stats.length === 1) title = `Update ${stats[0]?.path ?? ''}`;
  else if (stats.length <= 3)
    title = `Update ${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
  else {
    const dir = commonDir(stats.map((s) => s.path));
    title = dir === '' ? `Update ${stats.length} files` : `Update ${stats.length} files in ${dir}`;
  }
  if (title.length > TITLE_MAX) title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return { title, body: kind === 'pr' ? `## Summary\n\n${body}` : body };
};

const commonDir = (paths: readonly string[]): string => {
  const parts = paths.map((p) =>
    dirname(p)
      .split('/')
      .filter((x) => x !== '.' && x !== ''),
  );
  const first = parts[0] ?? [];
  const common: string[] = [];
  for (let i = 0; i < first.length; i += 1) {
    const seg = first[i];
    if (seg === undefined || !parts.every((p) => p[i] === seg)) break;
    common.push(seg);
  }
  return common.join('/');
};

/** `title\n\nbody` (git's own subject / body convention); the body is optional. */
export const commitText = (m: PublishMessage): string => {
  const title = m.title.trim();
  const body = m.body.trim();
  return body === '' ? title : `${title}\n\n${body}`;
};

/** The PR URL `gh pr create` prints (`https://github.com/acme/shop/pull/7`), wherever it lands in the output. */
export const parsePrUrl = (out: string): { number: number; url: string } | null => {
  const m = /https?:\/\/\S+\/pull\/(\d+)/.exec(out);
  if (m?.[1] === undefined) return null;
  return { number: Number(m[1]), url: m[0] };
};

export const shortSha = (sha: string | null): string => (sha ?? '').slice(0, 7);

/**
 * Production `exec`: the process env minus provider tokens (`STRIPPED_ENV`, so a dev shell's `GH_TOKEN` never
 * outranks the grant's) and `ELECTRON_RUN_AS_NODE`, PATH = process PATH then the login shell's, stdin piped.
 */
export const execaPublishExec =
  (loginPath: () => Promise<string>): PublishExec =>
  async (file, args, opts) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.has(k)) env[k] = v;
    const login = await loginPath().catch(() => '');
    const sep = process.platform === 'win32' ? ';' : ':';
    env['PATH'] = [process.env['PATH'] ?? '', login].filter((p) => p !== '').join(sep);
    Object.assign(env, opts.env ?? {});
    const r = await execa(file, args, {
      cwd: opts.cwd,
      env,
      extendEnv: false,
      reject: false,
      timeout: opts.timeoutMs,
      ...(opts.input !== undefined ? { input: opts.input } : { stdin: 'ignore' }),
    });
    const exitCode = r.exitCode ?? (r.timedOut ? 124 : 1);
    logger.debug('publish: ran', {
      file: basename(file),
      args: args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}…` : a)),
      exitCode,
    });
    return {
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      exitCode,
      timedOut: r.timedOut === true,
    };
  };

/** Product name of the agent that drafts messages for a project (the modal's lead line). */
export const draftingAgentLabel = (agent: Agent): string => AGENT_LABEL[agent];
