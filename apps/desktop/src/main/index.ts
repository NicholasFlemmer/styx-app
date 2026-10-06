import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification as OsNotification,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences,
  Tray,
  webContents,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { autoUpdater } from 'electron-updater';
import { execa } from 'execa';
import { brokerEndpoint } from '@styx/broker';
import { copy, type AppSettings } from '@styx/core';
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
import type { Updater } from './services/update-service';
import {
  FakeMfaProvider,
  PolkitProvider,
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

// `styx-device://frame/<project>` and `styx-device://checkpoint/<id>/<side>`: pictures of the running app for the
// design window and the checkpoint review (the renderer's CSP allows no file: images). Registered before ready,
// as Electron requires; served from the container's ScreensStore once it exists.
protocol.registerSchemesAsPrivileged([
  { scheme: 'styx-device', privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);
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
// Windows and Linux hand a link that started Styx in argv (macOS sends `open-url`); handled once the app is up.
if (process.platform !== 'darwin') {
  const coldUrl = process.argv.find((a) => a.startsWith('styx://'));
  if (coldUrl) pendingUrl = coldUrl;
}
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
  // STYX_MFA fakes the OS prompt for tests and dev runs only. A packaged build ignores it: an agent runs as the person
  // and could otherwise relaunch Styx with STYX_MFA=auto and approve its own production grants.
  if (!app.isPackaged && env['STYX_MFA'] === 'auto') return new FakeMfaProvider('ok');
  if (!app.isPackaged && env['STYX_MFA'] === 'deny') return new FakeMfaProvider('failed');
  if (isMac) return new TouchIdProvider(systemPreferences);
  if (platform === 'win32') return new WindowsHelloProvider();
  if (platform === 'linux') return new PolkitProvider();
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

/**
 * The menu bar (#124). Electron's default menus, plus a Help menu that opens the walkthrough and the feedback
 * dialog in the main window and links to the website. Built once at boot; the window picks the action up as a
 * `menu.action` event.
 */
function installAppMenu(): void {
  const send = (action: 'tour' | 'feedback') => {
    if (!container) return;
    container.windows.focusMain();
    container.publisher.sendEvent('menu.action', { action });
  };
  const m = copy.tour.menu;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' as const },
      { role: 'editMenu' as const },
      { role: 'viewMenu' as const },
      { role: 'windowMenu' as const },
      {
        role: 'help' as const,
        label: m.help,
        submenu: [
          { label: m.tour, click: () => send('tour') },
          { label: m.feedback, click: () => send('feedback') },
          { type: 'separator' as const },
          { label: m.site, click: () => void shell.openExternal('https://heystyx.com') },
        ],
      },
    ]),
  );
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
  // Unpackaged (dev, e2e), from the bundle's own place (apps/desktop/out/main): `app.getAppPath()` is the script's
  // folder when Electron is started on a file (Playwright on Windows), which put the CLI under apps/desktop/packages.
  const desktopDir = resolve(__dirname, '..', '..');
  const resourcesDir = app.isPackaged
    ? join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources')
    : resolve(desktopDir, 'resources');
  const cliPath = app.isPackaged
    ? join(resourcesDir, 'cli', 'styx.js')
    : resolve(desktopDir, '..', '..', 'packages', 'cli', 'dist', 'styx.js');
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
    largerThanScreen: env['STYX_E2E'] === '1',
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

  installAppMenu();
  container = buildContainer({
    // A packaged build a person is using, or one pointed at a local API on purpose; never dev, fixtures or e2e.
    sendUsage:
      env['STYX_API'] !== undefined || (app.isPackaged && fixtureName === null && env['STYX_E2E'] !== '1'),
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
    preview: new PreviewService({
      mainWindow: () => windowService.mainWindow() ?? null,
      onStatus: (status) => container?.publisher.sendEvent('preview.status', status),
    }),
    // A selection on the Design canvas, as a picture for the agent (#140): only ever the asking window's own pixels.
    captureWindow: async (senderId, rect) => {
      const wc = webContents.fromId(senderId);
      if (wc === undefined || wc.isDestroyed()) return null;
      const image = await wc.capturePage(rect);
      return image.isEmpty() ? null : image.toPNG();
    },
    deviceHooks: {
      windowSources: async () =>
        (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).map(
          (s) => ({ id: s.id, name: s.name }),
        ),
      screenAccess: () => (isMac ? systemPreferences.getMediaAccessStatus('screen') : 'n/a'),
      // The one non-https URL Styx opens: the OS privacy pane where the live mirror gets Screen Recording.
      openScreenAccess: () =>
        isMac
          ? shell.openExternal(
              'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
            )
          : Promise.resolve(),
    },
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
    updater: realUpdater(fixtureName),
  });
  applyAppSettings(repos.settings.app());

  container.bus.attach(ipcMain);
  attachPtyChannel(ipcMain, container);
  // Pictures of the running app: the design window's mirrored device and the checkpoint screenshots.
  protocol.handle('styx-device', async (request) => {
    const png = await container?.screens.resolve(request.url);
    return png
      ? new Response(new Uint8Array(png), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
        })
      : new Response(null, { status: 404 });
  });
  // The renderer's `getDisplayMedia` gets exactly the simulator window `device.mirror` armed, once; never a picker,
  // never the whole screen. Anything else asking is refused.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Only Styx's own renderer, in a registered window, gets the armed window; the design window's page lives
      // on its own partition and never reaches this handler at all.
      const c = container;
      const frame = request.frame;
      const wc = frame === null ? undefined : webContents.fromFrame(frame);
      const ours =
        c !== null &&
        request.videoRequested &&
        wc !== undefined &&
        c.publisher.isRegistered(wc.id) &&
        c.bus.originAllowed(request.securityOrigin);
      const source = ours ? c.devices.takeArmedSource() : null;
      if (source === null) {
        callback({});
        return;
      }
      callback({ video: { id: source.id, name: source.name } });
    },
    { useSystemPicker: false },
  );
  notifications.start(repos.pendingAsks.openAll().length);
  try {
    await container.start();
  } catch (e) {
    logger.error('broker listen failed', { endpoint, error: (e as Error).message });
  }
  // The heartbeat (discrepancy row 114): one count per launch is what daily actives and retention are made of.
  container.usageReports.record('app.launched');
  // #125: a run that did not quit cleanly (a crash, a force quit, the Mac losing power) leaves this marker behind,
  // and the next launch counts it. Only the fact is sent; nothing about what was running.
  runMarker = join(userData, 'running');
  if (existsSync(runMarker)) container.usageReports.record('app.ended-unexpectedly');
  writeFileSync(runMarker, String(Date.now()));
  // #125: crashes while running, as counts. A window's page that died for any reason but a clean exit, and a
  // helper process (graphics, network, a utility) that crashed or ran out of memory.
  app.on('render-process-gone', (_e, _wc, details) => {
    if (details.reason !== 'clean-exit') container?.usageReports.record('app.crashed.window');
  });
  app.on('child-process-gone', (_e, details) => {
    if (['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit'].includes(details.reason))
      container?.usageReports.record('app.crashed.helper');
  });

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
  app.on('browser-window-focus', () => {
    void container?.refresh.runNow('focus');
    // A release published while Styx was open is found when the person comes back to it (#119).
    void container?.updates.onFocus();
  });

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

/**
 * electron-updater's `autoUpdater` for a packaged build (#119, #147): macOS, Windows and a Linux AppImage, never under a
 * fixture or the e2e harness, and only when the build carries its feed (`app-update.yml`, written by electron-builder
 * from `publish` in electron-builder.yml). `STYX_UPDATE_URL` points a build at another feed (a local one when testing
 * an update end to end). macOS installs an update only if it carries the running app's signature; Windows does once
 * its builds are signed, and checks the feed's sha512 until then.
 */
function realUpdater(fixture: string | null): Updater | null {
  if (!app.isPackaged || fixture !== null || env['STYX_E2E'] === '1') return null;
  // Linux: only an AppImage updates itself (electron-updater swaps the file); a .deb belongs to the package manager.
  if (!isMac && platform !== 'win32' && !(platform === 'linux' && env['APPIMAGE'])) return null;
  // A Microsoft Store install is updated by the Store; electron-updater must not try to replace it.
  if (process.windowsStore === true) return null;
  const override = env['STYX_UPDATE_URL'];
  const feedFile = join(process.resourcesPath, 'app-update.yml');
  if (override === undefined && !existsSync(feedFile)) return null;
  // Windows (owner decision 2026-10-03, row #147): an unsigned build updates in place too. electron-updater checks an
  // update's signature only against the publisher named in app-update.yml, which a build has only once it is signed
  // (WIN_CSC_LINK); until then the installer is checked against the sha512 in latest.yml, both fetched over HTTPS
  // from the release bucket the download link already serves. A signed build names its publisher and gets the full
  // signature check without any change here.
  const updater = autoUpdater;
  updater.logger = {
    info: (m: unknown) => logger.info('updater', { message: String(m) }),
    warn: (m: unknown) => logger.warn('updater', { message: String(m) }),
    error: (m: unknown) => logger.warn('updater', { message: String(m).split('\n')[0] }),
    debug: (m: unknown) => logger.debug('updater', { message: String(m) }),
  };
  if (override !== undefined && /^https?:\/\//.test(override))
    updater.setFeedURL({ provider: 'generic', url: override });
  return updater;
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
/** `<userData>/running` while the app runs; removed on a clean quit (#125). */
let runMarker: string | null = null;
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
      // A clean quit: the next launch should not count this run as ended unexpectedly (#125).
      if (runMarker !== null) rmSync(runMarker, { force: true });
      app.quit();
    });
});
