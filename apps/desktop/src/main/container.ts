import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_ID, DEVICE_NAME, copy, fill, type AppSettings } from '@styx/core';
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
import { AgentService } from './services/agent-service';
import { CliWatchService } from './services/cli-watch-service';
import { AuditService } from './services/audit-service';
import { CheckpointService, screenshotSourceFor } from './services/checkpoint-service';
import type { CredentialVault } from './services/credential-vault';
import { DetectService, defaultDeps as defaultDetectDeps } from './services/detect-service';
import { ExecaGitRunner, GitService } from './services/git';
import { GrantService } from './services/grant-service';
import { HunkService, type WatchFactory } from './services/hunk-service';
import { IdeImportService } from './services/ide-import-service';
import { MfaService, type MfaProvider } from './services/mfa-service';
import type { NotificationService } from './services/notification-service';
import { ProjectService } from './services/project-service';
import { LaneSyncService } from './services/lane-sync-service';
import { execaPublishExec, PublishService } from './services/publish-service';
import { PtyLog } from './services/pty-log';
import { PtyService } from './services/pty-service';
import { RefreshScheduler } from './services/refresh-scheduler';
import { RetentionJob } from './services/retention-job';
import {
  DeviceService,
  execaDeviceExec,
  execaWhich,
  type DeviceExec,
  type ScreenAccess,
  type WindowSource,
} from './services/device-service';
import { isLoopbackUrl, RunService, type ProbeAnswer } from './services/run-service';
import { ScreensStore } from './services/screens-store';
import { commandCarriesSecret } from './services/logger';
import { SessionService } from './services/session-service';
import { StreamRunner, type StreamRunnerLike } from './services/stream-runner';
import { RunnerMux } from './services/runner-mux';
import { AppServerRunner } from './services/app-server-runner';
import { AcpRunner } from './services/acp-runner';
import { DeployService } from './services/deploy-service';
import { SkillsService } from './services/skills-service';
import { TargetService } from './services/target-service';
import { TerminalService } from './services/terminal-service';
import { TranscriptService } from './services/transcript-service';
import { UsageService } from './services/usage-service';
import { projectSettingsFor } from './store/projection';
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
    projectId: string;
    visible: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    url: string;
    device: 'desktop' | 'tablet' | 'phone';
  }): void;
  reload(): void;
  openExternal(url: string): Promise<void>;
  detach(): void;
  /** A PNG of the loaded page (checkpoint screenshots); null when nothing is loaded. */
  capture(): Promise<Buffer | null>;
  /** The loaded page's URL and the project it was set for; null when nothing is loaded. */
  loaded(): { url: string; projectId: string } | null;
}

const NO_PREVIEW: PreviewPort = {
  set: () => undefined,
  reload: () => undefined,
  openExternal: async () => undefined,
  detach: () => undefined,
  capture: async () => null,
  loaded: () => null,
};

/** What the device mirror needs from the OS: capturable windows, the Screen Recording permission, which(1). */
export interface DeviceHooks {
  windowSources: () => Promise<WindowSource[]>;
  screenAccess: () => ScreenAccess;
  openScreenAccess: () => Promise<void>;
}
const NO_DEVICE_HOOKS: DeviceHooks = {
  windowSources: async () => [],
  screenAccess: () => 'n/a',
  openScreenAccess: async () => undefined,
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
  /** The simulator / emulator mirror's OS hooks; faked in tests (`NO_DEVICE_HOOKS`). */
  deviceHooks?: DeviceHooks;
  /** Device tooling runner (`xcrun simctl`, `adb`) and lookup; faked in tests. */
  deviceExec?: DeviceExec;
  deviceWhich?: (bin: string) => Promise<string | null>;
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
  /** Home dir the skills service scans (`~/.claude/skills` …); fixtures point it at a seeded temp dir. */
  skillsHome?: string;
  /** Runs a CLI status command for AgentService (`claude auth status --json` …); faked in tests. */
  exec?: (bin: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
  /** Does a dev-server URL answer? (RunService); faked in tests so nothing is ever probed for real. */
  probe?: (url: string) => Promise<boolean | ProbeAnswer>;
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
  skills: SkillsService;
  agents: AgentService;
  runs: RunService;
  /** The simulator / emulator mirrored in the design window (owner request). */
  devices: DeviceService;
  /** Pictures of the running app served over `styx-device://` (live frames, checkpoint screenshots). */
  screens: ScreensStore;
  /** Turn checkpoints (ADR-0020): hidden git refs per agent turn, diff and revert. */
  checkpoints: CheckpointService;
  /** Commit, push and PR in one step (ADR-0021); the message draft comes from the project's default agent. */
  publish: PublishService;
  /** Keep lanes current (ADR-0023): behind-base counts, `worktree.sync`, the publish gate. */
  laneSync: LaneSyncService;
  /** Usage page: the latest rate limits per CLI and the on-demand Codex refresh. */
  usage: UsageService;
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
  const gitRunner = new ExecaGitRunner();
  const git = new GitService(gitRunner);
  const pty = opts.pty ?? new PtyService(runtime.platform);
  // One door, several protocols (docs/research/agent-parity.md): Claude's NDJSON now; the Codex app-server and
  // ACP backends register here as they land.
  const stream =
    opts.stream ??
    new RunnerMux()
      .register(['stdin', 'argv'], new StreamRunner())
      .register(['app-server'], new AppServerRunner())
      .register(['acp'], new AcpRunner());
  const ptyLog = new PtyLog(`${runtime.userData}/logs/pty`);
  // Detection sees what the terminal sees (#98): the login shell's PATH and `command -v` answers, re-asked at most
  // every 10 s when a re-detect runs. Fixture and test containers (`redetectClis: false`) keep the process PATH so
  // their rows stay deterministic.
  const redetect = opts.redetectClis ?? true;
  const detect =
    opts.detect ??
    new DetectService(
      defaultDetectDeps(
        process.env['PATH'] ?? '',
        redetect ? () => pty.resolveLoginEnv({ maxAgeMs: 10_000 }) : undefined,
      ),
    );
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
    shell: () => pty.defaultShell(),
    platform: runtime.platform,
  });
  const laneSync = new LaneSyncService({
    repos,
    git,
    publisher,
    clock,
    transcript,
    activity,
    sessionEvent: (sessionId, event) => sessions.applyEvent(sessionId, event),
  });
  const publish = new PublishService({
    repos,
    publisher,
    clock,
    git,
    grants,
    activity,
    audit,
    exec: execaPublishExec(() => pty.resolveLoginPath()),
    projectSettings: (projectId) => {
      const s = projectSettingsFor(repos, projectId);
      return {
        defaultAgent: s.defaultAgent.value,
        baseBranch: s.baseBranch.value,
        syncBeforePublish: s.syncBeforePublish.value,
      };
    },
    laneSync: (worktreeId) => laneSync.sync(worktreeId),
    loginPath: () => pty.resolveLoginPath(),
    platform: runtime.platform,
  });
  const skills = new SkillsService({
    repos,
    fetch: opts.fetch ?? fetch,
    // A fixture home is the whole world: the developer's real $CODEX_HOME must not leak in beside it.
    ...(opts.skillsHome !== undefined ? { home: opts.skillsHome, env: {} } : {}),
  });
  const agents = new AgentService({
    repos,
    publisher,
    clock,
    terminals,
    pty,
    exec: opts.exec ?? defaultDetectDeps().exec,
    openExternal: opts.openExternal,
    home: homedir(),
    env: process.env,
    platform: runtime.platform,
    loginPath: () => pty.resolveLoginPath(),
    shell: () => pty.defaultShell(),
    refreshClis: () => sessions.refreshClis(),
    activity,
  });
  // An install in a terminal shows up within a second: the folders each detection scanned are watched (#98).
  const cliWatch = new CliWatchService({ onChange: () => sessions.refreshClis() });
  detect.onSearched = (dirs) => cliWatch.update(dirs);
  if (redetect) cliWatch.start();
  const runs = new RunService({
    repos,
    publisher,
    clock,
    terminals,
    pty,
    projects,
    shell: () => pty.defaultShell(),
    platform: runtime.platform,
    ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
  });
  const usage = new UsageService({ repos, publisher, clock, env: process.env });
  const screens = new ScreensStore(join(runtime.userData, 'screens'));
  const deviceHooks = opts.deviceHooks ?? NO_DEVICE_HOOKS;
  const devices = new DeviceService({
    repos,
    publisher,
    clock,
    screens,
    exec: opts.deviceExec ?? execaDeviceExec(() => pty.resolveLoginPath()),
    which: opts.deviceWhich ?? execaWhich(() => pty.resolveLoginPath(), runtime.platform),
    platform: runtime.platform,
    windowSources: deviceHooks.windowSources,
    screenAccess: deviceHooks.screenAccess,
    openScreenAccess: deviceHooks.openScreenAccess,
    onFrame: (projectId, seq) => publisher.sendEvent('device.frame', { projectId, seq }),
  });
  runs.bindDevices(devices);
  publisher.bindExtras({
    runs: () => runs.all(),
    devices: () => devices.all(),
    deploys: () => deploys.all(),
    limits: () => usage.all(),
  });
  const refresh = new RefreshScheduler({
    repos,
    clock,
    checkHealth: (t, reason) => targets.checkHealth(t, reason),
    ...((opts.redetectClis ?? true) ? { refreshClis: () => sessions.refreshClis() } : {}),
    ...((opts.redetectClis ?? true) ? { refreshLanes: () => laneSync.refreshAll() } : {}),
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
    abilities: {
      // The agent worked out how to run the project: keep the command (and URL), say so in its chat and on Home,
      // and start the managed run so the design window shows the app straight away.
      rememberRun: async (sessionId, command, url, device) => {
        const session = repos.sessions.get(sessionId);
        if (!session) return;
        const cmd = command.trim();
        if (commandCarriesSecret(cmd)) {
          transcript.system(session.id, copy.abilities.secretInCommand);
          return;
        }
        // Stored in its parsed form: the parser strips stray whitespace and control characters.
        const safeUrl = url !== null && isLoopbackUrl(url) ? new URL(url).href : null;
        // A device name and an app id are identifiers (the same rule a committed project file gets).
        const platform = device.platform ?? 'web';
        const deviceName =
          platform !== 'web' && device.device !== null && DEVICE_NAME.test(device.device)
            ? device.device
            : null;
        const appId =
          platform !== 'web' && device.appId !== null && APP_ID.test(device.appId) ? device.appId : null;
        await projects.setSettings(session.projectId, {
          devCommand: cmd,
          devPlatform: platform === 'web' ? null : platform,
          devDevice: deviceName,
          devAppId: appId,
          ...(safeUrl !== null ? { devUrl: safeUrl } : {}),
        });
        transcript.system(
          session.id,
          platform === 'web'
            ? fill(copy.abilities.learnedRun, {
                command: cmd,
                url: safeUrl === null ? '' : fill(copy.abilities.learnedRunUrl, { url: safeUrl }),
              })
            : fill(copy.abilities.learnedRunDevice, {
                command: cmd,
                platform: copy.workspace.device.platforms[platform],
                device:
                  deviceName === null
                    ? ''
                    : fill(copy.abilities.learnedRunDeviceName, { device: deviceName }),
              }),
        );
        const project = repos.projects.get(session.projectId);
        activity.append({
          who: copy.agentProducts[session.agent],
          what: fill(copy.abilities.activityRun, {
            agent: copy.agentProducts[session.agent],
            project: project?.name ?? '',
          }),
          projectId: session.projectId,
          sessionId: session.id,
        });
        const live = runs.all().find((r) => r.projectId === session.projectId && r.phase !== 'exited');
        if (live === undefined) await runs.start(session.projectId, cmd, { platform }).catch(() => undefined);
      },
      rememberDeploy: async (sessionId, targetId, command) => {
        const session = repos.sessions.get(sessionId);
        if (!session) return;
        if (commandCarriesSecret(command)) {
          transcript.system(session.id, copy.abilities.secretInCommand);
          return;
        }
        const target = targets.setDeployCommand(targetId, command);
        const label = `${target.name} ${target.env}`;
        transcript.system(
          session.id,
          fill(copy.abilities.learnedDeploy, { target: label, command: command.trim() }),
        );
        const project = repos.projects.get(session.projectId);
        activity.append({
          who: copy.agentProducts[session.agent],
          what: fill(copy.abilities.activityDeploy, {
            agent: copy.agentProducts[session.agent],
            project: project?.name ?? '',
            target: label,
          }),
          projectId: session.projectId,
          sessionId: session.id,
        });
      },
    },
  });

  const checkpoints = new CheckpointService({
    repos,
    publisher,
    clock,
    git: gitRunner,
    transcript,
    rescanHunks: (id) => hunks.rescan(id),
    screens,
    // The running app's picture for a turn: the mirrored device when one is up, else the design window's page —
    // and only when that page is this project's (a live web run, or its saved dev URL when nothing runs).
    screenshot: async (projectId) => {
      const preview = opts.preview ?? NO_PREVIEW;
      // The page counts only when the window was set for this very project (two projects on the same port
      // must never trade pictures).
      const loaded = preview.loaded();
      const source = screenshotSourceFor({
        projectId,
        devices: devices.all(),
        runs: runs.all(),
        devUrl: repos.projects.settings(projectId).devUrl ?? null,
        loadedUrl: loaded !== null && loaded.projectId === projectId ? loaded.url : null,
      });
      if (source === 'device') return devices.screenshot(projectId);
      if (source === 'preview') return preview.capture();
      return null;
    },
    ...(opts.retentionMs !== undefined ? { pruneMs: opts.retentionMs } : {}),
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
    turnStarted: (id, messageId) => checkpoints.onTurnStarted(id, messageId),
    turnSettled: (id) => checkpoints.onTurnSettled(id),
    limitsReported: (limits) => usage.report(limits),
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
    skills,
    agents,
    runs,
    devices,
    screens,
    checkpoints,
    publish,
    laneSync,
    usage,
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
      checkpoints.start();
      if (opts.disableRefresh) refresh.disable();
      else refresh.start();
      await broker.listen();
    },
    async shutdown() {
      for (const s of repos.sessions.live()) broker.notifyStopping(s.id);
      retention.stop();
      checkpoints.stop();
      refresh.stop();
      cliWatch.stop();
      sessions.killAll();
      runs.stopAll();
      devices.shutdown();
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
