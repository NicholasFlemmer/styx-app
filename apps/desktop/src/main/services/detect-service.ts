import { execa } from 'execa';
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { CliCandidate, CliInstall, CliSource } from '@styx/core';

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'cursor' | 'shell';
export type AuthState = 'signed-in' | 'signed-out' | 'unknown' | 'n/a';
export type { CliCandidate, CliSource };

export interface CliDetection {
  agent: AgentKind;
  label: string;
  binary: string | null;
  version: string | null;
  found: boolean;
  authState: AuthState;
  capabilities: Record<string, boolean>;
  /** Where `binary` came from; null when nothing was found (or for the shell). */
  source: CliSource | null;
  /** Every runnable binary found for the agent, the chosen one included (Settings "Detected CLIs" Select). */
  alternatives: CliCandidate[];
}

/** Manual "Locate binary" picks per agent (`cli.binary.<agent>` in app_settings); a pick that vanished is ignored. */
export type CliOverrides = Partial<Record<Exclude<AgentKind, 'shell'>, string>>;

export interface IdeDetection {
  kind: 'vscode' | 'cursor' | 'windsurf' | 'zed' | 'jetbrains' | 'neovim';
  /** "VS Code", "Cursor", "Windsurf", "Zed", "JetBrains (WebStorm)", "Neovim" (spec §4.9 rows). */
  product: string;
  version: string | null;
  /** The app bundle / install dir, or the binary's dir for PATH-only installs (Neovim); null when unknown. */
  location: string | null;
  /**
   * What `openInIde` runs (services/open-in-ide.ts): a binary on PATH (`code`, `zed`, `nvim`…), a Windows install's
   * `bin\code.cmd` / `bin\webstorm64.exe`, or `open -a "<App>"` for a macOS bundle without a CLI shim.
   */
  launcher: string | null;
  /** VS Code-likes: the `User` dir; Zed: its config dir (settings.json); null for JetBrains / Neovim. */
  configDir: string | null;
  /** `recents: -1` = present, counted lazily by IdeImportService (state.vscdb / shada); JetBrains counts entries. */
  imports: { recents: number; keybindings: boolean; theme: boolean };
  found: boolean;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  home: string;
  pathEnv: string;
  env: NodeJS.ProcessEnv;
  exec: (bin: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
  /** macOS `/Applications` (the Claude desktop app and every IDE bundle are looked up there); injectable for tests. */
  applicationsDir?: string;
  /** Windows `%PROGRAMFILES%` (per-machine VS Code / JetBrains installs); defaults to the env var; injectable for tests. */
  programFilesDir?: string;
}

const CLIS: { agent: AgentKind; label: string; bins: string[] }[] = [
  { agent: 'claude', label: 'Claude Code', bins: ['claude'] },
  { agent: 'codex', label: 'Codex', bins: ['codex'] },
  { agent: 'gemini', label: 'Gemini CLI', bins: ['gemini'] },
  { agent: 'cursor', label: 'Cursor agent', bins: ['cursor-agent', 'agent'] },
  { agent: 'shell', label: 'Shell', bins: [] },
];

/** IDE extension bundles that ship their own Claude Code binary (`resources/native-binary/claude`). */
const CLAUDE_EXTENSION_BUNDLES: { dir: string[]; source: CliSource }[] = [
  { dir: ['.vscode', 'extensions'], source: 'vscode-extension' },
  { dir: ['.cursor', 'extensions'], source: 'cursor-extension' },
];
const CLAUDE_EXTENSION_PREFIX = 'anthropic.claude-code-';
const BUNDLE_SEARCH_DEPTH = 4;

const SOURCE_RANK: Record<CliSource, number> = {
  manual: 0,
  path: 1,
  'vscode-extension': 2,
  'cursor-extension': 3,
  'desktop-app': 4,
};

export function defaultDeps(pathEnv: string = process.env['PATH'] ?? ''): DetectDeps {
  return {
    platform: process.platform,
    home: homedir(),
    pathEnv,
    env: process.env,
    exec: async (bin, args) => {
      const r = await execa(bin, args, {
        reject: false,
        timeout: 8000,
        env: { ...process.env, PATH: pathEnv, NO_COLOR: '1' },
      });
      return { stdout: String(r.stdout ?? '') + '\n' + String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
    },
  };
}

const isExecutableFile = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const exeNames = (name: string, platform: NodeJS.Platform): string[] =>
  (platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']).map((ext) => name + ext);

/** `which -a` semantics: every executable `name` on PATH, in PATH order (duplicates by resolved path removed). */
export function findAllOnPath(name: string, pathEnv: string, platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const file of exeNames(name, platform)) {
      const p = join(dir, file);
      if (!isExecutableFile(p)) continue;
      const key = realKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

export function findOnPath(name: string, pathEnv: string, platform: NodeJS.Platform): string | null {
  return findAllOnPath(name, pathEnv, platform)[0] ?? null;
}

const realKey = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Executable files called `name` under `root`, at most `depth` directories down (bounded walk, symlinks not followed). */
function findExecutables(root: string, names: readonly string[], depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0) walk(p, left - 1);
      } else if (names.includes(e.name) && isExecutableFile(p)) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

/** Numeric semver compare on `major.minor.patch`; a missing version sorts lowest, a prerelease below its release. */
export function compareVersions(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.]+))?/.exec(v);
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] ?? null } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? -1 : 1;
  for (let i = 0; i < 3; i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** `have` satisfies `need` when it is the same version or newer. */
export const versionSatisfies = (have: string | null, need: string): boolean =>
  have !== null && compareVersions(have, need) >= 0;

/** Highest version wins; ties go to the earlier source (PATH before extension bundles, then discovery order). */
export function pickBest(candidates: readonly CliCandidate[]): CliCandidate | null {
  let best: CliCandidate | null = null;
  for (const c of candidates) {
    if (best === null) {
      best = c;
      continue;
    }
    const d = compareVersions(c.version, best.version);
    if (d > 0 || (d === 0 && SOURCE_RANK[c.source] < SOURCE_RANK[best.source])) best = c;
  }
  return best;
}

const notFound = (agent: AgentKind, label: string): CliDetection => ({
  agent,
  label,
  binary: null,
  version: null,
  found: false,
  authState: 'unknown',
  capabilities: {},
  source: null,
  alternatives: [],
});

/** The persisted row for a detection: `source` and `alternatives` ride along in `capabilities_json` (no migration). */
export const toCliInstall = (c: CliDetection, checkedAt: number): CliInstall => ({
  agent: c.agent,
  binary: c.binary,
  version: c.version,
  found: c.found,
  authState: c.authState,
  capabilities: {
    ...c.capabilities,
    ...(c.source === null ? {} : { source: c.source }),
    ...(c.alternatives.length === 0 ? {} : { alternatives: c.alternatives }),
  },
  checkedAt,
  // Connection fields belong to AgentService (`agent.verify`); a fresh detection knows nothing about them.
  account: null,
  verifiedAt: null,
  verifyError: null,
});

interface ProbeCache {
  key: string;
  version: string | null;
  help: string | null;
}

/**
 * Detects agent CLIs — every PATH hit (`which -a`), the VS Code / Cursor extension bundles and the Claude desktop app
 * for `claude` — with version and auth state; the highest version wins. Sign-in stays the CLI's own flow.
 * `--version` / `--help` results are cached per binary (mtime + size), so re-detecting before a spawn or on window
 * focus is a handful of stats once the binaries have been probed.
 */
export class DetectService {
  private readonly cache = new Map<string, ProbeCache>();

  constructor(private readonly deps: DetectDeps = defaultDeps()) {}

  async detectClis(overrides: CliOverrides = {}): Promise<CliDetection[]> {
    const out: CliDetection[] = [];
    for (const c of CLIS) {
      if (c.agent === 'shell') {
        out.push(await this.detectShell());
        continue;
      }
      out.push(await this.detectAgent(c.agent, overrides[c.agent] ?? null));
    }
    return out;
  }

  /** One agent: candidates → highest version, unless a still-existing manual pick overrides it. */
  async detectAgent(
    agent: Exclude<AgentKind, 'shell'>,
    override: string | null = null,
  ): Promise<CliDetection> {
    const spec = CLIS.find((c) => c.agent === agent) ?? { agent, label: agent, bins: [agent] };
    const candidates = await this.candidates(agent, spec.bins);
    if (override !== null && existsSync(override)) {
      const manual: CliCandidate = { binary: override, version: null, source: 'manual' };
      const probed = await this.probe(agent, override, { source: 'manual', alternatives: [] });
      if (probed.found) {
        manual.version = probed.version;
        const key = realKey(override);
        const rest = candidates.filter((x) => realKey(x.binary) !== key);
        return { ...probed, alternatives: [manual, ...rest] };
      }
    }
    const best = pickBest(candidates);
    if (best === null) return notFound(agent, spec.label);
    return this.probe(agent, best.binary, {
      version: best.version,
      source: best.source,
      alternatives: candidates,
    });
  }

  /** Every runnable binary for the agent with its `--version` (cached), in discovery order. */
  async candidates(agent: Exclude<AgentKind, 'shell'>, bins: readonly string[]): Promise<CliCandidate[]> {
    const found: { binary: string; source: CliSource }[] = [];
    const seen = new Set<string>();
    const add = (binary: string, source: CliSource) => {
      const key = realKey(binary);
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ binary, source });
    };
    for (const b of bins)
      for (const p of findAllOnPath(b, this.deps.pathEnv, this.deps.platform)) add(p, 'path');
    if (agent === 'claude') {
      const names = exeNames('claude', this.deps.platform);
      for (const bundle of CLAUDE_EXTENSION_BUNDLES) {
        const root = join(this.deps.home, ...bundle.dir);
        let dirs: string[];
        try {
          dirs = readdirSync(root).filter((d) => d.startsWith(CLAUDE_EXTENSION_PREFIX));
        } catch {
          continue;
        }
        for (const d of dirs.sort())
          for (const p of findExecutables(join(root, d), names, BUNDLE_SEARCH_DEPTH)) add(p, bundle.source);
      }
      if (this.deps.platform === 'darwin') {
        const app = join(this.deps.applicationsDir ?? '/Applications', 'Claude.app');
        if (existsSync(app))
          for (const p of findExecutables(join(app, 'Contents'), names, BUNDLE_SEARCH_DEPTH))
            add(p, 'desktop-app');
      }
    }
    const out: CliCandidate[] = [];
    for (const f of found) out.push({ ...f, version: await this.versionOf(f.binary) });
    return out;
  }

  /**
   * Version, capabilities and auth state of one agent binary — the winning candidate, or a path the user picked with
   * "Locate binary" (`source: 'manual'` by default). `found` follows whether the file exists; an unrunnable file still
   * reports `found: false`.
   */
  async probe(
    agent: Exclude<AgentKind, 'shell'>,
    binary: string,
    opts: { version?: string | null; source?: CliSource; alternatives?: CliCandidate[] } = {},
  ): Promise<CliDetection> {
    const label = CLIS.find((c) => c.agent === agent)?.label ?? agent;
    const source = opts.source ?? 'manual';
    const alternatives = opts.alternatives ?? [];
    if (!existsSync(binary)) return { ...notFound(agent, label), binary };
    const version = opts.version === undefined ? await this.versionOf(binary) : opts.version;
    const help = await this.helpOf(binary);
    const capabilities: Record<string, boolean> = {
      mcpConfigFlag: /--mcp-config/.test(help),
      settingsFlag: /--settings/.test(help),
      streamJson: /stream-json/.test(help),
      printMode: /(^|\s)(-p|--print)\b/.test(help),
      configOverride: /(^|\s)-c,? ?(--config)?\b/.test(help) || /--config/.test(help),
    };
    return {
      agent,
      label,
      binary,
      version,
      found: true,
      authState: this.authState(agent),
      capabilities,
      source,
      alternatives: alternatives.length === 0 ? [{ binary, version, source }] : alternatives,
    };
  }

  /** Forget cached `--version` / `--help` output (a binary that changed in place is re-probed anyway via mtime+size). */
  invalidate(): void {
    this.cache.clear();
  }

  private statKey(binary: string): string | null {
    try {
      const st = statSync(binary);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  private async versionOf(binary: string): Promise<string | null> {
    const key = this.statKey(binary);
    const hit = this.cache.get(binary);
    if (key !== null && hit !== undefined && hit.key === key) return hit.version;
    const v = await this.deps.exec(binary, ['--version']);
    const version = parseVersion(v.stdout);
    if (key !== null) this.cache.set(binary, { key, version, help: null });
    return version;
  }

  private async helpOf(binary: string): Promise<string> {
    const key = this.statKey(binary);
    const hit = this.cache.get(binary);
    if (key !== null && hit !== undefined && hit.key === key && hit.help !== null) return hit.help;
    const help = (await this.deps.exec(binary, ['--help'])).stdout;
    if (key !== null) this.cache.set(binary, { key, version: hit?.key === key ? hit.version : null, help });
    return help;
  }

  private async detectShell(): Promise<CliDetection> {
    if (this.deps.platform === 'win32') {
      const pwsh =
        findOnPath('pwsh', this.deps.pathEnv, 'win32') ??
        findOnPath('powershell', this.deps.pathEnv, 'win32');
      const wsl = findOnPath('wsl', this.deps.pathEnv, 'win32');
      const v = pwsh
        ? parseVersion(
            (await this.deps.exec(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']))
              .stdout,
          )
        : null;
      return {
        agent: 'shell',
        label: 'Shell',
        binary: pwsh,
        version: v ? `pwsh ${v}${wsl ? ' · WSL available' : ''}` : null,
        found: !!pwsh,
        authState: 'n/a',
        capabilities: { wsl: !!wsl },
        source: null,
        alternatives: [],
      };
    }
    const shell = this.deps.env['SHELL'] || '/bin/zsh';
    const name = shell.split('/').pop() ?? 'sh';
    const v = await this.deps.exec(shell, ['--version']);
    return {
      agent: 'shell',
      label: 'Shell',
      binary: shell,
      version: `${name} ${parseVersion(v.stdout) ?? ''}`.trim(),
      found: existsSync(shell),
      authState: 'n/a',
      capabilities: {},
      source: null,
      alternatives: [],
    };
  }

  /** Auth is inferred from each CLI's own credential locations; Styx never reads the secrets themselves. */
  authState(agent: AgentKind): AuthState {
    const h = this.deps.home;
    const exists = (...p: string[]) => existsSync(join(...p));
    switch (agent) {
      case 'claude':
        return exists(h, '.claude', '.credentials.json') ||
          !!this.deps.env['ANTHROPIC_API_KEY'] ||
          (this.deps.platform === 'darwin' && exists(h, '.claude.json'))
          ? 'signed-in'
          : 'signed-out';
      case 'codex':
        return exists(this.deps.env['CODEX_HOME'] ?? join(h, '.codex'), 'auth.json') ||
          !!this.deps.env['OPENAI_API_KEY']
          ? 'signed-in'
          : 'signed-out';
      case 'gemini':
        return exists(h, '.gemini', 'oauth_creds.json') || !!this.deps.env['GEMINI_API_KEY']
          ? 'signed-in'
          : 'signed-out';
      case 'cursor':
        return exists(h, '.cursor', 'cli-config.json') || exists(h, '.config', 'cursor-agent')
          ? 'signed-in'
          : 'unknown';
      default:
        return 'n/a';
    }
  }

  // --- IDEs ----------------------------------------------------------------------

  /**
   * Editors, in the order Onboarding lists them: the VS Code family (VS Code, Cursor and Windsurf share one layout),
   * Zed, the first JetBrains IDE in preference order, Neovim. Every probed root comes from `deps` (home, PATH,
   * Applications, Program Files, %LOCALAPPDATA% / %APPDATA%) so tests lay out a fake machine per platform.
   */
  async detectIdes(): Promise<IdeDetection[]> {
    const out: IdeDetection[] = [];
    for (const spec of VSCODE_LIKE_IDES) out.push(await this.detectVscodeLike(spec));
    out.push(await this.detectZed());
    out.push(this.detectJetbrains());
    out.push(await this.detectNeovim());
    return out;
  }

  private get applicationsDir(): string {
    return this.deps.applicationsDir ?? '/Applications';
  }

  private get programFilesDir(): string {
    return this.deps.programFilesDir ?? this.deps.env['PROGRAMFILES'] ?? 'C:\\Program Files';
  }

  private get localAppData(): string {
    return this.deps.env['LOCALAPPDATA'] ?? join(this.deps.home, 'AppData', 'Local');
  }

  private get appData(): string {
    return this.deps.env['APPDATA'] ?? join(this.deps.home, 'AppData', 'Roaming');
  }

  private get xdgConfig(): string {
    return this.deps.env['XDG_CONFIG_HOME'] ?? join(this.deps.home, '.config');
  }

  /** `<name>.app` in /Applications or ~/Applications. */
  private macBundle(name: string): string | null {
    return (
      [join(this.applicationsDir, `${name}.app`), join(this.deps.home, 'Applications', `${name}.app`)].find(
        existsSync,
      ) ?? null
    );
  }

  private async detectVscodeLike(spec: VscodeLikeSpec): Promise<IdeDetection> {
    const { platform: p, home: h } = this.deps;
    const location =
      p === 'darwin'
        ? this.macBundle(spec.macApp)
        : p === 'win32'
          ? ([join(this.localAppData, 'Programs', spec.winDir), join(this.programFilesDir, spec.winDir)].find(
              existsSync,
            ) ?? null)
          : null;
    const configDir =
      p === 'darwin'
        ? join(h, 'Library', 'Application Support', spec.userDirName, 'User')
        : p === 'win32'
          ? join(this.appData, spec.userDirName, 'User')
          : join(this.xdgConfig, spec.userDirName, 'User');
    const bin = findOnPath(spec.launcher, this.deps.pathEnv, p);
    let version = location ? readVscodeVersion(location, p) : null;
    if (version === null && bin) version = parseVersion((await this.deps.exec(bin, ['--version'])).stdout);
    const found = !!location || !!bin;
    // Bundle without the CLI shim: macOS opens it by name; a Windows install ships `bin\<launcher>.cmd`.
    const shim = location && p === 'win32' ? join(location, 'bin', `${spec.launcher}.cmd`) : null;
    const launcher =
      bin ??
      (location && p === 'darwin' ? `open -a "${spec.macApp}"` : shim && existsSync(shim) ? shim : null);
    return {
      kind: spec.kind,
      product: spec.product,
      version,
      location,
      launcher,
      configDir: existsSync(configDir) ? configDir : null,
      imports: found ? this.vscodeImports(configDir) : noImports(),
      found,
    };
  }

  private vscodeImports(userDir: string): { recents: number; keybindings: boolean; theme: boolean } {
    const keybindings = existsSync(join(userDir, 'keybindings.json'));
    const theme = fileMatches(join(userDir, 'settings.json'), /"workbench\.colorTheme"|"editor\.fontFamily"/);
    // -1 = present, count resolved lazily by IdeImportService (legacy state.vscdb key, or workspaceStorage on 1.10x+).
    const hasRecents =
      existsSync(join(userDir, 'globalStorage', 'state.vscdb')) ||
      existsSync(join(userDir, 'workspaceStorage'));
    return { recents: hasRecents ? -1 : 0, keybindings, theme };
  }

  /**
   * Zed: `Zed.app` / `%LOCALAPPDATA%\Programs\Zed` / `zed` on PATH (`zed --version` → "Zed 0.201.6 – …"); config in
   * `~/.config/zed` (`%APPDATA%\Zed` on Windows). Theme + font import from `settings.json`; no recents, no keybindings.
   */
  private async detectZed(): Promise<IdeDetection> {
    const p = this.deps.platform;
    const location =
      p === 'darwin'
        ? this.macBundle('Zed')
        : p === 'win32'
          ? ([join(this.localAppData, 'Programs', 'Zed'), join(this.programFilesDir, 'Zed')].find(
              existsSync,
            ) ?? null)
          : null;
    const configDir = p === 'win32' ? join(this.appData, 'Zed') : join(this.xdgConfig, 'zed');
    const bin = findOnPath('zed', this.deps.pathEnv, p);
    let version = location && p === 'darwin' ? readPlistVersion(location) : null;
    if (version === null && bin) version = parseVersion((await this.deps.exec(bin, ['--version'])).stdout);
    const exe = location && p === 'win32' ? join(location, 'Zed.exe') : null;
    const launcher =
      bin ?? (location && p === 'darwin' ? 'open -a "Zed"' : exe && existsSync(exe) ? exe : null);
    const found = !!location || !!bin;
    return {
      kind: 'zed',
      product: 'Zed',
      version,
      location,
      launcher,
      configDir: existsSync(configDir) ? configDir : null,
      imports: found
        ? {
            recents: 0,
            keybindings: false,
            theme: fileMatches(join(configDir, 'settings.json'), /"theme"|"buffer_font_family"/),
          }
        : noImports(),
      found,
    };
  }

  /**
   * One JetBrains row: the first product in `JETBRAINS_IDES` order that is installed; for a product, a bundle
   * (Applications, Program Files, `Programs\<Product>`) beats its Toolbox 1.x copy, which beats a bare PATH launcher.
   * A Toolbox `apps` dir holding only unknown products still counts as found (no launcher).
   */
  private detectJetbrains(): IdeDetection {
    let hit: JetbrainsInstall | null = null;
    for (const spec of JETBRAINS_IDES) {
      hit = this.jetbrainsBundle(spec) ?? this.jetbrainsToolbox(spec) ?? this.jetbrainsOnPath(spec);
      if (hit) break;
    }
    const toolbox = this.jetbrainsToolboxApps();
    const found = hit !== null || existsSync(toolbox);
    return {
      kind: 'jetbrains',
      product: hit ? `JetBrains (${hit.spec.product})` : 'JetBrains',
      version: hit?.version ?? null,
      location: hit?.root ?? (existsSync(toolbox) ? toolbox : null),
      launcher: hit?.launcher ?? null,
      configDir: null,
      imports: { recents: found ? this.countJetbrainsRecents() : 0, keybindings: false, theme: false },
      found,
    };
  }

  /** Toolbox 1.x `apps` dir (per platform); Toolbox 2 installs into ~/Applications or `Programs` instead. */
  private jetbrainsToolboxApps(): string {
    const { platform: p, home: h } = this.deps;
    return p === 'darwin'
      ? join(h, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps')
      : p === 'win32'
        ? join(this.localAppData, 'JetBrains', 'Toolbox', 'apps')
        : join(this.deps.env['XDG_DATA_HOME'] ?? join(h, '.local', 'share'), 'JetBrains', 'Toolbox', 'apps');
  }

  /** Where the IDEs keep `<Product><version>/options/recentProjects.xml`. */
  private jetbrainsConfigBase(): string {
    const { platform: p, home: h } = this.deps;
    return p === 'darwin'
      ? join(h, 'Library', 'Application Support', 'JetBrains')
      : p === 'win32'
        ? join(this.appData, 'JetBrains')
        : join(this.xdgConfig, 'JetBrains');
  }

  private jetbrainsBundle(spec: JetbrainsSpec): JetbrainsInstall | null {
    const p = this.deps.platform;
    if (p === 'darwin') {
      const app = this.macBundle(spec.product);
      return app ? this.jetbrainsMacApp(spec, app) : null;
    }
    if (p === 'win32') {
      for (const base of [join(this.programFilesDir, 'JetBrains'), join(this.localAppData, 'Programs')]) {
        const root = dirsStartingWith(base, spec.product).find((d) => existsSync(join(d, 'bin', spec.exe)));
        if (root) return this.jetbrainsRoot(spec, root);
      }
    }
    return null;
  }

  /** Toolbox 2 (`~/Applications/JetBrains Toolbox/<Product>.app`) and Toolbox 1 (`apps/<dir>/ch-0/<build>/…`). */
  private jetbrainsToolbox(spec: JetbrainsSpec): JetbrainsInstall | null {
    const { platform: p, home: h } = this.deps;
    const apps = this.jetbrainsToolboxApps();
    if (p === 'darwin') {
      const app2 = join(h, 'Applications', 'JetBrains Toolbox', `${spec.product}.app`);
      if (existsSync(app2)) return this.jetbrainsMacApp(spec, app2);
      for (const dir of dirsMatching(apps, spec.toolbox)) {
        const app = findEntries(dir, `${spec.product}.app`, 'dir', TOOLBOX_DEPTH)[0];
        if (app) return this.jetbrainsMacApp(spec, app);
      }
      return null;
    }
    const name = p === 'win32' ? spec.exe : `${spec.launcher}.sh`;
    for (const dir of dirsMatching(apps, spec.toolbox)) {
      const exe = findEntries(dir, name, 'file', TOOLBOX_DEPTH)[0];
      if (exe) return this.jetbrainsRoot(spec, dirname(dirname(exe)));
    }
    return null;
  }

  /** Toolbox shell scripts / "Create Command-line Launcher": `webstorm` on PATH, install location unknown. */
  private jetbrainsOnPath(spec: JetbrainsSpec): JetbrainsInstall | null {
    const bin = findOnPath(spec.launcher, this.deps.pathEnv, this.deps.platform);
    return bin ? { spec, root: dirname(bin), version: null, launcher: bin } : null;
  }

  private jetbrainsMacApp(spec: JetbrainsSpec, app: string): JetbrainsInstall {
    return {
      spec,
      root: app,
      version: readPlistVersion(app) ?? readProductInfoVersion(join(app, 'Contents', 'Resources')),
      launcher: `open -a "${spec.product}"`,
    };
  }

  /** Windows: the install's `bin\<product>64.exe` when it exists; Linux: the PATH launcher, else `bin/<product>.sh`. */
  private jetbrainsRoot(spec: JetbrainsSpec, root: string): JetbrainsInstall {
    const p = this.deps.platform;
    const exe = join(root, 'bin', p === 'win32' ? spec.exe : `${spec.launcher}.sh`);
    const onPath = findOnPath(spec.launcher, this.deps.pathEnv, p);
    const bundled = existsSync(exe) ? exe : null;
    return {
      spec,
      root,
      version: readProductInfoVersion(root),
      launcher: p === 'win32' ? (bundled ?? onPath) : (onPath ?? bundled),
    };
  }

  private countJetbrainsRecents(): number {
    const base = this.jetbrainsConfigBase();
    try {
      let n = 0;
      for (const d of readdirSync(base)) {
        const f = join(base, d, 'options', 'recentProjects.xml');
        if (existsSync(f)) n += (readFileSync(f, 'utf8').match(/<entry key=/g) ?? []).length;
      }
      return n;
    } catch {
      return 0;
    }
  }

  private async detectNeovim(): Promise<IdeDetection> {
    const { platform: p, home: h } = this.deps;
    const nvim = findOnPath('nvim', this.deps.pathEnv, p);
    const version = nvim ? parseVersion((await this.deps.exec(nvim, ['--version'])).stdout) : null;
    const shada =
      p === 'win32'
        ? join(this.localAppData, 'nvim-data', 'shada', 'main.shada')
        : join(h, '.local', 'share', 'nvim', 'shada', 'main.shada');
    return {
      kind: 'neovim',
      product: 'Neovim',
      version,
      location: nvim ? dirname(nvim) : null,
      launcher: nvim,
      configDir: null,
      imports: { recents: nvim && existsSync(shada) ? -1 : 0, keybindings: false, theme: false },
      found: !!nvim,
    };
  }
}

interface VscodeLikeSpec {
  kind: 'vscode' | 'cursor' | 'windsurf';
  product: string;
  /** `<macApp>.app` under /Applications or ~/Applications. */
  macApp: string;
  /** `%LOCALAPPDATA%\Programs\<winDir>` (user setup) or `%PROGRAMFILES%\<winDir>` (system setup). */
  winDir: string;
  /** `<userDirName>/User` under Application Support, %APPDATA% or ~/.config. */
  userDirName: string;
  /** CLI shim on PATH; also `bin\<launcher>.cmd` inside a Windows install. */
  launcher: string;
}

const VSCODE_LIKE_IDES: readonly VscodeLikeSpec[] = [
  {
    kind: 'vscode',
    product: 'VS Code',
    macApp: 'Visual Studio Code',
    winDir: 'Microsoft VS Code',
    userDirName: 'Code',
    launcher: 'code',
  },
  {
    kind: 'cursor',
    product: 'Cursor',
    macApp: 'Cursor',
    winDir: 'cursor',
    userDirName: 'Cursor',
    launcher: 'cursor',
  },
  {
    kind: 'windsurf',
    product: 'Windsurf',
    macApp: 'Windsurf',
    winDir: 'Windsurf',
    userDirName: 'Windsurf',
    launcher: 'windsurf',
  },
];

interface JetbrainsSpec {
  product: string;
  /** Windows launcher inside `bin\`; the Linux one is `bin/<launcher>.sh`. */
  exe: string;
  /** Command-line launcher name (Toolbox scripts, "Create Command-line Launcher"). */
  launcher: string;
  /** Toolbox 1.x `apps/<dir>` name prefixes, lower-case (`IDEA-U` / `IDEA-C`, `PyCharm-P` / `PyCharm-C`…). */
  toolbox: readonly string[];
}

/** Preference order when several are installed (one JetBrains row, spec §4.9); the first found wins. */
const JETBRAINS_IDES: readonly JetbrainsSpec[] = [
  { product: 'WebStorm', exe: 'webstorm64.exe', launcher: 'webstorm', toolbox: ['webstorm'] },
  { product: 'IntelliJ IDEA', exe: 'idea64.exe', launcher: 'idea', toolbox: ['idea', 'intellij'] },
  { product: 'PyCharm', exe: 'pycharm64.exe', launcher: 'pycharm', toolbox: ['pycharm'] },
  { product: 'GoLand', exe: 'goland64.exe', launcher: 'goland', toolbox: ['goland'] },
  { product: 'RustRover', exe: 'rustrover64.exe', launcher: 'rustrover', toolbox: ['rustrover'] },
  { product: 'PhpStorm', exe: 'phpstorm64.exe', launcher: 'phpstorm', toolbox: ['phpstorm'] },
  { product: 'CLion', exe: 'clion64.exe', launcher: 'clion', toolbox: ['clion'] },
  { product: 'Rider', exe: 'rider64.exe', launcher: 'rider', toolbox: ['rider'] },
  { product: 'RubyMine', exe: 'rubymine64.exe', launcher: 'rubymine', toolbox: ['rubymine'] },
];

interface JetbrainsInstall {
  spec: JetbrainsSpec;
  /** The `.app` (macOS) or the install root holding `bin\` and `product-info.json`; the bin dir for PATH-only. */
  root: string;
  version: string | null;
  launcher: string | null;
}

/** `apps/<Product>/ch-0/<build>/bin/<exe>` and `…/<build>/<Product>.app`: three levels below the app dir. */
const TOOLBOX_DEPTH = 3;

const noImports = (): IdeDetection['imports'] => ({ recents: 0, keybindings: false, theme: false });

export function parseVersion(s: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(s);
  return m?.[1] ?? null;
}

/** `true` when the file exists and its text matches `re`; unreadable files never match. */
function fileMatches(file: string, re: RegExp): boolean {
  try {
    return re.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Entries called `name` of the given kind under `root`, at most `depth` directories down (bounded walk, no symlinks). */
function findEntries(root: string, name: string, kind: 'file' | 'dir', depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))) {
      const p = join(dir, e.name);
      if (e.name === name && (kind === 'dir' ? e.isDirectory() : e.isFile())) out.push(p);
      else if (e.isDirectory() && left > 0) walk(p, left - 1);
    }
  };
  walk(root, depth);
  return out;
}

/** Sub-directories of `base` whose lower-cased name starts with one of `prefixes`, newest name first. */
function dirsMatching(base: string, prefixes: readonly string[]): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && prefixes.some((x) => e.name.toLowerCase().startsWith(x)))
      .map((e) => join(base, e.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** `JetBrains\WebStorm 2025.1`, `Programs\PyCharm Community Edition 2024.1`…: dirs named after the product. */
const dirsStartingWith = (base: string, product: string): string[] =>
  dirsMatching(base, [product.toLowerCase()]);

function readVscodeVersion(location: string, platform: NodeJS.Platform): string | null {
  const candidates =
    platform === 'darwin'
      ? [join(location, 'Contents', 'Resources', 'app', 'package.json')]
      : [join(location, 'resources', 'app', 'package.json')];
  for (const c of candidates) {
    try {
      const v = (JSON.parse(readFileSync(c, 'utf8')) as { version?: string }).version;
      if (v) return v;
    } catch {
      /* next */
    }
  }
  return platform === 'darwin' ? readPlistVersion(location) : null;
}

function readPlistVersion(app: string): string | null {
  try {
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** JetBrains `product-info.json` (`{ "name": "WebStorm", "version": "2024.3.1", … }`) in an install root. */
function readProductInfoVersion(dir: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(dir, 'product-info.json'), 'utf8')) as { version?: unknown })
      .version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}
