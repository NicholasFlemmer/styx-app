import type { RowOf, TableName } from '@styx/core';
import { KvStore, WindowStateStore } from '../kv';
import type { Db } from '../open';
import { ActivityRepo } from './activity';
import { AgentChangesRepo } from './agent-changes';
import { CheckpointsRepo } from './checkpoints';
import { QueuedMessagesRepo } from './queued-messages';
import { AuditRepo } from './audit';
import { DiscoveryRepo } from './discovery';
import { GitReposRepo } from './git-repos';
import { GrantsRepo, GrantUsesRepo } from './grants';
import { NotificationsRepo } from './notifications';
import { PendingAsksRepo } from './pending-asks';
import { PoliciesRepo } from './policies';
import { ProjectsRepo } from './projects';
import { SessionsRepo } from './sessions';
import { SettingsRepo } from './settings';
import { TargetsRepo } from './targets';
import { TranscriptsRepo } from './transcripts';
import { WorktreesRepo } from './worktrees';

export * from './activity';
export * from './agent-changes';
export * from './audit';
export * from './discovery';
export * from './git-repos';
export * from './grants';
export * from './notifications';
export * from './pending-asks';
export * from './policies';
export * from './projects';
export * from './sessions';
export * from './settings';
export * from './targets';
export * from './transcripts';
export * from './worktrees';

/** All table repos over one connection; `rowsOf` lets the publisher re-read rows for any read-model table by id. */
export class Repos {
  readonly projects: ProjectsRepo;
  readonly repos: GitReposRepo;
  readonly worktrees: WorktreesRepo;
  readonly sessions: SessionsRepo;
  readonly targets: TargetsRepo;
  readonly grants: GrantsRepo;
  readonly grantUses: GrantUsesRepo;
  readonly pendingAsks: PendingAsksRepo;
  readonly transcripts: TranscriptsRepo;
  readonly audit: AuditRepo;
  readonly policies: PoliciesRepo;
  readonly notifications: NotificationsRepo;
  readonly agentChanges: AgentChangesRepo;
  readonly checkpoints: CheckpointsRepo;
  readonly queuedMessages: QueuedMessagesRepo;
  readonly activity: ActivityRepo;
  readonly discovery: DiscoveryRepo;
  readonly settings: SettingsRepo;
  readonly uiState: KvStore;
  readonly windowState: WindowStateStore;

  constructor(
    readonly db: Db,
    now: () => number,
  ) {
    this.projects = new ProjectsRepo(db);
    this.repos = new GitReposRepo(db);
    this.worktrees = new WorktreesRepo(db);
    this.sessions = new SessionsRepo(db);
    this.targets = new TargetsRepo(db);
    this.grants = new GrantsRepo(db);
    this.grantUses = new GrantUsesRepo(db);
    this.pendingAsks = new PendingAsksRepo(db);
    this.transcripts = new TranscriptsRepo(db);
    this.audit = new AuditRepo(db);
    this.policies = new PoliciesRepo(db);
    this.notifications = new NotificationsRepo(db);
    this.agentChanges = new AgentChangesRepo(db);
    this.checkpoints = new CheckpointsRepo(db);
    this.queuedMessages = new QueuedMessagesRepo(db);
    this.activity = new ActivityRepo(db);
    this.discovery = new DiscoveryRepo(db);
    this.settings = new SettingsRepo(db, now);
    this.uiState = new KvStore(db, 'ui_state', now);
    this.windowState = new WindowStateStore(db, now);
  }

  rowsOf<N extends TableName>(table: N, ids: readonly string[]): RowOf<N>[] {
    const readers: { [K in TableName]: (ids: readonly string[]) => RowOf<K>[] } = {
      projects: (i) => this.projects.byIds(i),
      repos: (i) => this.repos.byIds(i),
      worktrees: (i) => this.worktrees.byIds(i),
      sessions: (i) => this.sessions.byIds(i),
      targets: (i) => this.targets.byIds(i),
      grants: (i) => this.grants.byIds(i),
      auditEntries: (i) => this.audit.byIds(i),
      policies: (i) => this.policies.byIds(i),
      pendingAsks: (i) => this.pendingAsks.byIds(i),
      notifications: (i) => this.notifications.byIds(i),
    };
    return readers[table](ids);
  }

  /** Runs `fn` in one SQLite transaction (better-sqlite3 transactions are synchronous). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
