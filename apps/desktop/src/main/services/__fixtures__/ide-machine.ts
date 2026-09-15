import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DetectDeps, IdeDetection } from '../detect-service';

/**
 * A fake machine for IDE detection tests: every root DetectService probes (home, PATH, Applications, Program
 * Files, %LOCALAPPDATA% / %APPDATA%) lives in one temp dir, so a `win32` or `linux` layout can be tested on a Mac.
 * The `install*` helpers lay out one editor the way its installer does and return what detection should report.
 */
export interface FakeIdeMachine {
  platform: NodeJS.Platform;
  root: string;
  home: string;
  apps: string;
  programFiles: string;
  localAppData: string;
  appData: string;
  bins: string;
  /** Where `<Editor>/User` dirs live on this platform (Application Support, %APPDATA%, ~/.config). */
  configRoot: string;
  deps: DetectDeps;
  /** An executable `name` (`name.exe` on win32) on PATH whose `--version` prints `output`. */
  onPath(name: string, output: string): string;
  /** A macOS app bundle at `app` (a path or a name under /Applications) with a CFBundleShortVersionString. */
  bundle(app: string, version: string): string;
}

export const IDE_KINDS: readonly IdeDetection['kind'][] = [
  'vscode',
  'cursor',
  'windsurf',
  'zed',
  'jetbrains',
  'neovim',
];

const FIX = __dirname;

export function fakeIdeMachine(platform: NodeJS.Platform): FakeIdeMachine {
  const root = mkdtempSync(join(tmpdir(), `styx-ide-${platform}-`));
  const home = join(root, 'home');
  const apps = join(root, 'Applications');
  const programFiles = join(root, 'Program Files');
  const localAppData = join(home, 'AppData', 'Local');
  const appData = join(home, 'AppData', 'Roaming');
  const bins = join(root, 'bin');
  for (const d of [home, apps, programFiles, localAppData, appData, bins]) mkdirSync(d, { recursive: true });
  const configRoot =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? appData
        : join(home, '.config');
  const versions = new Map<string, string>();
  const deps: DetectDeps = {
    platform,
    home,
    pathEnv: bins,
    env: { SHELL: '/bin/sh', LOCALAPPDATA: localAppData, APPDATA: appData },
    applicationsDir: apps,
    programFilesDir: programFiles,
    exec: async (bin, args) =>
      args[0] === '--version'
        ? { stdout: versions.get(bin) ?? '', exitCode: 0 }
        : { stdout: '', exitCode: 0 },
  };
  return {
    platform,
    root,
    home,
    apps,
    programFiles,
    localAppData,
    appData,
    bins,
    configRoot,
    deps,
    onPath(name, output) {
      const p = join(bins, platform === 'win32' ? `${name}.exe` : name);
      writeFileSync(p, '#!/bin/sh\necho stub\n');
      chmodSync(p, 0o755);
      versions.set(p, output);
      return p;
    },
    bundle(app, version) {
      const path = app.includes('/') ? app : join(apps, `${app}.app`);
      writePlist(path, version);
      return path;
    },
  };
}

export function writePlist(app: string, version: string): void {
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict></plist>\n`,
  );
}

/** A `state.vscdb` (VS Code's SQLite key-value store) holding only the recents key. */
export function writeStateDb(file: string, recentsJson: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('history.recentlyOpenedPathsList', recentsJson);
  db.close();
}

export type VscodeLikeKind = 'vscode' | 'cursor' | 'windsurf';

const VSCODE_LIKE: Record<
  VscodeLikeKind,
  { product: string; macApp: string; winDir: string; userDirName: string; launcher: string }
> = {
  vscode: {
    product: 'VS Code',
    macApp: 'Visual Studio Code',
    winDir: 'Microsoft VS Code',
    userDirName: 'Code',
    launcher: 'code',
  },
  cursor: {
    product: 'Cursor',
    macApp: 'Cursor',
    winDir: 'cursor',
    userDirName: 'Cursor',
    launcher: 'cursor',
  },
  windsurf: {
    product: 'Windsurf',
    macApp: 'Windsurf',
    winDir: 'Windsurf',
    userDirName: 'Windsurf',
    launcher: 'windsurf',
  },
};

/** The `IdeDetection` fields a laid-out install should produce (`kind` / `found` added by the caller). */
export type Expected = Omit<IdeDetection, 'kind' | 'found'>;

/**
 * VS Code / Cursor / Windsurf the way their installers leave them: the app bundle (macOS) or `Programs\<dir>` with
 * `resources/app/package.json` + `bin\<cli>.cmd` (Windows), the CLI shim on PATH (unless `cli: false`), and the
 * fixture `User` dir (keybindings, settings, a built `state.vscdb`).
 */
export function installVscodeLike(
  m: FakeIdeMachine,
  kind: VscodeLikeKind,
  version: string,
  opts: { cli?: boolean } = {},
): Expected {
  const spec = VSCODE_LIKE[kind];
  let location: string | null = null;
  if (m.platform === 'darwin') location = m.bundle(spec.macApp, version);
  else if (m.platform === 'win32') {
    location = join(m.localAppData, 'Programs', spec.winDir);
    mkdirSync(join(location, 'resources', 'app'), { recursive: true });
    mkdirSync(join(location, 'bin'), { recursive: true });
    writeFileSync(
      join(location, 'resources', 'app', 'package.json'),
      JSON.stringify({ name: 'code-oss-dev', version }),
    );
    writeFileSync(join(location, 'bin', `${spec.launcher}.cmd`), '@echo off\r\n');
  }
  const cli = opts.cli === false ? null : m.onPath(spec.launcher, `${version}\n0123abcd\narm64`);
  const configDir = join(m.configRoot, spec.userDirName, 'User');
  mkdirSync(configDir, { recursive: true });
  copyFileSync(join(FIX, kind, 'User', 'keybindings.json'), join(configDir, 'keybindings.json'));
  copyFileSync(join(FIX, kind, 'User', 'settings.json'), join(configDir, 'settings.json'));
  writeStateDb(
    join(configDir, 'globalStorage', 'state.vscdb'),
    readFileSync(join(FIX, kind, 'recentlyOpened.json'), 'utf8'),
  );
  const launcher =
    cli ??
    (location === null
      ? null
      : m.platform === 'darwin'
        ? `open -a "${spec.macApp}"`
        : join(location, 'bin', `${spec.launcher}.cmd`));
  return {
    product: spec.product,
    version,
    location,
    launcher,
    configDir,
    imports: { recents: -1, keybindings: true, theme: true },
  };
}

/** Zed: `Zed.app` / `Programs\Zed\Zed.exe`, `zed` on PATH (unless `cli: false`), the fixture `settings.json` in its config dir. */
export function installZed(m: FakeIdeMachine, version: string, opts: { cli?: boolean } = {}): Expected {
  let location: string | null = null;
  if (m.platform === 'darwin') location = m.bundle('Zed', version);
  else if (m.platform === 'win32') {
    location = join(m.localAppData, 'Programs', 'Zed');
    mkdirSync(location, { recursive: true });
    writeFileSync(join(location, 'Zed.exe'), '');
  }
  const cli =
    opts.cli === false ? null : m.onPath('zed', `Zed ${version} – ${location ?? '/usr/local/bin/zed'}`);
  const configDir = m.platform === 'win32' ? join(m.appData, 'Zed') : join(m.home, '.config', 'zed');
  mkdirSync(configDir, { recursive: true });
  copyFileSync(join(FIX, 'zed', 'settings.json'), join(configDir, 'settings.json'));
  const launcher =
    cli ?? (location === null ? null : m.platform === 'darwin' ? 'open -a "Zed"' : join(location, 'Zed.exe'));
  return {
    product: 'Zed',
    version,
    location,
    launcher,
    configDir,
    imports: { recents: 0, keybindings: false, theme: true },
  };
}

export type JetbrainsProduct = 'WebStorm' | 'IntelliJ IDEA' | 'PyCharm';
const JETBRAINS: Record<JetbrainsProduct, { exe: string; sh: string; launcher: string }> = {
  WebStorm: { exe: 'webstorm64.exe', sh: 'webstorm.sh', launcher: 'webstorm' },
  'IntelliJ IDEA': { exe: 'idea64.exe', sh: 'idea.sh', launcher: 'idea' },
  PyCharm: { exe: 'pycharm64.exe', sh: 'pycharm.sh', launcher: 'pycharm' },
};

/** Toolbox 1.x `apps` dir on this platform. */
export const toolboxApps = (m: FakeIdeMachine): string =>
  m.platform === 'darwin'
    ? join(m.home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps')
    : m.platform === 'win32'
      ? join(m.localAppData, 'JetBrains', 'Toolbox', 'apps')
      : join(m.home, '.local', 'share', 'JetBrains', 'Toolbox', 'apps');

/**
 * One JetBrains IDE: `via: 'bundle'` = `<Product>.app` in Applications (macOS) / `Program Files\JetBrains\<Product
 * 2025.1>` (Windows) / the `webstorm` script on PATH (Linux); `via: 'toolbox'` = the Toolbox 1.x layout
 * `apps/<Product>/ch-0/<build>/…` on every platform. Returns the install root and the launcher detection reports.
 */
export function installJetbrains(
  m: FakeIdeMachine,
  product: JetbrainsProduct,
  version: string,
  via: 'bundle' | 'toolbox',
): { root: string; launcher: string } {
  const spec = JETBRAINS[product];
  const build = `${version.split('.').slice(0, 2).join('.')}`;
  if (m.platform === 'darwin') {
    const app =
      via === 'bundle'
        ? m.bundle(product, version)
        : join(toolboxApps(m), product, 'ch-0', build, `${product}.app`);
    if (via === 'toolbox') writePlist(app, version);
    return { root: app, launcher: `open -a "${product}"` };
  }
  if (via === 'bundle' && m.platform === 'linux') {
    const bin = m.onPath(spec.launcher, '');
    return { root: dirname(bin), launcher: bin };
  }
  const root =
    via === 'bundle'
      ? join(m.programFiles, 'JetBrains', `${product} ${build}`)
      : join(toolboxApps(m), product, 'ch-0', build);
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(
    join(root, 'product-info.json'),
    JSON.stringify({ name: product, version, buildNumber: build }),
  );
  const exe = join(root, 'bin', m.platform === 'win32' ? spec.exe : spec.sh);
  writeFileSync(exe, '');
  return { root, launcher: exe };
}

/** The fixture `recentProjects.xml` (3 entries) under this platform's JetBrains config dir. */
export function installJetbrainsRecents(m: FakeIdeMachine, dataDir = 'WebStorm2025.1'): number {
  const base =
    m.platform === 'darwin'
      ? join(m.home, 'Library', 'Application Support', 'JetBrains')
      : m.platform === 'win32'
        ? join(m.appData, 'JetBrains')
        : join(m.home, '.config', 'JetBrains');
  mkdirSync(join(base, dataDir, 'options'), { recursive: true });
  copyFileSync(
    join(FIX, 'jetbrains', 'recentProjects.xml'),
    join(base, dataDir, 'options', 'recentProjects.xml'),
  );
  return 3;
}

/** Neovim: `nvim` on PATH and the fixture shada file where Neovim writes it on this platform. */
export function installNeovim(m: FakeIdeMachine, version: string): Expected {
  const bin = m.onPath('nvim', `NVIM v${version}\nBuild type: Release`);
  const shada =
    m.platform === 'win32'
      ? join(m.localAppData, 'nvim-data', 'shada', 'main.shada')
      : join(m.home, '.local', 'share', 'nvim', 'shada', 'main.shada');
  mkdirSync(dirname(shada), { recursive: true });
  copyFileSync(join(FIX, 'nvim', 'main.shada'), shada);
  return {
    product: 'Neovim',
    version,
    location: dirname(bin),
    launcher: bin,
    configDir: null,
    imports: { recents: -1, keybindings: false, theme: false },
  };
}

/** Every supported editor installed the usual way for the platform; returns what detection should report per kind. */
export function installAll(m: FakeIdeMachine): Record<IdeDetection['kind'], Expected> {
  const jb = installJetbrains(m, 'WebStorm', '2025.1.3', m.platform === 'linux' ? 'toolbox' : 'bundle');
  const recents = installJetbrainsRecents(m);
  return {
    vscode: installVscodeLike(m, 'vscode', '1.104.0'),
    cursor: installVscodeLike(m, 'cursor', '1.7.28'),
    windsurf: installVscodeLike(m, 'windsurf', '1.12.5'),
    zed: installZed(m, '0.201.6'),
    jetbrains: {
      product: 'JetBrains (WebStorm)',
      version: '2025.1.3',
      location: jb.root,
      launcher: jb.launcher,
      configDir: null,
      imports: { recents, keybindings: false, theme: false },
    },
    neovim: installNeovim(m, '0.11.2'),
  };
}
