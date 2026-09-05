import { homedir } from 'node:os';
import type { AppSettings } from '@styx/core';
import type { Clock } from './clock';
import type { Db } from './db/open';
import { Repos } from './db/repos';
import { CommandBus } from './ipc/bus';
import { registerAllCommands } from './ipc/commands';
import { ProviderRegistry } from './providers';
import { ExecaCliRunner, type CliRunner } from './providers/cli-runner';
import { GitHubAdapter } from './providers/github';
import { BrokerHost } from './broker/host';
import { ActivityService } from './services/activity-service';
import { AuditService } from './services/audit-service';
import type { CredentialVault } from './services/credential-vault';
import { DetectService } from './services/detect-service';
import { GitService } from './services/git';
import { GrantService } from './services/grant-service';
import { HunkService, type WatchFactory } from './services/hunk-service';
import { IdeImportService } from './services/ide-import-service';
import { MfaService, type MfaProvider } from './services/mfa-service';
import type { NotificationService } from './services/notification-service';
import { ProjectService } from './services/project-service';
import { PtyLog } from './services/pty-log';
import { PtyService } from './services/pty-service';
import { RefreshScheduler } from './services/refresh-scheduler';
import { RetentionJob } from './services/retention-job';
import { SessionService } from './services/session-service';
import { StreamRunner, type StreamRunnerLike } from './services/stream-runner';
import { TargetService } from './services/target-service';
import { TerminalService } from './services/terminal-service';
import { TranscriptService } from './services/transcript-service';
import { Publisher } from './store/publisher';

/** The window-manager surface commands need; implemented over WindowService in `index.ts`, faked in tests. */
export interface WindowsPort {
  popoutSessionIds(): string[];
  openPopout(sessionId: string): void;
  dockPopout(sessionId: string): void;
  control(
    senderId: number,
    target: { window: 'main' | 'popout'; sessionId?: string },
    action: 'minimize' | 'maximize' | 'restore' | 'close',
  ): void;
  focusMain(): void;
}

export interface Runtime {
  userData: string;
  platform: NodeJS.Platform;
  shimDir: string;
  cliPath: string;
  exePath: string;
  brokerEndpoint: string;
  /** `resources/` (packaged) or `apps/desktop/resources` (dev). */
  resourcesDir: string;
  rendererOrigins: string[];
}

export interface ContainerOptions {
  db: Db;
  clock: Clock;
  vault: CredentialVault;
  mfaProvider: MfaProvider;
  runtime: Runtime;
  windows: WindowsPort;
  notifications: NotificationService | null;
  openExternal: (url: string) => Promise<void>;
  openInIde: (launcher: string, path: string) => Promise<void>;
  /** Applied after any app-settings change (theme source, launch at login…). */
  onAppSettings?: (settings: AppSettings) => void;
  fetch?: typeof fetch;
  detect?: DetectService;
  ideImport?: IdeImportService;
  pty?: PtyService;
  stream?: StreamRunnerLike;
  watch?: WatchFactory;
  /** Provider CLI runner (`gcloud` / `aws` / `gh` / `vercel` / `supabase`); faked in tests. */
  cli?: CliRunner;
  tickMs?: number;
  /** RetentionJob period (hourly by default). */
  retentionMs?: number;
  /** RefreshScheduler period (30 min by default). */
  refreshMs?: number;
}

export interface Container {
  clock: Clock;
  repos: Repos;
  audit: AuditService;
  publisher: Publisher;
  bus: CommandBus;
  git: GitService;
  pty: PtyService;
  stream: StreamRunnerLike;
  ptyLog: PtyLog;
  retention: RetentionJob;
  refresh: RefreshScheduler;
  cli: CliRunner;
  detect: DetectService;
  ideImport: IdeImportService;
  vault: CredentialVault;
  providers: ProviderRegistry;
  mfa: MfaService;
  notifications: NotificationService | null;
  transcript: TranscriptService;
  activity: ActivityService;
  sessions: SessionService;
  grants: GrantService;
  projects: ProjectService;
  hunks: HunkService;
  targets: TargetService;
  terminals: TerminalService;
  broker: BrokerHost;
  windows: WindowsPort;
  runtime: Runtime;
  openExternal: (url: string) => Promise<void>;
  openInIde: (launcher: string, path: string) => Promise<void>;
  onAppSettings: (settings: AppSettings) => void;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Builds every service once with explicit deps (apps/desktop/CLAUDE.md). No Electron imports here so tests can build it. */
export function buildContainer(opts: ContainerOptions): Container {
  const { clock, runtime } = opts;
  const now = () => clock.now();
  const repos = new Repos(opts.db, now);
  const audit = new AuditService(opts.db, now);
  const publisher = new Publisher({
    repos,
    popouts: () => opts.windows.popoutSessionIds(),
    ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
  });
  const bus = new CommandBus({
    isRegistered: (id) => publisher.isRegistered(id),
    allowedOrigins: runtime.rendererOrigins,
  });
  const git = new GitService();
  const pty = opts.pty ?? new PtyService(runtime.platform);
  const stream = opts.stream ?? new StreamRunner();
  const ptyLog = new PtyLog(`${runtime.userData}/logs/pty`);
  const detect = opts.detect ?? new DetectService();
  const ideImport =
    opts.ideImport ?? new IdeImportService({ platform: runtime.platform, home: homedir(), env: process.env });
  const cli =
    opts.cli ?? new ExecaCliRunner({ loginPath: () => pty.resolveLoginPath(), platform: runtime.platform });
  const providers = new ProviderRegistry(
    { vault: opts.vault, fetch: opts.fetch ?? fetch, now, cli },
    { platform: runtime.platform },
  );
  const mfa = new MfaService(opts.mfaProvider);
  const transcript = new TranscriptService(repos, publisher, clock);
  const activity = new ActivityService(repos, publisher, clock);
  const sessions = new SessionService({
    repos,
    publisher,
    clock,
    pty,
    stream,
    ptyLog,
    git,
    detect,
    transcript,
    activity,
    notifications: opts.notifications,
    runtime,
  });
  const grants = new GrantService({
    repos,
    audit,
    publisher,
    clock,
    providers,
    mfa,
    transcript,
    activity,
    sessions,
    platform: runtime.platform,
    projectRules: (projectId) => projects.projectRules(projectId),
    onIssueFailure: (targetId, error) => targets.noteIssueFailure(targetId, error),
  });
  const hunks = new HunkService({
    repos,
    publisher,
    clock,
    git,
    ...(opts.watch ? { watch: opts.watch } : {}),
  });
  const githubAdapter = providers.get('github');
  const projects = new ProjectService({
    repos,
    publisher,
    clock,
    git,
    platform: runtime.platform,
    templatesDir: `${runtime.resourcesDir}/templates`,
    audit,
    activity,
    github: githubAdapter instanceof GitHubAdapter ? githubAdapter : null,
    ideRecents: () =>
      ideImport.allRecentFolders(
        repos.discovery.ides().map((i) => ({ kind: i.kind, configDir: i.configDir })),
      ),
  });
  const terminals = new TerminalService(repos, pty, () => ({
    STYX_SHIM_DIR: runtime.shimDir,
    STYX_CLI: runtime.cliPath,
    STYX_EXE: runtime.exePath,
    STYX_BROKER: runtime.brokerEndpoint,
  }));
  const targets = new TargetService({
    repos,
    publisher,
    clock,
    audit,
    providers,
    vault: opts.vault,
    grants,
    activity,
    openExternal: opts.openExternal,
    terminals,
    pty,
    cli,
  });
  const refresh = new RefreshScheduler({
    repos,
    clock,
    checkHealth: (t, reason) => targets.checkHealth(t, reason),
    ...(opts.refreshMs !== undefined ? { intervalMs: opts.refreshMs } : {}),
  });
  const broker = new BrokerHost({
    repos,
    grants,
    sessions,
    hunks,
    providers,
    clock,
    endpoint: runtime.brokerEndpoint,
  });

  const retention = new RetentionJob({
    repos,
    publisher,
    clock,
    deleteLogs: (id) => ptyLog.remove(id),
    ...(opts.retentionMs !== undefined ? { intervalMs: opts.retentionMs } : {}),
  });

  sessions.bind({
    revokeSessionGrants: (id) => grants.cancelSessionGrants(id),
    cancelHeldAsk: (ask) => broker.cancelAsk(ask),
    watchWorktree: (s, w) => void hunks.watch(s, w),
    unwatchWorktree: (id) => void hunks.unwatch(id),
    rescanHunks: (id) => void hunks.rescan(id).catch(() => undefined),
  });

  const container: Container = {
    clock,
    repos,
    audit,
    publisher,
    bus,
    git,
    pty,
    stream,
    ptyLog,
    retention,
    refresh,
    cli,
    detect,
    ideImport,
    vault: opts.vault,
    providers,
    mfa,
    notifications: opts.notifications,
    transcript,
    activity,
    sessions,
    grants,
    projects,
    hunks,
    targets,
    terminals,
    broker,
    windows: opts.windows,
    runtime,
    openExternal: opts.openExternal,
    openInIde: opts.openInIde,
    onAppSettings: opts.onAppSettings ?? (() => undefined),
    async start() {
      grants.start();
      retention.start();
      refresh.start();
      await broker.listen();
    },
    async shutdown() {
      for (const s of repos.sessions.live()) broker.notifyStopping(s.id);
      retention.stop();
      refresh.stop();
      sessions.killAll();
      await hunks.closeAll();
      await broker.close();
      await grants.stop();
      const ssh = providers.get('ssh') as { revokeAll?: () => Promise<void> };
      await ssh.revokeAll?.();
      publisher.dispose();
    },
  };
  registerAllCommands(bus, container);
  return container;
}
