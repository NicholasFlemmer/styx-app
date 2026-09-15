import { idFrom } from '../ids';
import type {
  AskId,
  AuditId,
  GrantId,
  HunkId,
  MessageId,
  ProjectId,
  RepoId,
  SessionId,
  TargetId,
  WorktreeId,
} from '../ids';
import { mergeSettings } from '../project-file';
import type { ActivityRow } from '../model/activity';
import type { AuditEntry } from '../model/audit';
import type { Agent, Env, Provider, Scope, TargetPolicy } from '../model/common';
import type { CliInstall, IdeInstall, SkillSummary } from '../model/discovery';
import type { Deploy, DevRun } from '../model/run';
import type { Grant } from '../model/grant';
import type { AgentChange } from '../model/hunk';
import type { Notification } from '../model/notification';
import type { Policy } from '../model/policy';
import type { Project, Repo, Worktree } from '../model/project';
import type { PendingAsk, Session, SessionState, TranscriptMessage } from '../model/session';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../model/settings';
import type { AppSettings, EffectiveProjectSettings } from '../model/settings';
import type { Target } from '../model/target';
import { BUILTIN_POLICY_IDS, defaultPolicies } from '../policy/defaults';
import type { ReadModel } from '../read-model';
import { tableFrom } from '../read-model';

/** 2026-03-12 09:43:00 UTC. Audit rows read 09:41 / 09:12 / 08:58 / 08:30 in UTC; ages read 2m / 3m / 9m. */
export const DEMO_NOW = Date.UTC(2026, 2, 12, 9, 43, 0);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): number => DEMO_NOW - ms;

/** Fixed, readable, 26-char ids (ULID-shaped) so tests and e2e can address rows. */
const fid = <T extends string>(kind: string, n: number): ReturnType<typeof idFrom<T>> =>
  idFrom<T>(`01JDEMO${kind.toUpperCase().padEnd(13, '0')}${String(n).padStart(6, '0')}`);

export const ids = {
  project: {
    acmeShop: fid<'ProjectId'>('proj', 1),
    blogV2: fid<'ProjectId'>('proj', 2),
    infraTools: fid<'ProjectId'>('proj', 3),
    clientX: fid<'ProjectId'>('proj', 4),
    sideApi: fid<'ProjectId'>('proj', 5),
  },
  repo: {
    acmeShop: fid<'RepoId'>('repo', 1),
    blogV2: fid<'RepoId'>('repo', 2),
    infraTools: fid<'RepoId'>('repo', 3),
    clientX: fid<'RepoId'>('repo', 4),
    sideApi: fid<'RepoId'>('repo', 5),
  },
  worktree: {
    acmeMain: fid<'WorktreeId'>('wt', 1),
    fixCheckout: fid<'WorktreeId'>('wt', 2),
    testFlaky: fid<'WorktreeId'>('wt', 3),
    featPromo: fid<'WorktreeId'>('wt', 4),
    blogMain: fid<'WorktreeId'>('wt', 6),
    featMdx: fid<'WorktreeId'>('wt', 7),
    infraMain: fid<'WorktreeId'>('wt', 8),
    clientMain: fid<'WorktreeId'>('wt', 9),
    sideMain: fid<'WorktreeId'>('wt', 10),
  },
  session: {
    claude: fid<'SessionId'>('sess', 1),
    codex: fid<'SessionId'>('sess', 2),
    blog: fid<'SessionId'>('sess', 3),
    gemini: fid<'SessionId'>('sess', 4),
    infra: fid<'SessionId'>('sess', 5),
    shell: fid<'SessionId'>('sess', 6),
    cursor: fid<'SessionId'>('sess', 7),
    side: fid<'SessionId'>('sess', 8),
    /** Error fixture only: a Codex session that cannot start because the CLI is missing. */
    codexMissing: fid<'SessionId'>('sess', 9),
  },
  target: {
    vercelProd: fid<'TargetId'>('tgt', 1),
    vercelPreview: fid<'TargetId'>('tgt', 2),
    supabaseProd: fid<'TargetId'>('tgt', 3),
    awsProd: fid<'TargetId'>('tgt', 4),
    github: fid<'TargetId'>('tgt', 5),
    blogVercel: fid<'TargetId'>('tgt', 6),
    blogGithub: fid<'TargetId'>('tgt', 7),
    infraAws: fid<'TargetId'>('tgt', 8),
    infraGcp: fid<'TargetId'>('tgt', 9),
    clientGcp: fid<'TargetId'>('tgt', 10),
    clientGithub: fid<'TargetId'>('tgt', 11),
    sideSupabase: fid<'TargetId'>('tgt', 12),
    blogVercelPreview: fid<'TargetId'>('tgt', 13),
  },
  grant: {
    vercelProdClaude: fid<'GrantId'>('grant', 1),
    vercelPreviewAlways: fid<'GrantId'>('grant', 2),
    supabaseCodex: fid<'GrantId'>('grant', 3),
    awsClaude: fid<'GrantId'>('grant', 4),
    vercelPreviewCursor: fid<'GrantId'>('grant', 5),
    awsGeminiExpired: fid<'GrantId'>('grant', 6),
  },
  ask: {
    codexGrant: fid<'AskId'>('ask', 1),
    blogPlan: fid<'AskId'>('ask', 2),
  },
  audit: (n: number): AuditId => fid<'AuditId'>('audit', n),
  message: (n: number): MessageId => fid<'MessageId'>('msg', n),
  hunk: (n: number): HunkId => fid<'HunkId'>('hunk', n),
  policy: BUILTIN_POLICY_IDS,
} as const;

// --- Projects ---------------------------------------------------------------

const project = (
  id: ProjectId,
  name: string,
  initials: string,
  path: string,
  railOrder: number,
  last: number,
): Project => ({
  id,
  name,
  path,
  initials,
  railOrder,
  hasProjectFile: name === 'acme-shop',
  createdAt: ago(30 * DAY),
  lastActivityAt: last,
  removedAt: null,
});

export const demoProjects = (): Project[] => [
  project(ids.project.acmeShop, 'acme-shop', 'AS', '~/code/acme-shop', 0, ago(2 * MIN)),
  project(ids.project.blogV2, 'blog-v2', 'BL', '~/code/blog-v2', 1, ago(9 * MIN)),
  project(ids.project.infraTools, 'infra-tools', 'IN', '~/code/infra-tools', 2, ago(31 * MIN)),
  project(ids.project.clientX, 'client-x', 'CX', '~/work/client-x', 3, ago(1 * HOUR)),
  project(ids.project.sideApi, 'side-api', 'SA', '~/code/side-api', 4, ago(2 * DAY)),
];

const repo = (id: RepoId, projectId: ProjectId, remote: string | null, behind = 0): Repo => ({
  id,
  projectId,
  defaultBranch: 'main',
  remotes: remote === null ? [] : [{ name: 'origin', url: remote }],
  ahead: 0,
  behind,
  fetchedAt: ago(5 * MIN),
  lineEndings: 'auto',
  longPaths: false,
});

export const demoRepos = (): Repo[] => [
  repo(ids.repo.acmeShop, ids.project.acmeShop, 'https://github.com/acme/shop', 2),
  repo(ids.repo.blogV2, ids.project.blogV2, 'https://github.com/acme/blog-v2'),
  repo(ids.repo.infraTools, ids.project.infraTools, 'https://github.com/acme/infra-tools'),
  repo(ids.repo.clientX, ids.project.clientX, 'https://gitlab.com/client-x/app'),
  repo(ids.repo.sideApi, ids.project.sideApi, null),
];

const worktree = (
  id: WorktreeId,
  repoId: RepoId,
  projectId: ProjectId,
  branch: string,
  extra: Partial<Worktree> = {},
): Worktree => ({
  id,
  repoId,
  projectId,
  branch,
  path:
    branch === 'main'
      ? `~/code/${projectOfRepo(repoId)}`
      : `~/code/.styx/worktrees/${projectOfRepo(repoId)}/${branch.replace('/', '-')}`,
  isMain: branch === 'main',
  owner: { kind: 'user' },
  baseCommit: 'a1b2c3d',
  headCommit: 'a1b2c3d',
  changes: { added: 0, removed: 0, files: 0 },
  pr: null,
  conflict: null,
  mergedAt: null,
  createdAt: ago(3 * DAY),
  archivedAt: null,
  ...extra,
});

const projectOfRepo = (repoId: RepoId): string =>
  ({
    [ids.repo.acmeShop]: 'acme-shop',
    [ids.repo.blogV2]: 'blog-v2',
    [ids.repo.infraTools]: 'infra-tools',
    [ids.repo.clientX]: 'client-x',
    [ids.repo.sideApi]: 'side-api',
  })[repoId] ?? 'unknown';

export const demoWorktrees = (): Worktree[] => [
  worktree(ids.worktree.acmeMain, ids.repo.acmeShop, ids.project.acmeShop, 'main'),
  worktree(ids.worktree.fixCheckout, ids.repo.acmeShop, ids.project.acmeShop, 'fix/checkout', {
    owner: { kind: 'session', sessionId: ids.session.claude },
    changes: { added: 142, removed: 38, files: 3 },
    pr: { number: 214, state: 'draft', url: 'https://github.com/acme/shop/pull/214' },
    headCommit: 'f1e2d3c',
    createdAt: ago(40 * MIN),
  }),
  worktree(ids.worktree.testFlaky, ids.repo.acmeShop, ids.project.acmeShop, 'test/flaky', {
    owner: { kind: 'session', sessionId: ids.session.codex },
    changes: { added: 12, removed: 4, files: 1 },
    headCommit: 'b4c5d6e',
    createdAt: ago(25 * MIN),
  }),
  worktree(ids.worktree.featPromo, ids.repo.acmeShop, ids.project.acmeShop, 'feat/promo', {
    owner: { kind: 'session', sessionId: ids.session.cursor },
    changes: { added: 88, removed: 12, files: 5 },
    pr: { number: 212, state: 'merged', url: 'https://github.com/acme/shop/pull/212' },
    mergedAt: ago(1 * DAY),
    createdAt: ago(2 * DAY),
  }),
  worktree(ids.worktree.blogMain, ids.repo.blogV2, ids.project.blogV2, 'main'),
  worktree(ids.worktree.featMdx, ids.repo.blogV2, ids.project.blogV2, 'feat/mdx', {
    owner: { kind: 'session', sessionId: ids.session.blog },
    changes: { added: 61, removed: 9, files: 4 },
    createdAt: ago(1 * HOUR),
  }),
  worktree(ids.worktree.infraMain, ids.repo.infraTools, ids.project.infraTools, 'main', {
    owner: { kind: 'session', sessionId: ids.session.infra },
  }),
  worktree(ids.worktree.clientMain, ids.repo.clientX, ids.project.clientX, 'main', {
    owner: { kind: 'session', sessionId: ids.session.shell },
  }),
  worktree(ids.worktree.sideMain, ids.repo.sideApi, ids.project.sideApi, 'main', {
    owner: { kind: 'session', sessionId: ids.session.side },
  }),
];

// --- Sessions ---------------------------------------------------------------

const session = (
  id: SessionId,
  projectId: ProjectId,
  worktreeId: WorktreeId,
  agent: Agent,
  state: SessionState,
  note: string,
  last: number | null,
  extra: Partial<Session> = {},
): Session => ({
  id,
  projectId,
  worktreeId,
  agent,
  runner: agent === 'claude' || agent === 'cursor' ? 'stream' : 'pty',
  model: null,
  permissionMode: 'default',
  effort: null,
  cliSessionId: null,
  costUsd: 0,
  numTurns: 0,
  slashCommands: [],
  state,
  pausedReason: null,
  note,
  firstMessage: null,
  toggles: { autoApproveEdits: false, mayRequestTargets: true, notifyWhenNeedsMe: true },
  pid: state === 'done' ? null : 40_000 + Number.parseInt(id.slice(-2), 10),
  exitCode: state === 'done' ? 0 : null,
  startedAt: last === null ? ago(50 * MIN) : last - 20 * MIN,
  lastActivityAt: last,
  endedAt: state === 'done' ? last : null,
  archivedAt: null,
  ...extra,
});

export const demoSessions = (): Session[] => [
  session(
    ids.session.claude,
    ids.project.acmeShop,
    ids.worktree.fixCheckout,
    'claude',
    'working',
    'Added validation, 42 tests pass. Asking to open a PR.',
    ago(14 * MIN),
    {
      firstMessage: 'Add input validation to checkout and cover it with tests.',
      startedAt: ago(40 * MIN),
    },
  ),
  session(
    ids.session.codex,
    ids.project.acmeShop,
    ids.worktree.testFlaky,
    'codex',
    'needs-you',
    'Requesting Supabase prod · read + write',
    ago(3 * MIN),
    {
      firstMessage: 'Fix the flaky order test and make sure the schema matches prod.',
      startedAt: ago(25 * MIN),
    },
  ),
  session(
    ids.session.blog,
    ids.project.blogV2,
    ids.worktree.featMdx,
    'claude',
    'needs-you',
    'Plan ready · 4 files. Waiting for approval.',
    ago(9 * MIN),
    {
      startedAt: ago(1 * HOUR),
    },
  ),
  /** Idle on the main worktree: the prototype nav counts `4 wt` and Repo has four lanes (discrepancy #16). */
  session(ids.session.gemini, ids.project.acmeShop, ids.worktree.acmeMain, 'gemini', 'idle', 'Idle', null, {
    startedAt: ago(20 * MIN),
  }),
  session(
    ids.session.infra,
    ids.project.infraTools,
    ids.worktree.infraMain,
    'gemini',
    'working',
    'Rewriting README for the CLI',
    ago(31 * MIN),
  ),
  session(
    ids.session.shell,
    ids.project.clientX,
    ids.worktree.clientMain,
    'shell',
    'working',
    'npm run build',
    ago(1 * HOUR),
  ),
  session(
    ids.session.cursor,
    ids.project.acmeShop,
    ids.worktree.featPromo,
    'cursor',
    'done',
    'PR #212 opened, merged yesterday',
    ago(1 * DAY),
    {
      startedAt: ago(2 * DAY),
    },
  ),
  session(
    ids.session.side,
    ids.project.sideApi,
    ids.worktree.sideMain,
    'claude',
    'done',
    '2 commits pushed',
    ago(2 * DAY),
    {
      startedAt: ago(2 * DAY + HOUR),
    },
  ),
];

// --- Targets ----------------------------------------------------------------

const target = (
  id: TargetId,
  projectId: ProjectId,
  provider: Provider,
  name: string,
  env: Env,
  policy: TargetPolicy,
  config: Target['config'],
  extra: Partial<Target> = {},
): Target => ({
  id,
  projectId,
  provider,
  name,
  env,
  authMethod: provider === 'aws' || provider === 'gcp' ? 'key' : provider === 'ssh' ? 'ssh' : 'oauth',
  policy,
  policySource: 'project',
  credentialRef: `styx:v1:${provider}:${id}:${provider === 'aws' || provider === 'gcp' ? 'key' : 'oauth'}`,
  health: 'ok',
  healthCheckedAt: ago(5 * MIN),
  expiredAt: null,
  config,
  fromProjectFile: projectId === ids.project.acmeShop,
  createdAt: ago(20 * DAY),
  ...extra,
});

/** The five acme-shop targets of the Settings → Targets table. */
export const demoAcmeTargets = (): Target[] => [
  target(ids.target.vercelProd, ids.project.acmeShop, 'vercel', 'Vercel', 'prod', 'ask-mfa', {
    teamSlug: 'acme',
    project: 'shop',
  }),
  target(ids.target.vercelPreview, ids.project.acmeShop, 'vercel', 'Vercel', 'preview', 'always', {
    teamSlug: 'acme',
    project: 'shop',
  }),
  target(ids.target.supabaseProd, ids.project.acmeShop, 'supabase', 'Supabase', 'prod', 'ask', {
    projectRef: 'acme-shop-prod',
  }),
  target(ids.target.awsProd, ids.project.acmeShop, 'aws', 'AWS acme-prod', 'prod', 'ask-mfa', {
    region: 'us-east-1',
    roleArn: 'arn:aws:iam::123:role/styx-agent',
  }),
  target(ids.target.github, ids.project.acmeShop, 'github', 'GitHub acme/shop', 'scm', 'always', {
    owner: 'acme',
    repo: 'shop',
  }),
];

/** Targets of the other projects (Home table "Targets" column). */
export const demoOtherTargets = (): Target[] => [
  target(ids.target.blogVercel, ids.project.blogV2, 'vercel', 'Vercel', 'prod', 'ask-mfa', {
    teamSlug: 'acme',
    project: 'blog-v2',
  }),
  target(ids.target.blogVercelPreview, ids.project.blogV2, 'vercel', 'Vercel', 'preview', 'always', {
    teamSlug: 'acme',
    project: 'blog-v2',
  }),
  target(ids.target.blogGithub, ids.project.blogV2, 'github', 'GitHub acme/blog-v2', 'scm', 'always', {
    owner: 'acme',
    repo: 'blog-v2',
  }),
  target(ids.target.infraAws, ids.project.infraTools, 'aws', 'AWS acme-prod', 'prod', 'ask-mfa', {
    region: 'us-east-1',
  }),
  target(ids.target.infraGcp, ids.project.infraTools, 'gcp', 'GCP infra', 'staging', 'ask', {
    projectId: 'acme-infra',
  }),
  target(ids.target.clientGcp, ids.project.clientX, 'gcp', 'GCP client-x', 'prod', 'ask-mfa', {
    projectId: 'client-x-prod',
  }),
  target(ids.target.clientGithub, ids.project.clientX, 'github', 'GitHub client-x/app', 'scm', 'always', {
    owner: 'client-x',
    repo: 'app',
  }),
  target(ids.target.sideSupabase, ids.project.sideApi, 'supabase', 'Supabase', 'staging', 'ask', {
    projectRef: 'side-api',
  }),
];

export const demoTargets = (): Target[] => [...demoAcmeTargets(), ...demoOtherTargets()];

// --- Grants -----------------------------------------------------------------

const grant = (
  id: GrantId,
  sessionId: SessionId | null,
  targetId: TargetId,
  worktreeId: WorktreeId | null,
  scope: Scope[],
  reason: string,
  extra: Partial<Grant>,
): Grant => ({
  id,
  sessionId,
  targetId,
  worktreeId,
  scope,
  duration: '1h',
  reason,
  state: 'requested',
  requestedAt: ago(3 * MIN),
  issuedAt: null,
  expiresAt: null,
  lastUsedAt: null,
  idleExpiresAt: null,
  revokedAt: null,
  revokeReason: null,
  policyId: null,
  mfaVerified: false,
  decidedBy: null,
  ...extra,
});

export const demoGrants = (): Grant[] => [
  /** Vercel prod · open · 58m left (issued 2 min ago for 1h). */
  grant(
    ids.grant.vercelProdClaude,
    ids.session.claude,
    ids.target.vercelProd,
    ids.worktree.fixCheckout,
    ['deploy'],
    '$ vercel deploy --prod',
    {
      state: 'active',
      requestedAt: ago(2 * MIN + 10_000),
      issuedAt: ago(2 * MIN),
      expiresAt: ago(2 * MIN) + HOUR,
      idleExpiresAt: ago(2 * MIN) + HOUR,
      lastUsedAt: ago(2 * MIN),
      policyId: ids.policy['ask-mfa-prod-write'],
      mfaVerified: true,
      decidedBy: 'user',
    },
  ),
  /** Vercel preview · persistent. */
  grant(
    ids.grant.vercelPreviewAlways,
    null,
    ids.target.vercelPreview,
    null,
    ['read', 'deploy'],
    'preview deploys',
    {
      state: 'active',
      duration: 'always',
      requestedAt: ago(2 * DAY),
      issuedAt: ago(2 * DAY),
      lastUsedAt: ago(1 * DAY),
      decidedBy: 'user',
    },
  ),
  /** Codex → Supabase prod · read + write · "migration 0042" (the head ask of the Codex session). */
  grant(
    ids.grant.supabaseCodex,
    ids.session.codex,
    ids.target.supabaseProd,
    ids.worktree.testFlaky,
    ['read', 'write'],
    'migration 0042',
    {
      requestedAt: ago(3 * MIN),
    },
  ),
  /**
   * Inbox row: `Claude · infra-tools → AWS acme-prod · read · "list ECS services"`. The prototype has no Claude
   * session in infra-tools, so the request hangs off the acme-shop Claude session and the row's project comes
   * from the target. Like the prototype (`review: () => {}`) it has no PendingAsk, so the Claude session stays
   * `working` and its fix/checkout lane is not "waiting on grant" (docs/handoff-discrepancies.md #10).
   */
  grant(
    ids.grant.awsClaude,
    ids.session.claude,
    ids.target.infraAws,
    ids.worktree.fixCheckout,
    ['read'],
    'list ECS services',
    {
      requestedAt: ago(9 * MIN),
    },
  ),
  /** Inbox row: `Cursor · blog-v2 → Vercel · preview · deploy · "preview deploy for #88"` (same caveat as above). */
  grant(
    ids.grant.vercelPreviewCursor,
    ids.session.cursor,
    ids.target.blogVercelPreview,
    ids.worktree.featPromo,
    ['deploy'],
    'preview deploy for #88',
    {
      requestedAt: ago(14 * MIN),
    },
  ),
  /** Gemini → AWS acme-prod, expired idle 1h at 08:58. */
  grant(
    ids.grant.awsGeminiExpired,
    ids.session.gemini,
    ids.target.awsProd,
    ids.worktree.acmeMain,
    ['read'],
    'list ECS services',
    {
      state: 'expired',
      requestedAt: ago(2 * HOUR),
      issuedAt: ago(2 * HOUR),
      expiresAt: ago(1 * HOUR),
      idleExpiresAt: ago(45 * MIN),
      lastUsedAt: ago(1 * HOUR + 45 * MIN),
      revokedAt: ago(45 * MIN),
      revokeReason: 'idle',
      policyId: ids.policy['idle-expiry-1h'],
      mfaVerified: false,
      decidedBy: 'user',
    },
  ),
];

// --- Pending asks -------------------------------------------------------------

export const demoPendingAsks = (): PendingAsk[] => [
  {
    id: ids.ask.codexGrant,
    sessionId: ids.session.codex,
    kind: 'grant',
    grantId: ids.grant.supabaseCodex,
    payload: { kind: 'grant', grantId: ids.grant.supabaseCodex },
    state: 'open',
    resolution: null,
    position: 0,
    brokerRequestId: 'req-0042',
    createdAt: ago(3 * MIN),
    resolvedAt: null,
  },
  {
    id: ids.ask.blogPlan,
    sessionId: ids.session.blog,
    kind: 'plan',
    grantId: null,
    payload: {
      kind: 'plan',
      summary: 'Plan ready · 4 files.',
      files: ['app/mdx.tsx', 'lib/mdx.ts', 'content/index.mdx', 'package.json'],
    },
    state: 'open',
    resolution: null,
    position: 0,
    brokerRequestId: 'req-0101',
    createdAt: ago(9 * MIN),
    resolvedAt: null,
  },
];

// --- Policies -----------------------------------------------------------------

/** Builtins with the prototype's counters; the prototype renders the first rule unchecked. */
export const demoPolicies = (): Policy[] => {
  const [auto, ask, idle] = defaultPolicies(ago(20 * DAY));
  if (auto === undefined || ask === undefined || idle === undefined) return [];
  return [
    { ...auto, enabled: false, matchCountToday: 12, matchCountWeek: 40, countersResetAt: ago(9 * HOUR) },
    { ...ask, matchCountToday: 2, matchCountWeek: 6, countersResetAt: ago(9 * HOUR) },
    { ...idle, matchCountToday: 1, matchCountWeek: 5, countersResetAt: ago(9 * HOUR) },
  ];
};

// --- Audit --------------------------------------------------------------------

const auditEntry = (
  n: number,
  time: number,
  extra: Partial<AuditEntry> & Pick<AuditEntry, 'actorKind' | 'actorLabel' | 'action'>,
): AuditEntry => ({
  id: ids.audit(n),
  seq: n,
  time,
  projectId: ids.project.acmeShop,
  targetId: null,
  sessionId: null,
  worktreeId: null,
  grantId: null,
  policyId: null,
  targetLabel: null,
  sessionLabel: null,
  worktreeLabel: null,
  agent: null,
  scope: null,
  duration: null,
  triggeredBy: null,
  detail: {},
  prevHash: n === 1 ? null : `demo-hash-${n - 1}`,
  hash: `demo-hash-${n}`,
  ...extra,
});

/** The prototype's four rows; newest first they read 09:41 used · 09:12 granted · 08:58 revoked · 08:30 opened PR (UTC). */
export const demoAuditEntries = (): AuditEntry[] => [
  auditEntry(1, ago(73 * MIN), {
    actorKind: 'agent',
    actorLabel: 'Cursor',
    action: 'opened-pr',
    targetId: ids.target.github,
    sessionId: ids.session.cursor,
    worktreeId: ids.worktree.featPromo,
    targetLabel: 'github',
    sessionLabel: 'cursor · acme-shop',
    worktreeLabel: 'feat/promo',
    agent: 'cursor',
    scope: ['write'],
    triggeredBy: '$ gh pr create',
    detail: { prNumber: 212 },
  }),
  auditEntry(2, ago(45 * MIN), {
    actorKind: 'system',
    actorLabel: 'system',
    action: 'expired',
    targetId: ids.target.awsProd,
    sessionId: ids.session.gemini,
    worktreeId: ids.worktree.acmeMain,
    grantId: ids.grant.awsGeminiExpired,
    policyId: ids.policy['idle-expiry-1h'],
    targetLabel: 'aws-acme-prod',
    sessionLabel: 'gemini · acme-shop',
    worktreeLabel: 'main',
    agent: 'gemini',
    scope: ['read'],
    triggeredBy: 'idle timer',
    detail: { reason: 'idle' },
  }),
  auditEntry(3, ago(31 * MIN), {
    actorKind: 'you',
    actorLabel: 'you',
    action: 'granted',
    targetId: ids.target.vercelProd,
    sessionId: ids.session.claude,
    worktreeId: ids.worktree.fixCheckout,
    grantId: ids.grant.vercelProdClaude,
    policyId: ids.policy['ask-mfa-prod-write'],
    targetLabel: 'vercel-prod',
    sessionLabel: 'claude · acme-shop',
    worktreeLabel: 'fix/checkout',
    agent: 'claude',
    scope: ['deploy'],
    duration: '1h',
    triggeredBy: 'grant sheet',
    detail: { decidedBy: 'user', mfaVerified: true },
  }),
  auditEntry(4, ago(2 * MIN), {
    actorKind: 'agent',
    actorLabel: 'Claude',
    action: 'used',
    targetId: ids.target.vercelProd,
    sessionId: ids.session.claude,
    worktreeId: ids.worktree.fixCheckout,
    grantId: ids.grant.vercelProdClaude,
    policyId: ids.policy['auto-read-staging-preview'],
    targetLabel: 'vercel-prod',
    sessionLabel: 'claude · acme-shop',
    worktreeLabel: 'fix/checkout',
    agent: 'claude',
    scope: ['deploy'],
    duration: '1h',
    triggeredBy: '$ vercel deploy --prod',
    detail: { via: 'shim', exitCode: 0 },
  }),
];

// --- Transcripts ------------------------------------------------------------

const msg = (
  n: number,
  sessionId: SessionId,
  seq: number,
  body: string,
  payload: TranscriptMessage['payload'],
  createdAt: number,
  askId: AskId | null = null,
): TranscriptMessage => ({
  id: ids.message(n),
  sessionId,
  seq,
  body,
  payload,
  askId,
  createdAt,
});

export const demoClaudeTranscript = (): TranscriptMessage[] => [
  msg(
    1,
    ids.session.claude,
    0,
    'Add input validation to checkout and cover it with tests.',
    { kind: 'user' },
    ago(40 * MIN),
  ),
  msg(
    2,
    ids.session.claude,
    1,
    'Read checkout.ts and pay.ts. Plan: new validate.ts, call it before summing, add 4 tests.',
    { kind: 'agent' },
    ago(38 * MIN),
  ),
  msg(
    3,
    ids.session.claude,
    2,
    '',
    {
      kind: 'file-list',
      files: [
        { path: 'validate.ts', added: 31, removed: 0 },
        { path: 'checkout.ts', added: 2, removed: 0 },
        { path: 'checkout.test.ts', added: 44, removed: 0 },
      ],
    },
    ago(20 * MIN),
  ),
  msg(
    4,
    ids.session.claude,
    3,
    'Ran vitest, 42 passed. Open a PR against main?',
    { kind: 'decision', options: ['Yes', 'No', 'Edit plan'], chosen: null },
    ago(14 * MIN),
  ),
];

export const demoCodexTranscript = (): TranscriptMessage[] => [
  msg(
    10,
    ids.session.codex,
    0,
    'Fix the flaky order test and make sure the schema matches prod.',
    { kind: 'user' },
    ago(25 * MIN),
  ),
  msg(
    11,
    ids.session.codex,
    1,
    'The test fails because migration 0042 was never applied to prod. I need to read the prod schema and apply it.',
    { kind: 'agent' },
    ago(4 * MIN),
  ),
  msg(
    12,
    ids.session.codex,
    2,
    'Scope: read schema, write. No grant on file for this target.',
    {
      kind: 'access-request',
      targetId: ids.target.supabaseProd,
      targetLabel: 'Supabase prod',
      scope: ['read', 'write'],
      reason:
        'to run migration 0042 — read schema, then apply. Test suite depends on the new orders.status column.',
      grantId: ids.grant.supabaseCodex,
    },
    ago(3 * MIN),
    ids.ask.codexGrant,
  ),
];

/** What the Codex transcript shows after Grant (prototype `codexGranted`). */
export const demoCodexGrantedMessages = (now = DEMO_NOW): TranscriptMessage[] => [
  msg(
    13,
    ids.session.codex,
    3,
    'grant: supabase-prod · read+write · expires in 59m',
    { kind: 'system' },
    now,
  ),
  msg(
    14,
    ids.session.codex,
    4,
    'Applying migration 0042 to prod. Re-running tests.',
    { kind: 'agent' },
    now + 5_000,
  ),
];

/** What the Codex transcript shows after Deny (prototype `codexDenied`). */
export const demoCodexDeniedMessages = (now = DEMO_NOW): TranscriptMessage[] => [
  msg(
    15,
    ids.session.codex,
    3,
    "Understood. I'll patch the test against the local schema instead and leave a note about the missing migration.",
    { kind: 'agent' },
    now + 5_000,
  ),
];

export const demoBlogTranscript = (): TranscriptMessage[] => [
  msg(
    20,
    ids.session.blog,
    0,
    'Migrate the posts to MDX and keep the URLs.',
    { kind: 'user' },
    ago(1 * HOUR),
  ),
  msg(
    21,
    ids.session.blog,
    1,
    'Plan ready · 4 files. Waiting for approval.',
    { kind: 'agent' },
    ago(9 * MIN),
    ids.ask.blogPlan,
  ),
];

export const demoTranscripts = (): Record<string, TranscriptMessage[]> => ({
  [ids.session.claude]: demoClaudeTranscript(),
  [ids.session.codex]: demoCodexTranscript(),
  [ids.session.blog]: demoBlogTranscript(),
});

// --- Hunks ------------------------------------------------------------------

const change = (
  n: number,
  file: string,
  header: [number, number, number, number],
  patchBody: string,
): AgentChange => ({
  id: ids.hunk(n),
  sessionId: ids.session.claude,
  worktreeId: ids.worktree.fixCheckout,
  file,
  hunkHash: `demo-hunk-${n}`,
  oldStart: header[0],
  oldLines: header[1],
  newStart: header[2],
  newLines: header[3],
  patch: `--- a/${file}\n+++ b/${file}\n@@ -${header[0]},${header[1]} +${header[2]},${header[3]} @@\n${patchBody}\n`,
  status: 'pending',
  firstSeenAt: ago(2 * MIN),
  lastSeenAt: ago(2 * MIN),
  decidedAt: null,
});

/**
 * The three pending hunks of the prototype's hunk bar / Diff review, rows verbatim from `hunkSrc`
 * (checkout.ts ×2, validate.ts; double quotes, three rows each).
 */
export const demoHunks = (): AgentChange[] => [
  change(
    1,
    'checkout.ts',
    [1, 2, 1, 3],
    ' import { sum } from "./cart"\n+import { validate } from "./validate"\n ',
  ),
  change(
    2,
    'checkout.ts',
    [4, 3, 5, 5],
    ' export async function checkout(cart) {\n+  validate(cart)\n   const total = sum(cart.items)',
  ),
  change(
    3,
    'validate.ts',
    [0, 0, 1, 31],
    ' \n+export function validate(cart) {\n+  if (!cart.items.length) throw new CartError("empty")',
  ),
];

/**
 * Repo lane diff for fix/checkout (`git diff -U3`), rows verbatim from the prototype's Repo block as it renders:
 * the block's rows are `white-space: normal`, so its `&nbsp;` context row collapses (nine rows) and the two-space
 * indentation collapses to one. The prototype's hardcoded header reads `+2 −0` although the block has three `+`
 * rows; the app derives `+3 −0`, and the `@@` counts describe the eight body rows
 * (docs/handoff-discrepancies.md #25, #28).
 */
export const demoLaneDiff = `diff --git a/checkout.ts b/checkout.ts
--- a/checkout.ts
+++ b/checkout.ts
@@ -1,5 +1,8 @@
 import { sum } from './cart'
+import { validate } from './validate'
 export async function checkout(cart) {
+ validate(cart)
  const total = sum(cart.items)
  const receipt = await pay(total)
+ audit(receipt)
  return receipt
`;

// --- Notifications, discovery, activity ------------------------------------

export const demoNotifications = (): Notification[] => [
  {
    id: 'notif-codex',
    kind: 'needs-you',
    sessionId: ids.session.codex,
    askId: ids.ask.codexGrant,
    projectId: ids.project.acmeShop,
    title: 'Codex wants Supabase prod · write',
    body: 'acme-shop · test/flaky · "migration 0042"',
    meta: null,
    osDelivered: true,
    state: 'shown',
    bannerKey: null,
    createdAt: ago(3 * MIN),
    resolvedAt: null,
  },
];

export const demoIdes = (): IdeInstall[] => [
  {
    id: 'ide-vscode',
    kind: 'vscode',
    product: 'VS Code',
    version: '1.98',
    location: '/Applications',
    launcher: 'code',
    recentsSource: 'state-db',
    configDir: '~/Library/Application Support/Code/User',
    isFallback: true,
    imported: { recents: 14, keybindings: true, theme: true },
    detectedAt: ago(1 * DAY),
  },
  {
    id: 'ide-cursor',
    kind: 'cursor',
    product: 'Cursor',
    version: '1.4',
    location: null,
    launcher: 'cursor',
    recentsSource: 'state-db',
    configDir: '~/Library/Application Support/Cursor/User',
    isFallback: false,
    imported: { recents: 6, keybindings: true, theme: false },
    detectedAt: ago(1 * DAY),
  },
  {
    id: 'ide-webstorm',
    kind: 'jetbrains',
    product: 'JetBrains (WebStorm)',
    version: '2026.2',
    location: null,
    launcher: 'webstorm',
    recentsSource: 'recent-projects',
    configDir: null,
    isFallback: false,
    imported: { recents: 3, keybindings: false, theme: false },
    detectedAt: ago(1 * DAY),
  },
  {
    id: 'ide-neovim',
    kind: 'neovim',
    product: 'Neovim',
    version: '0.11',
    location: '/opt/homebrew',
    launcher: 'nvim',
    recentsSource: 'shada',
    configDir: '~/.config/nvim',
    isFallback: false,
    imported: { recents: 0, keybindings: false, theme: false },
    detectedAt: ago(1 * DAY),
  },
];

export const demoClis = (): CliInstall[] => [
  {
    agent: 'claude',
    binary: '/opt/homebrew/bin/claude',
    version: '2.4.1',
    found: true,
    authState: 'signed-in',
    capabilities: { streamJson: true, hooks: true },
    checkedAt: ago(5 * MIN),
    account: 'nic@acme.dev',
    verifiedAt: ago(5 * MIN),
    verifyError: null,
  },
  {
    agent: 'codex',
    binary: '/opt/homebrew/bin/codex',
    version: '0.9.3',
    found: true,
    authState: 'signed-in',
    capabilities: { mcp: true, notify: true },
    checkedAt: ago(5 * MIN),
    account: 'ChatGPT',
    verifiedAt: ago(5 * MIN),
    verifyError: null,
  },
  {
    agent: 'gemini',
    binary: '/opt/homebrew/bin/gemini',
    version: '1.2.0',
    found: true,
    authState: 'signed-out',
    capabilities: { mcp: true },
    checkedAt: ago(5 * MIN),
    account: null,
    verifiedAt: ago(5 * MIN),
    verifyError: null,
  },
  {
    agent: 'cursor',
    binary: '/opt/homebrew/bin/cursor-agent',
    version: '0.5.2',
    found: true,
    authState: 'signed-in',
    capabilities: { streamJson: true },
    checkedAt: ago(5 * MIN),
    account: 'nic@acme.dev',
    verifiedAt: null,
    verifyError: null,
  },
  {
    agent: 'shell',
    binary: '/bin/zsh',
    version: '5.9',
    found: true,
    authState: 'n/a',
    capabilities: {},
    checkedAt: ago(5 * MIN),
    account: null,
    verifiedAt: null,
    verifyError: null,
  },
];

/**
 * Installed skills as the Settings › Skills pane lists them: one of the user's own for Claude Code, one committed
 * in acme-shop, one in the shared `.agents` dir (read by Codex, Gemini CLI and Cursor). The seed writes these to
 * the fixture home so the pane is deterministic and never reads the real one.
 */
export const demoSkills = (): SkillSummary[] => [
  {
    name: 'pdf',
    directory: 'pdf',
    description: 'Read, fill and merge PDF files with the pdf toolkit.',
    scope: 'global',
    host: 'claude',
  },
  {
    name: 'release-notes',
    directory: 'release-notes',
    description: 'Write release notes from the commits since the last tag, in this repo\u2019s voice.',
    scope: 'project',
    host: 'claude',
  },
  {
    name: 'sql-review',
    directory: 'sql-review',
    description: 'Review a migration for locking, index and backfill hazards before it ships.',
    scope: 'global',
    host: 'agents',
  },
];

const activity = (
  n: number,
  at: number,
  who: string,
  what: string,
  projectId: ProjectId | null,
  sessionId: SessionId | null,
): ActivityRow => ({
  id: `activity-${n}`,
  at,
  who,
  what,
  projectId,
  sessionId,
});

/** Home → Activity feed (newest first). */
export const demoActivity = (): ActivityRow[] => [
  activity(
    1,
    ago(2 * MIN),
    'Claude',
    'acme-shop · edited checkout.ts, pay.ts · 42 tests pass',
    ids.project.acmeShop,
    ids.session.claude,
  ),
  activity(
    2,
    ago(3 * MIN),
    'Codex',
    'acme-shop · requested Supabase prod write',
    ids.project.acmeShop,
    ids.session.codex,
  ),
  activity(3, ago(9 * MIN), 'Claude', 'blog-v2 · plan ready, 4 files', ids.project.blogV2, ids.session.blog),
  activity(
    4,
    ago(31 * MIN),
    'Gemini',
    'infra-tools · rewriting README',
    ids.project.infraTools,
    ids.session.infra,
  ),
  activity(
    5,
    ago(1 * HOUR),
    'system',
    'revoked Gemini → AWS acme-prod (idle 1h)',
    ids.project.acmeShop,
    ids.session.gemini,
  ),
  activity(6, ago(1 * DAY), 'Cursor', 'acme-shop · PR #212 merged', ids.project.acmeShop, ids.session.cursor),
];

// --- Fixture -----------------------------------------------------------------

export interface DemoFixture {
  now: number;
  projects: Project[];
  repos: Repo[];
  worktrees: Worktree[];
  sessions: Session[];
  targets: Target[];
  grants: Grant[];
  pendingAsks: PendingAsk[];
  policies: Policy[];
  auditEntries: AuditEntry[];
  transcripts: Record<string, TranscriptMessage[]>;
  hunks: Record<string, AgentChange[]>;
  notifications: Notification[];
  ides: IdeInstall[];
  clis: CliInstall[];
  skills: SkillSummary[];
  activity: ActivityRow[];
  appSettings: AppSettings;
  projectSettings: Record<string, EffectiveProjectSettings>;
  runs: Record<string, DevRun>;
  deploys: Record<string, Deploy>;
}

const acmeProjectSettings = (): EffectiveProjectSettings =>
  mergeSettings(
    DEFAULT_PROJECT_SETTINGS,
    {},
    { version: 1, name: 'acme-shop', agents: { default: 'claude', mayRequestTargets: true } },
  );

export const demoFixture = (): DemoFixture => ({
  now: DEMO_NOW,
  projects: demoProjects(),
  repos: demoRepos(),
  worktrees: demoWorktrees(),
  sessions: demoSessions(),
  targets: demoTargets(),
  grants: demoGrants(),
  pendingAsks: demoPendingAsks(),
  policies: demoPolicies(),
  auditEntries: demoAuditEntries(),
  transcripts: demoTranscripts(),
  hunks: { [ids.session.claude]: demoHunks() },
  notifications: demoNotifications(),
  ides: demoIdes(),
  clis: demoClis(),
  skills: demoSkills(),
  activity: demoActivity(),
  appSettings: { ...DEFAULT_APP_SETTINGS, fallbackIde: 'vscode', onboardingDone: true },
  projectSettings: { [ids.project.acmeShop]: acmeProjectSettings() },
  runs: {},
  deploys: {},
});

/** Prototype "Empty states": no projects, sessions or targets; builtins and detection intact. */
export const emptyFixture = (): DemoFixture => ({
  ...demoFixture(),
  projects: [],
  repos: [],
  worktrees: [],
  sessions: [],
  targets: [],
  grants: [],
  pendingAsks: [],
  auditEntries: [],
  transcripts: {},
  hunks: {},
  notifications: [],
  activity: [],
  skills: [],
  projectSettings: {},
});

/** Prototype "Error states": AWS acme-prod expired 2h ago, codex missing from PATH, fix/checkout conflicts with main. */
export const errorFixture = (): DemoFixture => {
  const base = demoFixture();
  return {
    ...base,
    targets: base.targets.map((t) =>
      t.id === ids.target.awsProd ? { ...t, health: 'expired', expiredAt: ago(2 * HOUR) } : t,
    ),
    clis: base.clis.map((c) =>
      c.agent === 'codex' ? { ...c, binary: null, version: null, found: false, authState: 'unknown' } : c,
    ),
    worktrees: base.worktrees.map((w) =>
      w.id === ids.worktree.fixCheckout ? { ...w, conflict: { file: 'checkout.ts', against: 'main' } } : w,
    ),
    sessions: [
      ...base.sessions.map((s): Session =>
        s.id === ids.session.claude ? { ...s, state: 'paused', pausedReason: 'conflict' } : s,
      ),
      /** "codex not found on PATH. 1 session cannot start." — outside acme-shop so its nav/tab counts hold. */
      session(
        ids.session.codexMissing,
        ids.project.sideApi,
        ids.worktree.sideMain,
        'codex',
        'paused',
        'codex not found on PATH',
        ago(3 * MIN),
        { pausedReason: 'cli-missing', pid: null, startedAt: ago(3 * MIN) },
      ),
    ],
    notifications: [
      ...base.notifications,
      {
        id: 'banner-aws-expired',
        kind: 'error-banner',
        sessionId: null,
        askId: null,
        projectId: ids.project.acmeShop,
        title: 'AWS acme-prod: credentials expired 2h ago. Agents requesting it are paused.',
        body: '',
        meta: null,
        osDelivered: false,
        state: 'shown',
        bannerKey: `auth-expired:${ids.target.awsProd}`,
        createdAt: ago(2 * HOUR),
        resolvedAt: null,
      },
      {
        id: 'banner-codex-missing',
        kind: 'error-banner',
        sessionId: ids.session.codex,
        askId: null,
        projectId: ids.project.acmeShop,
        title: 'codex not found on PATH. 1 session cannot start.',
        body: '',
        meta: null,
        osDelivered: false,
        state: 'shown',
        bannerKey: 'cli-missing:codex',
        createdAt: ago(3 * MIN),
        resolvedAt: null,
      },
      {
        id: 'banner-conflict',
        kind: 'error-banner',
        sessionId: ids.session.claude,
        askId: null,
        projectId: ids.project.acmeShop,
        title: 'fix/checkout conflicts with main in checkout.ts. Claude is paused until resolved.',
        body: '',
        meta: null,
        osDelivered: false,
        state: 'shown',
        bannerKey: `conflict:${ids.worktree.fixCheckout}`,
        createdAt: ago(1 * MIN),
        resolvedAt: null,
      },
    ],
  };
};

export const fixtureReadModel = (f: DemoFixture): ReadModel => ({
  seq: 1,
  projects: tableFrom(f.projects),
  repos: tableFrom(f.repos),
  worktrees: tableFrom(f.worktrees),
  sessions: tableFrom(f.sessions),
  targets: tableFrom(f.targets),
  grants: tableFrom(f.grants),
  auditEntries: tableFrom(f.auditEntries),
  policies: tableFrom(f.policies),
  pendingAsks: tableFrom(f.pendingAsks),
  notifications: tableFrom(f.notifications),
  transcripts: f.transcripts,
  hunks: f.hunks,
  discovery: { ides: f.ides, clis: f.clis },
  settings: { app: f.appSettings, project: f.projectSettings },
  popouts: [],
  activity: f.activity,
  runs: f.runs,
  deploys: f.deploys,
});

export const demoReadModel = (): ReadModel => fixtureReadModel(demoFixture());
export const emptyReadModel = (): ReadModel => fixtureReadModel(emptyFixture());
export const errorReadModel = (): ReadModel => fixtureReadModel(errorFixture());
