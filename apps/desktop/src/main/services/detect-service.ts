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
import { delimiter, join } from 'node:path';
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
  product: string;
  version: string | null;
  location: string | null;
  launcher: string | null;
  configDir: string | null;
  imports: { recents: number; keybindings: boolean; theme: boolean };
  found: boolean;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  home: string;
  pathEnv: string;
  env: NodeJS.ProcessEnv;
  exec: (bin: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
  /** macOS `/Applications` (the Claude desktop app bundle is looked up there); injectable for tests. */
  applicationsDir?: string;
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

  async detectIdes(): Promise<IdeDetection[]> {
    const p = this.deps.platform;
    const h = this.deps.home;
    const out: IdeDetection[] = [];
    const vscodeLike = (
      kind: 'vscode' | 'cursor',
      product: string,
      macApp: string,
      winDir: string,
      userDirName: string,
      launcher: string,
    ) => {
      const location =
        p === 'darwin'
          ? ([`/Applications/${macApp}.app`, join(h, 'Applications', `${macApp}.app`)].find(existsSync) ??
            null)
          : p === 'win32'
            ? ([join(this.deps.env['LOCALAPPDATA'] ?? '', 'Programs', winDir)].find(
                (d) => d && existsSync(d),
              ) ?? null)
            : null;
      const configDir =
        p === 'darwin'
          ? join(h, 'Library', 'Application Support', userDirName, 'User')
          : p === 'win32'
            ? join(this.deps.env['APPDATA'] ?? '', userDirName, 'User')
            : join(h, '.config', userDirName, 'User');
      const version = location ? readVscodeVersion(location, p) : null;
      const bin = findOnPath(launcher, this.deps.pathEnv, p);
      const found = !!location || !!bin;
      out.push({
        kind,
        product,
        version,
        location,
        launcher: bin ?? (location ? launcher : null),
        configDir: existsSync(configDir) ? configDir : null,
        imports: found ? this.vscodeImports(configDir) : { recents: 0, keybindings: false, theme: false },
        found,
      });
    };
    vscodeLike('vscode', 'VS Code', 'Visual Studio Code', 'Microsoft VS Code', 'Code', 'code');
    vscodeLike('cursor', 'Cursor', 'Cursor', 'cursor', 'Cursor', 'cursor');

    const jb =
      p === 'darwin'
        ? ['WebStorm', 'IntelliJ IDEA', 'PyCharm', 'GoLand', 'RustRover']
            .map((n) => ({ n, path: `/Applications/${n}.app` }))
            .find((x) => existsSync(x.path))
        : undefined;
    const jbToolbox =
      p === 'darwin'
        ? join(h, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps')
        : join(this.deps.env['LOCALAPPDATA'] ?? '', 'JetBrains', 'Toolbox', 'apps');
    const jbFound = !!jb || existsSync(jbToolbox);
    out.push({
      kind: 'jetbrains',
      product: jb?.n ?? 'JetBrains',
      version: jb ? readPlistVersion(jb.path) : null,
      location: jb?.path ?? (existsSync(jbToolbox) ? jbToolbox : null),
      launcher: jb ? `open -a "${jb.n}"` : null,
      configDir: null,
      imports: { recents: jbFound ? countJetbrainsRecents(h, p) : 0, keybindings: false, theme: false },
      found: jbFound,
    });

    const nvim = findOnPath('nvim', this.deps.pathEnv, p);
    const nv = nvim ? parseVersion((await this.deps.exec(nvim, ['--version'])).stdout) : null;
    const shada =
      p === 'win32'
        ? join(this.deps.env['LOCALAPPDATA'] ?? '', 'nvim-data', 'shada', 'main.shada')
        : join(h, '.local', 'share', 'nvim', 'shada', 'main.shada');
    out.push({
      kind: 'neovim',
      product: 'Neovim',
      version: nv,
      location: nvim ? nvim.replace(/\/nvim$/, '') : null,
      launcher: nvim,
      configDir: null,
      imports: { recents: existsSync(shada) ? -1 : 0, keybindings: false, theme: false },
      found: !!nvim,
    });
    return out;
  }

  private vscodeImports(userDir: string): { recents: number; keybindings: boolean; theme: boolean } {
    const keybindings = existsSync(join(userDir, 'keybindings.json'));
    let theme = false;
    try {
      theme = /"workbench\.colorTheme"|"editor\.fontFamily"/.test(
        readFileSync(join(userDir, 'settings.json'), 'utf8'),
      );
    } catch {
      /* none */
    }
    // -1 = present, count resolved lazily by IdeImportService (legacy state.vscdb key, or workspaceStorage on 1.10x+).
    const hasRecents =
      existsSync(join(userDir, 'globalStorage', 'state.vscdb')) ||
      existsSync(join(userDir, 'workspaceStorage'));
    return { recents: hasRecents ? -1 : 0, keybindings, theme };
  }
}

export function parseVersion(s: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(s);
  return m?.[1] ?? null;
}

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

function countJetbrainsRecents(home: string, platform: NodeJS.Platform): number {
  const base =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'JetBrains')
      : join(process.env['APPDATA'] ?? '', 'JetBrains');
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
