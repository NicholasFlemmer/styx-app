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
import { DeployService } from './services/deploy-service';
import { TargetService } from './services/target-service';
import { TerminalService } from './services/terminal-service';
import { TranscriptService } from './services/transcript-service';
import { Publisher } from './store/publisher';

/** The window-manager surface commands need; implemented over WindowService in `index.ts`, faked in tests. */
export interface WindowsPort {
  popoutSessionIds(): string[];
  openPopout(sessionId: string): void;
  dockPopout(sessionId: string): void;
  /** The cross-project agent dock (one window, or none). */
  openDock(): void;
  closeDock(): void;
  dockOpen(): boolean;
  control(
    senderId: number,
    target: { window: 'main' | 'popout' | 'dock'; sessionId?: string },
    action: 'minimize' | 'maximize' | 'restore' | 'close',
  ): void;
  focusMain(): void;
}

/**
 * The design window's native view (Electron `WebContentsView`). A port so the container stays Electron-free and
 * buildable in tests; `main/index.ts` supplies the real one.
 */
export interface PreviewPort {
  set(input: {
    visible: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    url: string;
    device: 'desktop' | 'tablet' | 'phone';
  }): void;
  reload(): void;
  openExternal(url: string): Promise<void>;
  detach(): void;
}

const NO_PREVIEW: PreviewPort = {
  set: () => undefined,
  reload: () => undefined,
  openExternal: async () => undefined,
  detach: () => undefined,
};

/** Native file/folder pickers (Electron `dialog`), parented to the main window; `null` when the user cancels. */
export interface DialogsPort {
  pickFolder(opts: { title?: string | undefined; defaultPath?: string | undefined }): Promise<string | null>;
  pickFile(opts: {
    title?: string | undefined;
    defaultPath?: string | undefined;
    filters?: { name: string; extensions: string[] }[] | undefined;
  }): Promise<string | null>;
}

/** Headless default (tests, fixtures without a window): every picker is dismissed. */
export const NO_DIALOGS: DialogsPort = { pickFolder: async () => null, pickFile: async () => null };

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
  preview?: PreviewPort;
  /** Native pickers; omitted in tests (`NO_DIALOGS`). */
  dialogs?: DialogsPort;
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
  /** Fixture profiles carry fake credentials; probing them would only flag every target `expired`. */
  disableRefresh?: boolean;
  /** Re-detect agent CLIs before every spawn / relaunch and on focus (default on; off for fixture rows and tests). */
  redetectClis?: boolean;
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
  deploys: DeployService;
  terminals: TerminalService;
  broker: BrokerHost;
  windows: WindowsPort;
  preview: PreviewPort;
  dialogs: DialogsPort;
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
    redetectClis: opts.redetectClis ?? true,
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
    // IDE recents need no `ide.import`: state.vscdb + workspaceStorage / recentProjects.xml / shada are read directly
    // for every detected editor. When nothing has been detected yet (fresh install, Home "Scan this machine"), detect first.
    ideRecents: async () => {
      let ides = repos.discovery.ides().map((i) => ({ kind: i.kind, configDir: i.configDir }));
      if (ides.length === 0) {
        ides = (await detect.detectIdes())
          .filter((i) => i.found)
          .map((i) => ({ kind: i.kind, configDir: i.configDir }));
      }
      return ideImport.allRecentFoldersWithTime(ides);
    },
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
  const deploys = new DeployService({
    repos,
    publisher,
    providers,
    grants,
    terminals,
    pty,
    cli,
  });
  const refresh = new RefreshScheduler({
    repos,
    clock,
    checkHealth: (t, reason) => targets.checkHealth(t, reason),
    ...((opts.redetectClis ?? true) ? { refreshClis: () => sessions.refreshClis() } : {}),
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
    deploys,
    terminals,
    broker,
    windows: opts.windows,
    preview: opts.preview ?? NO_PREVIEW,
    dialogs: opts.dialogs ?? NO_DIALOGS,
    runtime,
    openExternal: opts.openExternal,
    openInIde: opts.openInIde,
    onAppSettings: opts.onAppSettings ?? (() => undefined),
    async start() {
      grants.start();
      retention.start();
      if (opts.disableRefresh) refresh.disable();
      else refresh.start();
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
