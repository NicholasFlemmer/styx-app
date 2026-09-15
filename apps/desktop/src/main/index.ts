import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification as OsNotification,
  powerMonitor,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { brokerEndpoint } from '@styx/broker';
import type { AppSettings } from '@styx/core';
import { clockFromEnv } from './clock';
import { buildContainer, type Container, type DialogsPort, type WindowsPort } from './container';
import { openDatabase } from './db/open';
import { Repos } from './db/repos';
import { isFixtureName, loadFixture, seed, seedDefaults } from './db/seed';
import { seedDemoRepos } from './db/seed-repos';
import { attachPtyChannel } from './ipc/pty-channel';
import { createVault } from './services/credential-vault';
import { seedFixtureVault } from './db/seed-vault';
import { logger } from './services/logger';
import {
  FakeMfaProvider,
  TouchIdProvider,
  WindowsHelloProvider,
  type MfaProvider,
} from './services/mfa-service';
import { NotificationService, type AskSummary } from './services/notification-service';
import { launchArgs } from './services/open-in-ide';
import { ElectronOsNotifier, type ElectronLike } from './services/os-notifier';
import { writeShims } from './services/shim-service';
import { fixtureCatalogueFetch, fixtureSkillsFetch } from './services/skills-fixture';
import { PreviewService } from './services/preview-service';
import { rendererPaths, WindowService } from './services/window-service';

const env = process.env;
const platform = process.platform;
const isMac = platform === 'darwin';
const fixtureName = isFixtureName(env['STYX_FIXTURE']) ? env['STYX_FIXTURE'] : null;

// --- userData: explicit override, else a temp dir whenever a fixture is requested so real data is never touched.
if (env['STYX_USER_DATA']) app.setPath('userData', env['STYX_USER_DATA']);
else if (fixtureName) app.setPath('userData', mkdtempSync(join(tmpdir(), `styx-${fixtureName}-`)));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

if (env['STYX_THEME'] === 'dark' || env['STYX_THEME'] === 'light' || env['STYX_THEME'] === 'system')
  nativeTheme.themeSource = env['STYX_THEME'];

let container: Container | null = null;
let windows: WindowService | null = null;
let osNotifierRef: ElectronOsNotifier | null = null;
let pendingUrl: string | null = null;

const resolvedTheme = (): 'dark' | 'light' => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

/** Dev/e2e switches for the preload (`window.styx.env`), never secrets. */
const bootEnv = (): string[] => {
  const e: Record<string, unknown> = { resolvedTheme: resolvedTheme() };
  if (fixtureName) e['fixture'] = fixtureName;
  if (env['STYX_SCREEN']) e['screen'] = env['STYX_SCREEN'];
  if (env['STYX_THEME']) e['theme'] = env['STYX_THEME'];
  if (env['STYX_CHROME']) e['chrome'] = env['STYX_CHROME'];
  if (env['STYX_NOW'] && Number.isFinite(Number(env['STYX_NOW']))) e['now'] = Number(env['STYX_NOW']);
  if (env['STYX_E2E'] === '1') e['e2e'] = true;
  return [`--styx-env=${Buffer.from(JSON.stringify(e)).toString('base64')}`];
};

/** `styx://ask/<id>/review|later` (OS toast buttons) and `styx://open?path=` ("Open in Styx"). */
async function handleUrl(url: string): Promise<void> {
  if (!container) {
    pendingUrl = url;
    return;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'styx:') return;
  const { repos, publisher, projects } = container;
  if (u.host === 'ask') {
    const [, askId, action] = u.pathname.split('/');
    const ask = askId ? repos.pendingAsks.get(askId) : null;
    if (!ask) return;
    if (action === 'later') {
      for (const n of repos.notifications.byAsk(ask.id)) {
        if (n.state !== 'shown') continue;
        repos.notifications.upsert({ ...n, state: 'later' });
        publisher.upsert('notifications', [n.id]);
      }
      return;
    }
    container.windows.focusMain();
    publisher.sendEvent('ask.opened', {
      askId: ask.id,
      sessionId: ask.sessionId,
      projectId: (repos.sessions.get(ask.sessionId)?.projectId ?? '') as never,
    });
    return;
  }
  if (u.host === 'open') {
    const path = u.searchParams.get('path');
    if (!path) return;
    // Any app or web page can fire `styx://open?path=`; the user confirms before a folder becomes a project.
    if (env['STYX_E2E'] !== '1') {
      container.windows.focusMain();
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Add project', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Add this folder as a Styx project?',
        detail: path,
      });
      if (response !== 0) return;
    }
    try {
      const p = await projects.add(path);
      projects.select(p.id);
      container.windows.focusMain();
    } catch (e) {
      logger.warn('styx://open failed', { error: (e as Error).message });
    }
  }
}

app.on('open-url', (e, url) => {
  e.preventDefault();
  void handleUrl(url);
});
app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => a.startsWith('styx://'));
  if (url) void handleUrl(url);
  windows?.openMain();
});

/** Random per-user suffix for the Windows pipe name (L2), persisted in userData so shims and restarts agree. */
function brokerPipeSecret(userData: string): string {
  const file = join(userData, 'broker-secret');
  try {
    const cur = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{16,}$/.test(cur)) return cur;
  } catch {
    /* first run */
  }
  const secret = randomBytes(12).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function mfaProvider(): MfaProvider {
  if (env['STYX_MFA'] === 'auto') return new FakeMfaProvider('ok');
  if (env['STYX_MFA'] === 'deny') return new FakeMfaProvider('failed');
  if (isMac) return new TouchIdProvider(systemPreferences);
  if (platform === 'win32') return new WindowsHelloProvider();
  return new FakeMfaProvider('unavailable');
}

/** Real Electron surface for `ElectronOsNotifier` (spec §4.14: dock badge/bounce/menu on macOS, tray + Action Center on Windows). */
function electronSurface(): ElectronLike {
  return {
    platform,
    dock:
      isMac && app.dock
        ? {
            setBadge: (t) => app.dock?.setBadge(t),
            bounce: (k) => void app.dock?.bounce(k),
            setMenu: (m) => app.dock?.setMenu(m as Menu),
          }
        : null,
    createTray: (image) => new Tray(image as Electron.NativeImage),
    buildMenu: (template) =>
      Menu.buildFromTemplate(
        template.map((i) =>
          i.type === 'separator'
            ? { type: 'separator' as const }
            : {
                label: i.label,
                type: i.type ?? 'normal',
                ...(i.checked !== undefined ? { checked: i.checked } : {}),
                click: i.click ?? (() => undefined),
              },
        ),
      ),
    imageFromDataUrl: (url) => nativeImage.createFromDataURL(url),
    notificationsSupported: () => OsNotification.isSupported(),
    createNotification: (opts) => new OsNotification(opts),
    setOverlayIcon: (image, description) =>
      windows?.mainWindow()?.setOverlayIcon(image as Electron.NativeImage | null, description),
  };
}

async function boot(): Promise<void> {
  const userData = app.getPath('userData');
  const vault = createVault(env['STYX_KEYCHAIN']);
  const clock = clockFromEnv(env);
  const dbFile = join(userData, 'styx.db');
  if (env['STYX_FIXTURE_RESET'] === '1' && existsSync(dbFile)) rmSync(dbFile);
  const db = openDatabase(dbFile);
  const repos = new Repos(db, () => clock.now());
  // A fixture's skills live in a seeded home under userData (never the real ~/.claude etc.), and the catalogue is
  // answered offline (`skills-fixture.ts`); e2e runs get the offline fetch for everything so nothing leaves the box.
  const fixtureHome = fixtureName !== null ? join(userData, 'fixture-home') : null;
  if (fixtureName !== null && fixtureHome !== null) {
    const demoRepos = (fixtureName === 'demo' || fixtureName === 'error') && env['STYX_DEMO_REPOS'] !== '0';
    const { seeded } = seed(repos, loadFixture(fixtureName), {
      reset: env['STYX_FIXTURE_RESET'] === '1',
      skillsHome: fixtureHome,
      // Project skills go into the demo acme-shop checkout before seed-repos commits it, so they ride in its
      // init commit instead of showing up as untracked changes on the main lane (same path seed-repos uses).
      ...(demoRepos ? { skillsProjectDir: join(userData, 'demo-repos', 'acme-shop') } : {}),
    });
    logger.info('fixture', { name: fixtureName, seeded, userData });
    if (demoRepos) {
      // Real git repos behind the fixture rows so fs.*, worktree.diff, hunks and terminals work on the demo.
      await seedDemoRepos({ repos, userData, fixture: fixtureName }).catch((e: Error) =>
        logger.warn('demo repos failed', { error: e.message }),
      );
    }
  } else seedDefaults(repos, clock.now());
  if (fixtureName && env['STYX_KEYCHAIN'] === 'memory') {
    const n = await seedFixtureVault(vault, repos.targets.all());
    logger.info('fixture vault', { seeded: n });
  }

  const shims = writeShims(userData, platform);
  // Packaged: `resources/**` is asarUnpack'd (electron-builder.yml) so the CLI and templates are real files the shims,
  // MCP server and `fs.cp` can reach: <Resources>/app.asar.unpacked/resources/…, never <Resources>/cli (that path was
  // wrong until 2026-09-07 and every shim exec'd a missing file).
  const resourcesDir = app.isPackaged
    ? join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources')
    : resolve(app.getAppPath(), 'resources');
  const cliPath = app.isPackaged
    ? join(resourcesDir, 'cli', 'styx.js')
    : resolve(app.getAppPath(), '../../packages/cli/dist/styx.js');
  if (!existsSync(cliPath)) logger.error('styx cli not found: agent shims and MCP will fail', { cliPath });
  else logger.info('runtime paths', { cliPath, resourcesDir });
  const endpoint = brokerEndpoint({
    platform,
    uid: process.getuid?.() ?? 0,
    username: userInfo().username,
    userData,
    tmpdir: tmpdir(),
    ...(platform === 'win32' ? { secret: brokerPipeSecret(userData) } : {}),
  });
  const paths = rendererPaths(__dirname);
  const rendererUrl = env['ELECTRON_RENDERER_URL'];
  const rendererOrigins = ['file://', ...(rendererUrl ? [new URL(rendererUrl).origin] : [])];

  const windowService = new WindowService({
    windowState: repos.windowState,
    preloadPath: paths.preloadPath,
    rendererFile: paths.rendererFile,
    rendererUrl,
    platform,
    additionalArguments: bootEnv,
    onWindowCreated: (win) => container?.publisher.register(win.webContents),
    onWindowClosed: (id) => container?.publisher.unregister(id),
  });
  windows = windowService;

  const windowsPort: WindowsPort = {
    popoutSessionIds: () => windowService.popoutSessionIds(),
    openPopout: (id) => void windowService.openPopout(id),
    dockPopout: (id) => windowService.dockPopout(id),
    openDock: () => void windowService.openDock(),
    closeDock: () => windowService.closeDock(),
    dockOpen: () => windowService.dockOpen(),
    control: (senderId, target, action) => {
      const win =
        target.window === 'popout' && target.sessionId
          ? windowService.popoutWindow(target.sessionId)
          : (BrowserWindow.getAllWindows().find((w) => w.webContents.id === senderId) ??
            windowService.mainWindow());
      if (win) windowService.control(win, action);
    },
    focusMain: () => {
      const w = windowService.openMain();
      if (w.isMinimized()) w.restore();
      w.focus();
    },
  };

  /** Native pickers, parented to the main window so they sheet on macOS; new folders may be created inline. */
  const openDialog = async (
    properties: NonNullable<Electron.OpenDialogOptions['properties']>,
    opts: {
      title?: string | undefined;
      defaultPath?: string | undefined;
      filters?: Electron.FileFilter[] | undefined;
    },
  ): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      properties,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.defaultPath !== undefined
        ? { defaultPath: opts.defaultPath.replace(/^~(?=$|[\\/])/, homedir()) }
        : {}),
      ...(opts.filters !== undefined ? { filters: opts.filters } : {}),
    };
    const win = windowService.mainWindow();
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  };
  const dialogsPort: DialogsPort = {
    pickFolder: (opts) => openDialog(['openDirectory', 'createDirectory'], opts),
    pickFile: (opts) => openDialog(['openFile', 'showHiddenFiles'], opts),
  };

  const osNotifier = new ElectronOsNotifier(electronSurface(), resolvedTheme);
  osNotifierRef = osNotifier;
  const notifications = new NotificationService(
    osNotifier,
    repos.uiState,
    platform,
    {
      review: (ask: AskSummary) => void handleUrl(`styx://ask/${ask.askId}/review`),
      later: (ask: AskSummary) => void handleUrl(`styx://ask/${ask.askId}/later`),
      // Tray left-click / dock menu: focus the main window and switch to the Agents board (`nav.go`).
      openBoard: () => {
        windowsPort.focusMain();
        container?.publisher.sendEvent('nav.go', { screen: 'agents' });
      },
    },
    () => repos.settings.app().notify === 'badge-sound',
  );
  // DND is persisted in app_settings (`dnd`) and mirrored into ui_state for the service; settings win after a restart.
  notifications.setDnd(repos.settings.app().dnd);

  const applyAppSettings = (s: AppSettings) => {
    if (!env['STYX_THEME']) nativeTheme.themeSource = s.theme;
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });
  };

  container = buildContainer({
    disableRefresh: fixtureName !== null && env['STYX_KEYCHAIN'] === 'memory',
    // Fixture rows are fake binaries; re-detecting would swap them for whatever this machine has.
    redetectClis: fixtureName === null,
    ...(fixtureHome !== null ? { skillsHome: fixtureHome } : {}),
    ...(env['STYX_E2E'] === '1'
      ? { fetch: fixtureSkillsFetch }
      : fixtureHome !== null
        ? { fetch: fixtureCatalogueFetch(fetch) }
        : {}),
    db,
    clock,
    vault,
    mfaProvider: mfaProvider(),
    runtime: {
      userData,
      platform,
      shimDir: shims.dir,
      cliPath,
      exePath: process.execPath,
      brokerEndpoint: endpoint,
      resourcesDir,
      rendererOrigins,
    },
    windows: windowsPort,
    preview: new PreviewService({ mainWindow: () => windowService.mainWindow() ?? null }),
    dialogs: dialogsPort,
    notifications,
    openExternal: (url) =>
      /^https:\/\//.test(url)
        ? shell.openExternal(url)
        : Promise.reject(new Error('only https urls open externally')),
    openInIde: async (launcher, path) => {
      const l = launchArgs(launcher, path, process.platform);
      await execa(l.file, l.args, { shell: l.shell, detached: l.detached, stdio: 'ignore' });
    },
    onAppSettings: applyAppSettings,
  });
  applyAppSettings(repos.settings.app());

  container.bus.attach(ipcMain);
  attachPtyChannel(ipcMain, container);
  notifications.start(repos.pendingAsks.openAll().length);
  try {
    await container.start();
  } catch (e) {
    logger.error('broker listen failed', { endpoint, error: (e as Error).message });
  }

  nativeTheme.on('updated', () => {
    windowService.applyTheme();
    container?.publisher.sendEvent('theme.resolved', { theme: resolvedTheme() });
  });
  // Connected targets stay honest without babysitting: re-probe on wake and on focus (plus the 30 min interval).
  powerMonitor.on('resume', () => {
    // Wi-Fi comes back a few seconds after the lid opens; probing before that would look like every login is gone.
    setTimeout(() => {
      if (net.isOnline()) void container?.refresh.runNow('wake');
    }, 5000).unref?.();
  });
  app.on('browser-window-focus', () => void container?.refresh.runNow('focus'));

  windowService.openMain();
  if (pendingUrl) {
    const u = pendingUrl;
    pendingUrl = null;
    void handleUrl(u);
  }

  if (!fixtureName) {
    // Refresh discovery in the background on a real profile (the fixture already carries its own rows).
    const c = container;
    void c.bus.dispatchInternal('detect.clis', {}).catch(() => undefined);
    void c.bus.dispatchInternal('detect.ides', {}).catch(() => undefined);
  }
}

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('styx');
  if (platform === 'win32') app.setAppUserModelId('dev.styx.app');
  void boot().catch((e: Error) => {
    logger.error('boot failed', { error: e.message, stack: e.stack });
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows?.openMain();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !container) return;
  e.preventDefault();
  quitting = true;
  const c = container;
  container = null;
  void c
    .shutdown()
    .catch((err: Error) => logger.warn('shutdown error', { error: err.message }))
    .finally(() => {
      osNotifierRef?.dispose();
      app.quit();
    });
});
