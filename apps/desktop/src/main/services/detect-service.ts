import { execa } from 'execa';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'cursor' | 'shell';
export type AuthState = 'signed-in' | 'signed-out' | 'unknown' | 'n/a';

export interface CliDetection {
  agent: AgentKind;
  label: string;
  binary: string | null;
  version: string | null;
  found: boolean;
  authState: AuthState;
  capabilities: Record<string, boolean>;
}

export interface IdeDetection {
  kind: 'vscode' | 'cursor' | 'jetbrains' | 'neovim';
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
}

const CLIS: { agent: AgentKind; label: string; bins: string[] }[] = [
  { agent: 'claude', label: 'Claude Code', bins: ['claude'] },
  { agent: 'codex', label: 'Codex', bins: ['codex'] },
  { agent: 'gemini', label: 'Gemini CLI', bins: ['gemini'] },
  { agent: 'cursor', label: 'Cursor agent', bins: ['cursor-agent', 'agent'] },
  { agent: 'shell', label: 'Shell', bins: [] },
];

export function defaultDeps(pathEnv: string = process.env['PATH'] ?? ''): DetectDeps {
  return {
    platform: process.platform,
    home: homedir(),
    pathEnv,
    env: process.env,
    exec: async (bin, args) => {
      const r = await execa(bin, args, { reject: false, timeout: 8000, env: { ...process.env, PATH: pathEnv, NO_COLOR: '1' } });
      return { stdout: String(r.stdout ?? '') + '\n' + String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
    },
  };
}

export function findOnPath(name: string, pathEnv: string, platform: NodeJS.Platform): string | null {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (statSync(p).isFile()) {
          accessSync(p, constants.X_OK);
          return p;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Detects agent CLIs on the (login-shell) PATH with version and auth state. Sign-in stays the CLI's own flow. */
export class DetectService {
  constructor(private readonly deps: DetectDeps = defaultDeps()) {}

  async detectClis(): Promise<CliDetection[]> {
    const out: CliDetection[] = [];
    for (const c of CLIS) {
      if (c.agent === 'shell') {
        out.push(await this.detectShell());
        continue;
      }
      let binary: string | null = null;
      for (const b of c.bins) if ((binary = findOnPath(b, this.deps.pathEnv, this.deps.platform))) break;
      if (!binary) {
        out.push({ agent: c.agent, label: c.label, binary: null, version: null, found: false, authState: 'unknown', capabilities: {} });
        continue;
      }
      const v = await this.deps.exec(binary, ['--version']);
      const version = parseVersion(v.stdout);
      const help = await this.deps.exec(binary, ['--help']);
      const capabilities: Record<string, boolean> = {
        mcpConfigFlag: /--mcp-config/.test(help.stdout),
        settingsFlag: /--settings/.test(help.stdout),
        streamJson: /stream-json/.test(help.stdout),
        printMode: /(^|\s)(-p|--print)\b/.test(help.stdout),
        configOverride: /(^|\s)-c,? ?(--config)?\b/.test(help.stdout) || /--config/.test(help.stdout),
      };
      out.push({ agent: c.agent, label: c.label, binary, version, found: true, authState: this.authState(c.agent), capabilities });
    }
    return out;
  }

  private async detectShell(): Promise<CliDetection> {
    if (this.deps.platform === 'win32') {
      const pwsh = findOnPath('pwsh', this.deps.pathEnv, 'win32') ?? findOnPath('powershell', this.deps.pathEnv, 'win32');
      const wsl = findOnPath('wsl', this.deps.pathEnv, 'win32');
      const v = pwsh ? parseVersion((await this.deps.exec(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])).stdout) : null;
      return { agent: 'shell', label: 'Shell', binary: pwsh, version: v ? `pwsh ${v}${wsl ? ' · WSL available' : ''}` : null, found: !!pwsh, authState: 'n/a', capabilities: { wsl: !!wsl } };
    }
    const shell = this.deps.env['SHELL'] || '/bin/zsh';
    const name = shell.split('/').pop() ?? 'sh';
    const v = await this.deps.exec(shell, ['--version']);
    return { agent: 'shell', label: 'Shell', binary: shell, version: `${name} ${parseVersion(v.stdout) ?? ''}`.trim(), found: existsSync(shell), authState: 'n/a', capabilities: {} };
  }

  /** Auth is inferred from each CLI's own credential locations; Styx never reads the secrets themselves. */
  authState(agent: AgentKind): AuthState {
    const h = this.deps.home;
    const exists = (...p: string[]) => existsSync(join(...p));
    switch (agent) {
      case 'claude':
        return exists(h, '.claude', '.credentials.json') || !!this.deps.env['ANTHROPIC_API_KEY'] || (this.deps.platform === 'darwin' && exists(h, '.claude.json')) ? 'signed-in' : 'signed-out';
      case 'codex':
        return exists(this.deps.env['CODEX_HOME'] ?? join(h, '.codex'), 'auth.json') || !!this.deps.env['OPENAI_API_KEY'] ? 'signed-in' : 'signed-out';
      case 'gemini':
        return exists(h, '.gemini', 'oauth_creds.json') || !!this.deps.env['GEMINI_API_KEY'] ? 'signed-in' : 'signed-out';
      case 'cursor':
        return exists(h, '.cursor', 'cli-config.json') || exists(h, '.config', 'cursor-agent') ? 'signed-in' : 'unknown';
      default:
        return 'n/a';
    }
  }

  async detectIdes(): Promise<IdeDetection[]> {
    const p = this.deps.platform;
    const h = this.deps.home;
    const out: IdeDetection[] = [];
    const vscodeLike = (kind: 'vscode' | 'cursor', product: string, macApp: string, winDir: string, userDirName: string, launcher: string) => {
      const location = p === 'darwin' ? [`/Applications/${macApp}.app`, join(h, 'Applications', `${macApp}.app`)].find(existsSync) ?? null
        : p === 'win32' ? [join(this.deps.env['LOCALAPPDATA'] ?? '', 'Programs', winDir)].find((d) => d && existsSync(d)) ?? null : null;
      const configDir = p === 'darwin' ? join(h, 'Library', 'Application Support', userDirName, 'User') : p === 'win32' ? join(this.deps.env['APPDATA'] ?? '', userDirName, 'User') : join(h, '.config', userDirName, 'User');
      const version = location ? readVscodeVersion(location, p) : null;
      const bin = findOnPath(launcher, this.deps.pathEnv, p);
      const found = !!location || !!bin;
      out.push({ kind, product, version, location, launcher: bin ?? (location ? launcher : null), configDir: existsSync(configDir) ? configDir : null, imports: found ? this.vscodeImports(configDir) : { recents: 0, keybindings: false, theme: false }, found });
    };
    vscodeLike('vscode', 'VS Code', 'Visual Studio Code', 'Microsoft VS Code', 'Code', 'code');
    vscodeLike('cursor', 'Cursor', 'Cursor', 'cursor', 'Cursor', 'cursor');

    const jb = p === 'darwin' ? ['WebStorm', 'IntelliJ IDEA', 'PyCharm', 'GoLand', 'RustRover'].map((n) => ({ n, path: `/Applications/${n}.app` })).find((x) => existsSync(x.path)) : undefined;
    const jbToolbox = p === 'darwin' ? join(h, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps') : join(this.deps.env['LOCALAPPDATA'] ?? '', 'JetBrains', 'Toolbox', 'apps');
    const jbFound = !!jb || existsSync(jbToolbox);
    out.push({ kind: 'jetbrains', product: jb?.n ?? 'JetBrains', version: jb ? readPlistVersion(jb.path) : null, location: jb?.path ?? (existsSync(jbToolbox) ? jbToolbox : null), launcher: jb ? `open -a "${jb.n}"` : null, configDir: null, imports: { recents: jbFound ? countJetbrainsRecents(h, p) : 0, keybindings: false, theme: false }, found: jbFound });

    const nvim = findOnPath('nvim', this.deps.pathEnv, p);
    const nv = nvim ? parseVersion((await this.deps.exec(nvim, ['--version'])).stdout) : null;
    const shada = p === 'win32' ? join(this.deps.env['LOCALAPPDATA'] ?? '', 'nvim-data', 'shada', 'main.shada') : join(h, '.local', 'share', 'nvim', 'shada', 'main.shada');
    out.push({ kind: 'neovim', product: 'Neovim', version: nv, location: nvim ? nvim.replace(/\/nvim$/, '') : null, launcher: nvim, configDir: null, imports: { recents: existsSync(shada) ? -1 : 0, keybindings: false, theme: false }, found: !!nvim });
    return out;
  }

  private vscodeImports(userDir: string): { recents: number; keybindings: boolean; theme: boolean } {
    const keybindings = existsSync(join(userDir, 'keybindings.json'));
    let theme = false;
    try {
      theme = /"workbench\.colorTheme"|"editor\.fontFamily"/.test(readFileSync(join(userDir, 'settings.json'), 'utf8'));
    } catch {
      /* none */
    }
    const state = join(userDir, 'globalStorage', 'state.vscdb');
    return { recents: existsSync(state) ? -1 : 0, keybindings, theme }; // -1 = present, count resolved lazily by ImportService
  }
}

export function parseVersion(s: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(s);
  return m?.[1] ?? null;
}

function readVscodeVersion(location: string, platform: NodeJS.Platform): string | null {
  const candidates = platform === 'darwin' ? [join(location, 'Contents', 'Resources', 'app', 'package.json')] : [join(location, 'resources', 'app', 'package.json')];
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
  const base = platform === 'darwin' ? join(home, 'Library', 'Application Support', 'JetBrains') : join(process.env['APPDATA'] ?? '', 'JetBrains');
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
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
