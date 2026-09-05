import { decodeMulti } from '@msgpack/msgpack';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger';

/**
 * Readers for the other editors' state (plan §5 DetectService imports; spec §4.9 "Import keybindings / theme & font /
 * recent folders"). Every `parse*` is a pure function over file contents so it can be unit-tested on fixtures; the
 * service only resolves paths and feeds bytes in. Nothing here reads a credential store, token or secret file.
 */

export interface ImportedKeybinding {
  key: string;
  command: string;
  when?: string;
}

export interface ImportedTheme {
  colorTheme: string | null;
  fontFamily: string | null;
}

export type ImportIdeKind = 'vscode' | 'cursor' | 'jetbrains' | 'neovim';

export interface IdeImportResult {
  /** Absolute folder paths, most recent first, de-duplicated. */
  recents: string[];
  keybindings: ImportedKeybinding[] | null;
  theme: ImportedTheme | null;
}

// --- VS Code / Cursor --------------------------------------------------------

/** `file:///Users/me/code/x` / `file:///c%3A/dev/x` → local path; non-file URIs (vscode-remote://…) are dropped. */
export function fileUriToPath(uri: string, platform: NodeJS.Platform): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    let p = fileURLToPath(uri, { windows: platform === 'win32' });
    if (platform === 'win32') {
      p = p.replace(/\//g, '\\');
      if (/^[a-z]:/.test(p)) p = p[0]!.toUpperCase() + p.slice(1);
    }
    return p.replace(/[\\/]+$/, '') || p;
  } catch {
    return null;
  }
}

/** The JSON stored under `ItemTable.history.recentlyOpenedPathsList`: `{ entries: [{ folderUri | fileUri | workspace }] }`. */
export function parseVscodeRecents(json: string, platform: NodeJS.Platform): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return [];
  }
  const entries = (doc as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as { folderUri?: unknown; workspace?: { configPath?: unknown } };
    const uri = typeof rec.folderUri === 'string' ? rec.folderUri : null;
    if (!uri) continue; // files and .code-workspace entries are not project folders
    const p = fileUriToPath(uri, platform);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Reads `User/globalStorage/state.vscdb` (SQLite) read-only; only the recents key is touched. */
export function readVscdbRecents(file: string, platform: NodeJS.Platform): string[] {
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
      .get() as { value?: string | Buffer } | undefined;
    const raw = row?.value;
    if (raw === undefined || raw === null) return [];
    return parseVscodeRecents(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw), platform);
  } catch (e) {
    logger.warn('ide-import: state.vscdb unreadable', { file, error: (e as Error).message });
    return [];
  } finally {
    db?.close();
  }
}

/** JSONC (comments + trailing commas), as VS Code writes its settings and keybindings files. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && n !== undefined) {
        out += n;
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas before a closing bracket/brace.
  const cleaned = out.replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(cleaned.replace(/^﻿/, ''));
}

/** `User/keybindings.json` → `{ key, command, when }` rows; malformed rows are skipped, nothing else is kept. */
export function parseKeybindings(text: string): ImportedKeybinding[] {
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];
  const out: ImportedKeybinding[] = [];
  for (const row of doc) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { key?: unknown; command?: unknown; when?: unknown };
    if (typeof r.key !== 'string' || typeof r.command !== 'string' || !r.key || !r.command) continue;
    out.push({ key: r.key, command: r.command, ...(typeof r.when === 'string' ? { when: r.when } : {}) });
  }
  return out;
}

/** `workbench.colorTheme` + `editor.fontFamily` from `User/settings.json`; nothing else is read. */
export function parseVscodeTheme(text: string): ImportedTheme {
  try {
    const doc = parseJsonc(text) as Record<string, unknown> | null;
    const theme = doc?.['workbench.colorTheme'];
    const font = doc?.['editor.fontFamily'];
    return {
      colorTheme: typeof theme === 'string' && theme ? theme : null,
      fontFamily: typeof font === 'string' && font ? font : null,
    };
  } catch {
    return { colorTheme: null, fontFamily: null };
  }
}

// --- JetBrains -----------------------------------------------------------------

/** `options/recentProjects.xml`: `<entry key="$USER_HOME$/code/x">` (2020+) or `<option value="…">` (older). */
export function parseJetbrainsRecents(xml: string, home: string, platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    let p = raw.replace(/\$USER_HOME\$/g, home).replace(/&amp;/g, '&');
    if (platform === 'win32') p = p.replace(/\//g, '\\');
    if (p && !out.includes(p)) out.push(p);
  };
  const entryRe = /<entry\s+key="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) push(m[1]!);
  if (out.length === 0) {
    const optRe = /<option\s+value="(\$USER_HOME\$[^"]*|[A-Za-z]:[^"]*|\/[^"]*)"\s*\/>/g;
    while ((m = optRe.exec(xml))) push(m[1]!);
  }
  return out;
}

// --- Neovim --------------------------------------------------------------------

const SHADA_FILE_TYPES = new Set([7, 8, 9, 10, 11]); // GlobalMark, Jump, BufferList, LocalMark, Change

const asText = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return null;
};

/**
 * Neovim shada is a msgpack stream of `type, timestamp, length, data` quadruples. `v:oldfiles` is derived from the
 * `f` (file name) key of mark/jump/change entries and the buffer list; that is all we read.
 */
export function parseShadaOldfiles(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const add = (f: unknown) => {
    const s = asText(f);
    if (s && !out.includes(s)) out.push(s);
  };
  let items: unknown[];
  try {
    items = [...decodeMulti(bytes)];
  } catch {
    return out;
  }
  for (let i = 0; i + 3 < items.length; i += 4) {
    const type = items[i];
    const data = items[i + 3];
    if (typeof type !== 'number' || !SHADA_FILE_TYPES.has(type)) continue;
    if (type === 9 && Array.isArray(data)) {
      for (const buf of data)
        if (buf instanceof Map) add(buf.get('f'));
        else if (buf && typeof buf === 'object') add((buf as Record<string, unknown>)['f']);
      continue;
    }
    if (data instanceof Map) add(data.get('f'));
    else if (data && typeof data === 'object') add((data as Record<string, unknown>)['f']);
  }
  return out;
}

/** Oldfiles are files; a project is the nearest enclosing directory containing `.git`. */
export function repoRootOf(file: string, exists: (p: string) => boolean): string | null {
  let dir = dirname(file);
  for (let i = 0; i < 12; i++) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// --- Service -------------------------------------------------------------------

export interface IdeImportDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  readBytes?: (p: string) => Uint8Array;
  readVscdb?: (file: string, platform: NodeJS.Platform) => string[];
}

export interface IdeImportSource {
  kind: ImportIdeKind;
  /** VS Code / Cursor `User` dir (from DetectService); ignored for JetBrains / Neovim. */
  configDir: string | null;
}

export class IdeImportService {
  private readonly exists: (p: string) => boolean;
  private readonly readFile: (p: string) => string;
  private readonly readBytes: (p: string) => Uint8Array;
  private readonly readVscdb: (file: string, platform: NodeJS.Platform) => string[];

  constructor(private readonly deps: IdeImportDeps) {
    this.exists = deps.exists ?? existsSync;
    this.readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    this.readBytes = deps.readBytes ?? ((p) => new Uint8Array(readFileSync(p)));
    this.readVscdb = deps.readVscdb ?? readVscdbRecents;
  }

  /** Recent project folders of one editor (existing directories only). */
  recentFolders(src: IdeImportSource): string[] {
    const { platform, home } = this.deps;
    let folders: string[] = [];
    if (src.kind === 'vscode' || src.kind === 'cursor') {
      const db = src.configDir ? join(src.configDir, 'globalStorage', 'state.vscdb') : null;
      if (db && this.exists(db)) folders = this.readVscdb(db, platform);
    } else if (src.kind === 'jetbrains') {
      for (const f of this.jetbrainsRecentFiles()) {
        try {
          for (const p of parseJetbrainsRecents(this.readFile(f), home, platform))
            if (!folders.includes(p)) folders.push(p);
        } catch {
          /* unreadable */
        }
      }
    } else {
      const shada =
        platform === 'win32'
          ? join(
              this.deps.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'),
              'nvim-data',
              'shada',
              'main.shada',
            )
          : join(home, '.local', 'share', 'nvim', 'shada', 'main.shada');
      if (this.exists(shada)) {
        try {
          for (const f of parseShadaOldfiles(this.readBytes(shada))) {
            const root = repoRootOf(f, this.exists);
            if (root && !folders.includes(root)) folders.push(root);
          }
        } catch {
          /* unreadable */
        }
      }
    }
    return folders.filter((p) => this.isDir(p));
  }

  /** Everything the onboarding toggles can import for one editor. */
  importFrom(
    src: IdeImportSource,
    what: { recents: boolean; keybindings: boolean; theme: boolean },
  ): IdeImportResult {
    const out: IdeImportResult = { recents: [], keybindings: null, theme: null };
    if (what.recents) out.recents = this.recentFolders(src);
    if ((src.kind === 'vscode' || src.kind === 'cursor') && src.configDir) {
      if (what.keybindings) {
        const f = join(src.configDir, 'keybindings.json');
        if (this.exists(f)) out.keybindings = parseKeybindings(this.readFile(f));
      }
      if (what.theme) {
        const f = join(src.configDir, 'settings.json');
        if (this.exists(f)) out.theme = parseVscodeTheme(this.readFile(f));
      }
    }
    return out;
  }

  /** All recent folders across the editors detected on this machine, most recent first per editor. */
  allRecentFolders(sources: IdeImportSource[]): string[] {
    const out: string[] = [];
    for (const s of sources) for (const p of this.recentFolders(s)) if (!out.includes(p)) out.push(p);
    return out;
  }

  private jetbrainsRecentFiles(): string[] {
    const { platform, home } = this.deps;
    const base =
      platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'JetBrains')
        : platform === 'win32'
          ? join(this.deps.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'JetBrains')
          : join(home, '.config', 'JetBrains');
    try {
      return readdirSync(base)
        .map((d) => join(base, d, 'options', 'recentProjects.xml'))
        .filter((f) => this.exists(f));
    } catch {
      return [];
    }
  }

  private isDir(p: string): boolean {
    if (this.deps.exists) return this.deps.exists(p);
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
}

// --- "Open in Styx" ------------------------------------------------------------

export interface OpenInInstallDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** `<userData>/open-in`: where the launcher script lives. */
  launcherDir: string;
  /** Runs a command; `dryRun` records instead of executing. */
  exec: (bin: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>;
  writeFile: (p: string, body: string, mode?: number) => void;
  mkdir: (p: string) => void;
  symlink: (target: string, link: string) => void;
  exists: (p: string) => boolean;
  remove: (p: string) => void;
}

export interface OpenInInstallResult {
  /** Where the `styx` launcher was placed. */
  installedAt: string;
  /** Non-null when the directory is not on PATH yet (fallback location or fresh user PATH entry). */
  pathHint: string | null;
}

const POSIX_LAUNCHER = `#!/bin/sh
# Styx "Open in Styx": opens the current (or given) folder in Styx via the styx:// protocol.
d="\${1:-$PWD}"
case "$d" in /*) ;; *) d="$PWD/$d" ;; esac
enc=$(printf %s "$d" | sed 's/%/%25/g; s/ /%20/g; s/#/%23/g; s/?/%3F/g; s/&/%26/g')
if command -v open >/dev/null 2>&1; then open "styx://open?path=$enc"; else xdg-open "styx://open?path=$enc"; fi
`;

const WIN_LAUNCHER = `@echo off\r\nsetlocal\r\nset "d=%~1"\r\nif "%d%"=="" set "d=%CD%"\r\nset "d=%d:%=%%25%"\r\nset "d=%d: =%%20%"\r\nset "d=%d:#=%%23%"\r\nset "d=%d:&=%%26%"\r\nstart "" "styx://open?path=%d%"\r\n`;

/**
 * Puts a `styx` launcher on PATH and (Windows) a Directory shell verb, so "Open in Styx" works from a terminal and
 * the Explorer context menu. macOS: symlink into /usr/local/bin, else ~/.local/bin with a PATH hint. Windows: HKCU
 * `Software\\Classes\\Directory\\shell\\Styx` via `reg add` and `%LOCALAPPDATA%\\Styx\\bin` appended to the user PATH.
 */
export async function installOpenIn(deps: OpenInInstallDeps): Promise<OpenInInstallResult> {
  deps.mkdir(deps.launcherDir);
  if (deps.platform === 'win32') {
    const binDir = win32.join(deps.env['LOCALAPPDATA'] ?? win32.join(deps.home, 'AppData', 'Local'), 'Styx', 'bin');
    deps.mkdir(binDir);
    const launcher = win32.join(binDir, 'styx.cmd');
    deps.writeFile(launcher, WIN_LAUNCHER);
    const key = 'HKCU\\Software\\Classes\\Directory\\shell\\Styx';
    const bg = 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Styx';
    await deps.exec('reg', ['add', key, '/ve', '/d', 'Open in Styx', '/f']);
    await deps.exec('reg', ['add', `${key}\\command`, '/ve', '/d', `"${launcher}" "%V"`, '/f']);
    await deps.exec('reg', ['add', bg, '/ve', '/d', 'Open in Styx', '/f']);
    await deps.exec('reg', ['add', `${bg}\\command`, '/ve', '/d', `"${launcher}" "%V"`, '/f']);
    const onPath = (deps.env['PATH'] ?? '').split(';').some((p) => p.toLowerCase() === binDir.toLowerCase());
    if (!onPath) {
      // Append to the *user* PATH only (never the merged machine PATH), read back from the registry.
      const q = await deps.exec('reg', ['query', 'HKCU\\Environment', '/v', 'Path']);
      const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(q.stdout);
      const current = (m?.[1] ?? '').trim();
      const next = current ? `${current.replace(/;+$/, '')};${binDir}` : binDir;
      await deps.exec('setx', ['PATH', next]);
    }
    return {
      installedAt: launcher,
      pathHint: onPath ? null : `${binDir} was added to your PATH; open a new terminal.`,
    };
  }
  const script = posix.join(deps.launcherDir, 'styx');
  deps.writeFile(script, POSIX_LAUNCHER, 0o755);
  const link = (dir: string): boolean => {
    try {
      deps.mkdir(dir);
      const target = posix.join(dir, 'styx');
      if (deps.exists(target)) deps.remove(target);
      deps.symlink(script, target);
      return true;
    } catch {
      return false;
    }
  };
  if (link('/usr/local/bin')) return { installedAt: '/usr/local/bin/styx', pathHint: null };
  const local = posix.join(deps.home, '.local', 'bin');
  if (!link(local)) throw new Error('could not write the styx launcher to /usr/local/bin or ~/.local/bin');
  const onPath = (deps.env['PATH'] ?? '').split(':').includes(local);
  return {
    installedAt: posix.join(local, 'styx'),
    pathHint: onPath ? null : `Add ${local} to your PATH (e.g. export PATH="$HOME/.local/bin:$PATH").`,
  };
}
