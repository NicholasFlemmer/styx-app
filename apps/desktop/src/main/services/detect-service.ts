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
import { fallbackShell } from './pty-service';
import type { CliCandidate, CliInstall, CliSource } from '@styx/core';

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'shell';
export type AuthState = 'signed-in' | 'signed-out' | 'unknown' | 'n/a';
export type { CliCandidate, CliSource };

/** Why a "Locate binary" pick was refused (`probe` → `detect.setBinary`): the file exists but is not this CLI. */
export type CliProblem =
  | { kind: 'directory' }
  | { kind: 'not-runnable' }
  | { kind: 'other-agent'; agent: Exclude<AgentKind, 'shell'> };

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
  /** The folders this detection scanned (login PATH + install folders that exist): the not-installed row's "Show where". */
  searched: string[];
  /** Set on a `found: false` probe of an existing path: what was wrong with it. */
  problem?: CliProblem;
}

/** One detection run's search space, computed once and shared by every agent (`DetectService.search`). */
export interface SearchSpace {
  /** Login-shell PATH first, then whatever the process had; PATH-separator joined. */
  pathEnv: string;
  /** Vendor / package-manager install folders that exist and are not already on `pathEnv`. */
  wellKnown: string[];
  /** The shell's `command -v` answer per CLI name (aliases resolved, shims included). */
  which: Record<string, string>;
  searched: string[];
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
  /** `opts.PATH` is the run's search space (login PATH + install folders), so version-manager shims can answer. */
  exec: (
    bin: string,
    args: string[],
    opts?: { PATH: string },
  ) => Promise<{ stdout: string; exitCode: number }>;
  /**
   * What the user's terminal sees (PtyService.resolveLoginEnv): the login shell's PATH and its `command -v` answer
   * per CLI name. Absent (tests, fixtures) = the process PATH only, which for a Dock-launched app is nearly empty.
   */
  login?: () => Promise<{ path: string; which: Record<string, string> }>;
  /**
   * Machine-wide install folders off the PATH (`/opt/homebrew/bin`, `/usr/local/bin`, Linuxbrew; `Program Files\nodejs`)
   * — everything else `wellKnownBinDirs` lists sits under `home`. Injectable so a test with a temp home never
   * scans the developer's real Homebrew.
   */
  systemBinDirs?: readonly string[];
  /** macOS `/Applications` (the Claude desktop app and every IDE bundle are looked up there); injectable for tests. */
  applicationsDir?: string;
  /** Windows `%PROGRAMFILES%` (per-machine VS Code / JetBrains installs); defaults to the env var; injectable for tests. */
  programFilesDir?: string;
  /** Where editor launchers land when they are not on PATH (Homebrew, /usr/local). `defaultDeps` fills it; tests leave it empty. */
  launcherDirs?: readonly string[];
  /** Styx's own tool folders (what agent setup installed, e.g. Gemini on a private Node.js); scanned as source `styx`. */
  styxDirs?: () => readonly string[];
}

const DEFAULT_LAUNCHER_DIRS: readonly string[] = ['/usr/local/bin', '/opt/homebrew/bin'];

const CLIS: { agent: AgentKind; label: string; bins: string[] }[] = [
  { agent: 'claude', label: 'Claude Code', bins: ['claude'] },
  { agent: 'codex', label: 'Codex', bins: ['codex'] },
  { agent: 'gemini', label: 'Gemini CLI', bins: ['gemini'] },
  { agent: 'cursor', label: 'Cursor agent', bins: ['cursor-agent', 'agent'] },
  { agent: 'opencode', label: 'OpenCode', bins: ['opencode'] },
  { agent: 'shell', label: 'Shell', bins: [] },
];

/**
 * Editor extension folders that may hold an agent's own binary: Anthropic's Claude Code extension
 * (`resources/native-binary/claude`) and OpenAI's (`bin/<platform>/codex`). Owner request: an agent that came with
 * your editor is used as it is, not installed a second time.
 */
const EXTENSION_ROOTS: { dir: string[]; source: CliSource }[] = [
  { dir: ['.vscode', 'extensions'], source: 'vscode-extension' },
  { dir: ['.vscode-insiders', 'extensions'], source: 'vscode-extension' },
  { dir: ['.cursor', 'extensions'], source: 'cursor-extension' },
  { dir: ['.windsurf', 'extensions'], source: 'windsurf-extension' },
];
const EXTENSION_PREFIXES: Partial<Record<Exclude<AgentKind, 'shell'>, string>> = {
  claude: 'anthropic.claude-code-',
  codex: 'openai.chatgpt-',
};
const BUNDLE_SEARCH_DEPTH = 4;

/** What each CLI's `--version` output names itself; a pick whose output names a different agent is refused. */
const AGENT_MARKERS: Readonly<Record<Exclude<AgentKind, 'shell'>, RegExp>> = {
  claude: /claude/i,
  codex: /codex/i,
  gemini: /gemini/i,
  cursor: /cursor/i,
  // `opencode --version` prints the bare number (1.18.35), so this only ever matches other output that names it.
  opencode: /opencode/i,
};

/** Provider keys OpenCode reads from the environment (a subset: the common providers). */
export const OPENCODE_KEY_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
];

const otherAgentIn = (
  agent: Exclude<AgentKind, 'shell'>,
  output: string,
): Exclude<AgentKind, 'shell'> | null => {
  if (AGENT_MARKERS[agent].test(output)) return null;
  for (const [other, re] of Object.entries(AGENT_MARKERS) as [Exclude<AgentKind, 'shell'>, RegExp][]) {
    if (other !== agent && re.test(output)) return other;
  }
  return null;
};

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const SOURCE_RANK: Record<CliSource, number> = {
  manual: 0,
  path: 1,
  shell: 2,
  'well-known': 3,
  'vscode-extension': 4,
  'cursor-extension': 5,
  'windsurf-extension': 6,
  'desktop-app': 7,
  styx: 8,
};

export function defaultDeps(
  pathEnv: string = process.env['PATH'] ?? '',
  login?: DetectDeps['login'],
): DetectDeps {
  return {
    platform: process.platform,
    home: homedir(),
    pathEnv,
    env: process.env,
    ...(login === undefined ? {} : { login }),
    systemBinDirs: systemBinDirs(process.platform, process.env),
    launcherDirs: DEFAULT_LAUNCHER_DIRS,
    exec: async (bin, args, opts) => {
      const r = await execa(bin, args, {
        reject: false,
        timeout: 8000,
        env: { ...process.env, PATH: opts?.PATH ?? pathEnv, NO_COLOR: '1' },
      });
      return { stdout: String(r.stdout ?? '') + '\n' + String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
    },
  };
}

/**
 * Folders the vendors' installers and the usual package / version managers write CLIs to, whether or not the
 * shell's PATH lists them (#98): Claude's and Cursor's native installers → `~/.local/bin`; the Homebrew casks
 * (claude-code, codex, gemini-cli) → `/opt/homebrew/bin` or `/usr/local/bin`; npm globals under nvm / fnm / volta /
 * bun / pnpm / yarn; asdf and mise shims; the old `claude migrate-installer` dir; OpenCode's installer →
 * `~/.opencode/bin`. Windows: `%USERPROFILE%\.local\bin`
 * (the native installers), `%APPDATA%\npm`, WinGet's links, scoop shims, pnpm, bun, volta. Names only — the caller
 * keeps the ones that exist. nvm / fnm versions are listed newest first so a tie on CLI version stays deterministic.
 */
export function systemBinDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return [join(env['ProgramFiles'] ?? 'C:\\Program Files', 'nodejs')];
  return ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
}

export function wellKnownBinDirs(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  system: readonly string[] = [],
): string[] {
  const under = (root: string, ...sub: string[]): string[] => {
    try {
      return readdirSync(root)
        .sort((a, b) => compareVersions(parseVersion(b.replace(/^v/, '')), parseVersion(a.replace(/^v/, ''))))
        .map((v) => join(root, v, ...sub));
    } catch {
      return [];
    }
  };
  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return [
      join(home, '.local', 'bin'),
      join(appData, 'npm'),
      join(local, 'Microsoft', 'WinGet', 'Links'),
      join(local, 'pnpm'),
      join(home, '.bun', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, 'scoop', 'shims'),
      ...system,
    ];
  }
  return [
    join(home, '.local', 'bin'),
    ...system,
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.claude', 'local'),
    join(home, '.opencode', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
    ...under(join(home, '.nvm', 'versions', 'node'), 'bin'),
    ...under(join(home, '.local', 'share', 'fnm', 'node-versions'), 'installation', 'bin'),
    ...under(join(home, '.fnm', 'node-versions'), 'installation', 'bin'),
  ];
}

/** PATH entries in order, blanks and repeats dropped (case-insensitively on Windows). */
const uniqueDirs = (dirs: readonly string[], platform: NodeJS.Platform): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    const key = platform === 'win32' ? d.toLowerCase() : d;
    if (d === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
};

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
  searched: [],
});

/** The persisted row for a detection: `source`, `alternatives` and `searched` ride along in `capabilities_json` (no migration). */
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
    ...(c.searched.length === 0 ? {} : { searched: c.searched }),
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
  /** `--version` exit code and combined output, so a pick can be judged runnable and as the right agent. */
  exitCode: number;
  output: string;
  help: string | null;
}

/**
 * Detects agent CLIs the way the user's terminal would (#98): every hit on the login shell's PATH (`which -a`), the
 * shell's own `command -v` answers (aliases, version-manager shims), the vendors' install folders that are not on
 * the PATH (`wellKnownBinDirs`), the VS Code / Cursor extension bundles and the Claude desktop app for `claude` —
 * with version and auth state; the highest version wins. Sign-in stays the CLI's own flow. `--version` / `--help`
 * results are cached per binary (mtime + size), so re-detecting before a spawn or on window focus is a handful of
 * stats once the binaries have been probed. Every run reports the folders it scanned (`onSearched`) so the
 * CliWatchService can watch exactly those.
 */
export class DetectService {
  private readonly cache = new Map<string, ProbeCache>();
  /** Told the folders each run scanned (the CLI watcher); set by the container. */
  onSearched: ((dirs: string[]) => void) | null = null;
  private lastSearched: string[] = [];
  private execPath = '';

  constructor(private readonly deps: DetectDeps = defaultDeps()) {}

  async detectClis(overrides: CliOverrides = {}): Promise<CliDetection[]> {
    const space = await this.search();
    const out: CliDetection[] = [];
    for (const c of CLIS) {
      if (c.agent === 'shell') {
        out.push(await this.detectShell());
        continue;
      }
      out.push(await this.detectAgent(c.agent, overrides[c.agent] ?? null, space));
    }
    return out;
  }

  /**
   * The run's search space: the login shell's PATH (then whatever the process had), the install folders that exist
   * off that PATH, and the shell's `command -v` answers. The folders scanned are remembered for `probe` and handed
   * to `onSearched`.
   */
  async search(): Promise<SearchSpace> {
    const login = this.deps.login === undefined ? null : await this.deps.login().catch(() => null);
    const sep = this.deps.platform === 'win32' ? ';' : ':';
    const pathDirs = uniqueDirs(
      [...(login?.path ?? '').split(sep), ...this.deps.pathEnv.split(sep)],
      this.deps.platform,
    );
    const onPath = new Set(pathDirs.map(realKey));
    const wellKnown = wellKnownBinDirs(
      this.deps.home,
      this.deps.platform,
      this.deps.env,
      this.deps.systemBinDirs ?? [],
    ).filter((d) => existsSync(d) && !onPath.has(realKey(d)));
    const searched = [...pathDirs.filter((d) => existsSync(d)), ...wellKnown];
    this.execPath = [...pathDirs, ...wellKnown].join(sep);
    this.lastSearched = searched;
    this.onSearched?.(searched);
    return { pathEnv: pathDirs.join(sep), wellKnown, which: login?.which ?? {}, searched };
  }

  /** The folders the last detection scanned. */
  searchedDirs(): readonly string[] {
    return this.lastSearched;
  }

  /**
   * A bare command name typed into the Connect modal's path field (#98): the shell's own answer first, then the
   * search space. Null when nothing runnable carries that name.
   */
  async resolveName(name: string): Promise<string | null> {
    const space = await this.search();
    const hit = space.which[name];
    if (hit !== undefined && isExecutableFile(hit)) return hit;
    const sep = this.deps.platform === 'win32' ? ';' : ':';
    return findOnPath(name, [space.pathEnv, ...space.wellKnown].join(sep), this.deps.platform);
  }

  /** One agent: candidates → highest version, unless a still-existing manual pick overrides it. */
  async detectAgent(
    agent: Exclude<AgentKind, 'shell'>,
    override: string | null = null,
    given?: SearchSpace,
  ): Promise<CliDetection> {
    const space = given ?? (await this.search());
    const spec = CLIS.find((c) => c.agent === agent) ?? { agent, label: agent, bins: [agent] };
    const candidates = await this.candidates(agent, spec.bins, space);
    if (override !== null && existsSync(override)) {
      const manual: CliCandidate = { binary: override, version: null, source: 'manual' };
      const probed = await this.probe(agent, override, {
        source: 'manual',
        alternatives: [],
        searched: space.searched,
      });
      if (probed.found) {
        manual.version = probed.version;
        const key = realKey(override);
        const rest = candidates.filter((x) => realKey(x.binary) !== key);
        return { ...probed, alternatives: [manual, ...rest] };
      }
    }
    const best = pickBest(candidates);
    if (best === null) return { ...notFound(agent, spec.label), searched: space.searched };
    return this.probe(agent, best.binary, {
      version: best.version,
      source: best.source,
      alternatives: candidates,
      searched: space.searched,
    });
  }

  /**
   * Every runnable binary for the agent with its `--version` (cached), in discovery order: PATH, the shell's own
   * answer, install folders off the PATH, then the bundles. A binary reached two ways keeps the first source.
   */
  async candidates(
    agent: Exclude<AgentKind, 'shell'>,
    bins: readonly string[],
    given?: SearchSpace,
  ): Promise<CliCandidate[]> {
    const space = given ?? (await this.search());
    const found: { binary: string; source: CliSource }[] = [];
    const seen = new Set<string>();
    const add = (binary: string, source: CliSource) => {
      const key = realKey(binary);
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ binary, source });
    };
    const sep = this.deps.platform === 'win32' ? ';' : ':';
    for (const b of bins) for (const p of findAllOnPath(b, space.pathEnv, this.deps.platform)) add(p, 'path');
    for (const b of bins) {
      const hit = space.which[b];
      if (hit !== undefined && isExecutableFile(hit)) add(hit, 'shell');
    }
    if (space.wellKnown.length > 0)
      for (const b of bins)
        for (const p of findAllOnPath(b, space.wellKnown.join(sep), this.deps.platform)) add(p, 'well-known');
    for (const dir of this.deps.styxDirs?.() ?? [])
      for (const b of bins) for (const p of findAllOnPath(b, dir, this.deps.platform)) add(p, 'styx');
    const prefix = EXTENSION_PREFIXES[agent];
    if (prefix !== undefined) {
      const names = bins.flatMap((b) => exeNames(b, this.deps.platform));
      for (const bundle of EXTENSION_ROOTS) {
        const root = join(this.deps.home, ...bundle.dir);
        let dirs: string[];
        try {
          dirs = readdirSync(root).filter((d) => d.startsWith(prefix));
        } catch {
          continue;
        }
        for (const d of dirs.sort())
          for (const p of findExecutables(join(root, d), names, BUNDLE_SEARCH_DEPTH)) add(p, bundle.source);
      }
    }
    if (agent === 'claude') {
      const names = exeNames('claude', this.deps.platform);
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
    opts: {
      version?: string | null;
      source?: CliSource;
      alternatives?: CliCandidate[];
      searched?: string[];
    } = {},
  ): Promise<CliDetection> {
    const label = CLIS.find((c) => c.agent === agent)?.label ?? agent;
    const source = opts.source ?? 'manual';
    const alternatives = opts.alternatives ?? [];
    const searched = opts.searched ?? this.lastSearched;
    if (!existsSync(binary)) return { ...notFound(agent, label), binary, searched };
    // A folder (the Claude.app bundle, ~/.claude/local …) resolves to the CLI inside it; any other folder is refused.
    if (isDirectory(binary)) {
      const inner = this.executableIn(agent, binary);
      if (inner === null)
        return { ...notFound(agent, label), binary, searched, problem: { kind: 'directory' } };
      binary = inner;
    }
    let version: string | null;
    if (opts.version === undefined) {
      // A manual pick (or a remembered one) has to prove itself: run, report a version, and be this agent's CLI.
      const v = await this.versionProbe(binary);
      const other = otherAgentIn(agent, v.output);
      if (other !== null)
        return {
          ...notFound(agent, label),
          binary,
          searched,
          problem: { kind: 'other-agent', agent: other },
        };
      if (v.version === null && v.exitCode !== 0)
        return { ...notFound(agent, label), binary, searched, problem: { kind: 'not-runnable' } };
      version = v.version;
    } else {
      version = opts.version;
    }
    const help = await this.helpOf(binary);
    const capabilities: Record<string, boolean> = {
      mcpConfigFlag: /--mcp-config/.test(help),
      settingsFlag: /--settings/.test(help),
      streamJson: /stream-json/.test(help),
      printMode: /(^|\s)(-p|--print)\b/.test(help),
      // Structured control surfaces (docs/research/agent-parity.md): Codex's JSON-RPC app-server subcommand, and the
      // Agent Client Protocol mode of Gemini (`--acp`) and Cursor (`agent acp`).
      appServer: /(^|\s)app-server\b/.test(help),
      acp: /(^|\s)(--acp|acp)\b/.test(help),
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
      searched,
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
    return (await this.versionProbe(binary)).version;
  }

  private async versionProbe(
    binary: string,
  ): Promise<{ version: string | null; exitCode: number; output: string }> {
    const key = this.statKey(binary);
    const hit = this.cache.get(binary);
    if (key !== null && hit !== undefined && hit.key === key)
      return { version: hit.version, exitCode: hit.exitCode, output: hit.output };
    const v = await this.deps.exec(binary, ['--version'], { PATH: this.execPath || this.deps.pathEnv });
    const version = parseVersion(v.stdout);
    if (key !== null)
      this.cache.set(binary, { key, version, exitCode: v.exitCode, output: v.stdout, help: null });
    return { version, exitCode: v.exitCode, output: v.stdout };
  }

  private async helpOf(binary: string): Promise<string> {
    const key = this.statKey(binary);
    const hit = this.cache.get(binary);
    if (key !== null && hit !== undefined && hit.key === key && hit.help !== null) return hit.help;
    const help = (await this.deps.exec(binary, ['--help'], { PATH: this.execPath || this.deps.pathEnv }))
      .stdout;
    if (key !== null) {
      const same = hit?.key === key ? hit : null;
      this.cache.set(binary, {
        key,
        version: same?.version ?? null,
        exitCode: same?.exitCode ?? 0,
        output: same?.output ?? '',
        help,
      });
    }
    return help;
  }

  /** The agent's CLI inside a picked folder: an `.app` bundle is searched under Contents, any other folder one level. */
  private executableIn(agent: Exclude<AgentKind, 'shell'>, dir: string): string | null {
    const bins = CLIS.find((c) => c.agent === agent)?.bins ?? [agent];
    const names = bins.flatMap((b) => exeNames(b, this.deps.platform));
    const bundle = /\.app$/i.test(dir);
    const root = bundle ? join(dir, 'Contents') : dir;
    return findExecutables(root, names, bundle ? BUNDLE_SEARCH_DEPTH : 1)[0] ?? null;
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
        searched: this.lastSearched,
      };
    }
    const shell = this.deps.env['SHELL'] || fallbackShell(this.deps.platform);
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
      searched: this.lastSearched,
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
      case 'opencode':
        // Provider logins sit in `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode`, checked
        // with OpenCode 1.18.35); OpenCode also takes provider keys from the env. With neither it can still run its
        // free models, so "unknown" rather than "signed-out".
        return exists(
          this.deps.env['XDG_DATA_HOME'] ?? join(h, '.local', 'share'),
          'opencode',
          'auth.json',
        ) || OPENCODE_KEY_ENV.some((k) => !!this.deps.env[k])
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

  /** The main build if it is here, else the alternate (Insiders), else the main build's not-found row. */
  private async detectVscodeLike(spec: VscodeLikeSpec): Promise<IdeDetection> {
    const main = await this.detectVscodeBuild(spec.kind, spec);
    if (main.found || spec.alternate === undefined) return main;
    const alt = await this.detectVscodeBuild(spec.kind, spec.alternate);
    return alt.found ? alt : main;
  }

  /**
   * One build: the bundle in the usual places or anywhere Spotlight knows it, the CLI shim on PATH or in the
   * Homebrew / /usr/local dirs GUI apps often miss, or a User folder the editor has written to. Any one of the
   * three proves the editor is installed (a tester's VS Code was missed when only the first two were checked).
   */
  private async detectVscodeBuild(kind: VscodeLikeSpec['kind'], b: VscodeBuild): Promise<IdeDetection> {
    const { platform: p, home: h } = this.deps;
    const location =
      p === 'darwin'
        ? (this.macBundle(b.macApp) ?? (await this.spotlightBundle(b.bundleId)))
        : p === 'win32'
          ? ([
              join(this.localAppData, 'Programs', b.winDir),
              join(this.programFilesDir, b.winDir),
              ...(this.deps.env['ProgramFiles(x86)']
                ? [join(this.deps.env['ProgramFiles(x86)'], b.winDir)]
                : []),
            ].find(existsSync) ?? null)
          : null;
    const configDir =
      p === 'darwin'
        ? join(h, 'Library', 'Application Support', b.userDirName, 'User')
        : p === 'win32'
          ? join(this.appData, b.userDirName, 'User')
          : join(this.xdgConfig, b.userDirName, 'User');
    const hasConfig = existsSync(configDir);
    const bin =
      findOnPath(b.launcher, this.deps.pathEnv, p) ??
      (p === 'darwin'
        ? ((this.deps.launcherDirs ?? []).map((d) => join(d, b.launcher)).find(isExecutableFile) ?? null)
        : null);
    let version = location ? readVscodeVersion(location, p) : null;
    if (version === null && bin) version = parseVersion((await this.deps.exec(bin, ['--version'])).stdout);
    const found = !!location || !!bin || hasConfig;
    // Bundle without the CLI shim: macOS opens it by name (or by bundle id when only the User folder was found);
    // a Windows install ships `bin\<launcher>.cmd`.
    const shim = location && p === 'win32' ? join(location, 'bin', `${b.launcher}.cmd`) : null;
    const launcher =
      bin ??
      (location && p === 'darwin'
        ? `open -a "${b.macApp}"`
        : shim && existsSync(shim)
          ? shim
          : !location && hasConfig && p === 'darwin'
            ? `open -b ${b.bundleId}`
            : null);
    return {
      kind,
      product: b.product,
      version,
      location,
      launcher,
      configDir: hasConfig ? configDir : null,
      imports: found ? this.vscodeImports(configDir) : noImports(),
      found,
    };
  }

  /** Spotlight by bundle id: an app dragged to Downloads or an external volume still has a Launch Services record. */
  private async spotlightBundle(bundleId: string): Promise<string | null> {
    try {
      const r = await this.deps.exec('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`]);
      return (
        r.stdout
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /\.app$/.test(line) && existsSync(line)) ?? null
      );
    } catch {
      return null;
    }
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

/** One build of a VS Code-like editor (stable, or an alternate such as Insiders). */
interface VscodeBuild {
  product: string;
  /** `<macApp>.app` under /Applications or ~/Applications. */
  macApp: string;
  /** Launch Services bundle id: Spotlight finds the app wherever it was dragged, and `open -b` launches it. */
  bundleId: string;
  /** `%LOCALAPPDATA%\Programs\<winDir>` (user setup) or `%PROGRAMFILES%\<winDir>` (system setup). */
  winDir: string;
  /** `<userDirName>/User` under Application Support, %APPDATA% or ~/.config. */
  userDirName: string;
  /** CLI shim on PATH; also `bin\<launcher>.cmd` inside a Windows install. */
  launcher: string;
}

interface VscodeLikeSpec extends VscodeBuild {
  kind: 'vscode' | 'cursor' | 'windsurf';
  /** Tried when the main build is absent (VS Code Insiders); reported under the same kind. */
  alternate?: VscodeBuild;
}

const VSCODE_LIKE_IDES: readonly VscodeLikeSpec[] = [
  {
    kind: 'vscode',
    product: 'VS Code',
    macApp: 'Visual Studio Code',
    bundleId: 'com.microsoft.VSCode',
    winDir: 'Microsoft VS Code',
    userDirName: 'Code',
    launcher: 'code',
    alternate: {
      product: 'VS Code Insiders',
      macApp: 'Visual Studio Code - Insiders',
      bundleId: 'com.microsoft.VSCodeInsiders',
      winDir: 'Microsoft VS Code Insiders',
      userDirName: 'Code - Insiders',
      launcher: 'code-insiders',
    },
  },
  {
    kind: 'cursor',
    product: 'Cursor',
    macApp: 'Cursor',
    bundleId: 'com.todesktop.230313mzl4w4u92',
    winDir: 'cursor',
    userDirName: 'Cursor',
    launcher: 'cursor',
  },
  {
    kind: 'windsurf',
    product: 'Windsurf',
    macApp: 'Windsurf',
    bundleId: 'com.exafunction.windsurf',
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
