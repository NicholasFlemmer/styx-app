import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle mirror of `migrations/*.sql` (0000_init + 0001_activity + 0002_auth_method_cli + 0003_plain_folders) for `pnpm db:generate` diffs. The SQL file is authoritative:
 * CHECK constraints and the audit triggers are hand-maintained there (drizzle-kit does not emit them for SQLite).
 * Queries use prepared statements in `repos/`, not this schema.
 */

export const meta = sqliteTable('meta', { key: text('key').primaryKey(), value: text('value').notNull() });

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  initials: text('initials').notNull(),
  railOrder: integer('rail_order').notNull().default(0),
  settingsJson: text('settings_json').notNull().default('{}'),
  settingsMtime: integer('settings_mtime'),
  createdAt: integer('created_at').notNull(),
  lastActivityAt: integer('last_activity_at').notNull(),
  removedAt: integer('removed_at'),
});

export const repos = sqliteTable('repos', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  /** NULL = plain folder (no git) until `project.gitInit` (0003). */
  defaultBranch: text('default_branch'),
  remotesJson: text('remotes_json').notNull().default('[]'),
  ahead: integer('ahead').notNull().default(0),
  behind: integer('behind').notNull().default(0),
  fetchedAt: integer('fetched_at'),
  lineEndings: text('line_endings', { enum: ['auto', 'lf', 'crlf'] })
    .notNull()
    .default('auto'),
  longPaths: integer('long_paths').notNull().default(0),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    worktreeId: text('worktree_id'),
    agent: text('agent', { enum: ['claude', 'codex', 'gemini', 'cursor', 'shell'] }).notNull(),
    runner: text('runner', { enum: ['pty', 'stream'] })
      .notNull()
      .default('pty'),
    model: text('model'),
    state: text('state', { enum: ['idle', 'working', 'needs-you', 'done', 'paused'] }).notNull(),
    pausedReason: text('paused_reason', {
      enum: ['cli-missing', 'conflict', 'auth-expired', 'user'],
    }),
    note: text('note').notNull().default(''),
    firstMessage: text('first_message'),
    autoApproveEdits: integer('auto_approve_edits').notNull().default(0),
    mayRequestTargets: integer('may_request_targets').notNull().default(1),
    notifyWhenNeedsMe: integer('notify_when_needs_me').notNull().default(1),
    /** 0004: Claude Code parity. */
    permissionMode: text('permission_mode', {
      enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'],
    })
      .notNull()
      .default('default'),
    effort: text('effort', { enum: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    cliSessionId: text('cli_session_id'),
    costUsd: real('cost_usd').notNull().default(0),
    numTurns: integer('num_turns').notNull().default(0),
    slashCommandsJson: text('slash_commands_json').notNull().default('[]'),
    /** 0013: token totals for CLIs that report tokens rather than dollars (Codex). */
    tokensUsed: integer('tokens_used').notNull().default(0),
    contextWindow: integer('context_window'),
    brokerTokenHash: text('broker_token_hash').notNull().default(''),
    /** 0012: set when Styx spawned the session for a job of its own (`learn-run` / `learn-deploy`). */
    purpose: text('purpose', { enum: ['learn-run', 'learn-deploy', 'debt-audit'] }),
    taskTargetId: text('task_target_id'),
    pid: integer('pid'),
    exitCode: integer('exit_code'),
    startedAt: integer('started_at').notNull(),
    lastActivityAt: integer('last_activity_at').notNull(),
    endedAt: integer('ended_at'),
    archivedAt: integer('archived_at'),
  },
  (t) => [index('sessions_project_state').on(t.projectId, t.state)],
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    /** NULL only on the main worktree of a plain folder (0003). */
    branch: text('branch'),
    path: text('path').notNull().unique(),
    isMain: integer('is_main').notNull().default(0),
    ownerKind: text('owner_kind', { enum: ['user', 'session'] })
      .notNull()
      .default('user'),
    ownerSessionId: text('owner_session_id').references(() => sessions.id, { onDelete: 'set null' }),
    baseCommit: text('base_commit'),
    headCommit: text('head_commit'),
    added: integer('added').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    filesChanged: integer('files_changed').notNull().default(0),
    prNumber: integer('pr_number'),
    prState: text('pr_state', { enum: ['draft', 'open', 'merged', 'closed'] }),
    prUrl: text('pr_url'),
    conflictFile: text('conflict_file'),
    conflictAgainst: text('conflict_against'),
    /** ADR-0023: commits on the base branch not yet merged into this lane. */
    behindBase: integer('behind_base').notNull().default(0),
    overlapsJson: text('overlaps_json').notNull().default('[]'),
    mergedAt: integer('merged_at'),
    createdAt: integer('created_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  (t) => [uniqueIndex('worktrees_repo_branch').on(t.repoId, t.branch), index('worktrees_repo').on(t.repoId)],
);

export const targets = sqliteTable(
  'targets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['vercel', 'aws', 'gcp', 'supabase', 'github', 'ssh'] }).notNull(),
    name: text('name').notNull(),
    env: text('env', { enum: ['prod', 'staging', 'preview', 'scm'] }).notNull(),
    authMethod: text('auth_method', { enum: ['oauth', 'key', 'ssh', 'cli'] }).notNull(),
    policy: text('policy', { enum: ['ask-mfa', 'ask', 'always'] })
      .notNull()
      .default('ask'),
    policySource: text('policy_source', { enum: ['app', 'project'] })
      .notNull()
      .default('app'),
    credentialRef: text('credential_ref'),
    configJson: text('config_json').notNull().default('{}'),
    health: text('health', { enum: ['ok', 'expired', 'unconnected'] })
      .notNull()
      .default('unconnected'),
    healthCheckedAt: integer('health_checked_at'),
    expiredAt: integer('expired_at'),
    fromProjectFile: integer('from_project_file').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('targets_unique').on(t.projectId, t.provider, t.env, t.name)],
);

export const policies = sqliteTable(
  'policies',
  {
    id: text('id').primaryKey(),
    ord: integer('ord').notNull(),
    ruleJson: text('rule_json').notNull(),
    ruleText: text('rule_text').notNull(),
    enabled: integer('enabled').notNull().default(1),
    builtinKey: text('builtin_key').unique(),
    matchCountToday: integer('match_count_today').notNull().default(0),
    matchCountWeek: integer('match_count_week').notNull().default(0),
    countersResetAt: integer('counters_reset_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('policies_ord').on(t.ord)],
);

export const grants = sqliteTable(
  'grants',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    worktreeId: text('worktree_id').references(() => worktrees.id, { onDelete: 'set null' }),
    scopeJson: text('scope_json').notNull(),
    scopeMask: integer('scope_mask').notNull(),
    duration: text('duration', { enum: ['once', '1h', 'session', 'always'] }).notNull(),
    reason: text('reason').notNull(),
    state: text('state', { enum: ['requested', 'active', 'denied', 'revoked', 'expired'] }).notNull(),
    requestedAt: integer('requested_at').notNull(),
    issuedAt: integer('issued_at'),
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    idleExpiresAt: integer('idle_expires_at'),
    revokedAt: integer('revoked_at'),
    revokeReason: text('revoke_reason', {
      enum: ['user', 'expired', 'idle', 'session-end', 'once-used', 'target-removed', 'policy'],
    }),
    policyId: text('policy_id').references(() => policies.id, { onDelete: 'set null' }),
    mfaVerified: integer('mfa_verified').notNull().default(0),
    decidedBy: text('decided_by', { enum: ['user', 'policy', 'target-policy', 'persistent-grant'] }),
    credNonce: text('cred_nonce'),
  },
  (t) => [
    index('grants_target_active').on(t.targetId),
    index('grants_session_requested').on(t.sessionId, t.requestedAt),
    index('grants_expiry').on(t.expiresAt),
  ],
);

export const grantUses = sqliteTable('grant_uses', {
  id: text('id').primaryKey(),
  grantId: text('grant_id')
    .notNull()
    .references(() => grants.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  via: text('via', { enum: ['shim', 'get_credential', 'ssh-agent-sign', 'styx-cli', 'app'] }).notNull(),
  command: text('command'),
  scopeUsed: text('scope_used'),
  exitCode: integer('exit_code'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
});

export const pendingAsks = sqliteTable(
  'pending_asks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['grant', 'plan', 'decision', 'question', 'questions'] }).notNull(),
    grantId: text('grant_id').references(() => grants.id, { onDelete: 'cascade' }),
    payloadJson: text('payload_json').notNull().default('{}'),
    state: text('state', { enum: ['open', 'resolved', 'cancelled'] }).notNull(),
    resolutionJson: text('resolution_json'),
    position: integer('position').notNull(),
    brokerRequestId: text('broker_request_id'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('pending_asks_open').on(t.sessionId, t.position)],
);

export const transcriptMessages = sqliteTable(
  'transcript_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', {
      enum: [
        'user',
        'agent',
        'file-list',
        'decision',
        'access-request',
        'system',
        'tool',
        'thinking',
        'questions',
        'plan',
        'peer',
      ],
    }).notNull(),
    body: text('body').notNull(),
    payloadJson: text('payload_json'),
    askId: text('ask_id').references(() => pendingAsks.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('transcript_session_seq').on(t.sessionId, t.seq)],
);

export const auditEntries = sqliteTable(
  'audit_entries',
  {
    id: text('id').primaryKey(),
    seq: integer('seq').notNull().unique(),
    time: integer('time').notNull(),
    actorKind: text('actor_kind', { enum: ['you', 'system', 'agent'] }).notNull(),
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    projectId: text('project_id'),
    targetId: text('target_id'),
    sessionId: text('session_id'),
    worktreeId: text('worktree_id'),
    grantId: text('grant_id'),
    policyId: text('policy_id'),
    targetLabel: text('target_label'),
    sessionLabel: text('session_label'),
    worktreeLabel: text('worktree_label'),
    agent: text('agent'),
    scopeJson: text('scope_json'),
    duration: text('duration'),
    triggeredBy: text('triggered_by').notNull(),
    detailJson: text('detail_json'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_time').on(t.time), index('audit_target').on(t.targetId, t.time)],
);

export const agentChanges = sqliteTable(
  'agent_changes',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    file: text('file').notNull(),
    hunkHash: text('hunk_hash').notNull(),
    oldStart: integer('old_start').notNull(),
    oldLines: integer('old_lines').notNull(),
    newStart: integer('new_start').notNull(),
    newLines: integer('new_lines').notNull(),
    patch: text('patch').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'rejected', 'stale'] }).notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    decidedAt: integer('decided_at'),
  },
  (t) => [
    uniqueIndex('agent_changes_hash').on(t.worktreeId, t.hunkHash),
    index('agent_changes_pending').on(t.worktreeId),
  ],
);

export const ideInstalls = sqliteTable(
  'ide_installs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['vscode', 'cursor', 'windsurf', 'zed', 'jetbrains', 'neovim'] }).notNull(),
    product: text('product'),
    version: text('version'),
    location: text('location').notNull(),
    launcher: text('launcher'),
    configDir: text('config_dir'),
    isFallback: integer('is_fallback').notNull().default(0),
    importedJson: text('imported_json').notNull().default('{}'),
    detectedAt: integer('detected_at').notNull(),
  },
  (t) => [uniqueIndex('ide_installs_kind_product').on(t.kind, t.product)],
);

export const cliInstalls = sqliteTable('cli_installs', {
  agent: text('agent', { enum: ['claude', 'codex', 'gemini', 'cursor', 'shell'] }).primaryKey(),
  binary: text('binary'),
  version: text('version'),
  found: integer('found').notNull().default(0),
  authState: text('auth_state', { enum: ['signed-in', 'signed-out', 'unknown', 'n/a'] })
    .notNull()
    .default('unknown'),
  capabilitiesJson: text('capabilities_json').notNull().default('{}'),
  checkedAt: integer('checked_at').notNull(),
  /** Connection (migration 0011): who the CLI is signed in as, when it was verified, and the last failure text. */
  account: text('account'),
  verifiedAt: integer('verified_at'),
  verifyError: text('verify_error'),
});

export const uiState = sqliteTable('ui_state', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const windowState = sqliteTable('window_state', {
  key: text('key').primaryKey(),
  x: integer('x'),
  y: integer('y'),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  displayId: text('display_id'),
  maximized: integer('maximized').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['needs-you', 'grant-result', 'error-banner', 'info'] }).notNull(),
  sessionId: text('session_id'),
  askId: text('ask_id'),
  projectId: text('project_id'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  meta: text('meta'),
  osDelivered: integer('os_delivered').notNull().default(0),
  state: text('state', { enum: ['shown', 'later', 'acted', 'dismissed', 'resolved'] }).notNull(),
  bannerKey: text('banner_key').unique(),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
});

export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    who: text('who').notNull(),
    what: text('what').notNull(),
    projectId: text('project_id'),
    sessionId: text('session_id'),
  },
  (t) => [index('activity_at').on(t.at)],
);

/** 0015: one row per agent turn; hidden git refs behind it (docs/adr/0020). */
export const checkpoints = sqliteTable(
  'checkpoints',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    turn: integer('turn').notNull(),
    messageId: text('message_id'),
    baseRef: text('base_ref').notNull(),
    ref: text('ref'),
    files: integer('files').notNull().default(0),
    added: integer('added').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
    revertedAt: integer('reverted_at'),
    /** 0016: which screenshots exist for the turn (`['before','after']`). */
    screensJson: text('screens_json').notNull().default('[]'),
  },
  (t) => [index('checkpoints_session').on(t.sessionId, t.turn)],
);

/** 0015: user turns held back while the agent is mid-turn. */
export const queuedMessages = sqliteTable(
  'queued_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    /** Attachment paths (relative to the worktree), re-read when the message goes out. */
    filesJson: text('files_json').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('queued_messages_session').on(t.sessionId, t.createdAt)],
);
