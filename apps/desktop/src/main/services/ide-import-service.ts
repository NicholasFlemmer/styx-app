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

export type ImportIdeKind = 'vscode' | 'cursor' | 'windsurf' | 'zed' | 'jetbrains' | 'neovim';

/** Editors with the VS Code config layout (`User/globalStorage/state.vscdb`, `keybindings.json`, `settings.json`). */
export const VSCODE_LIKE: readonly ImportIdeKind[] = ['vscode', 'cursor', 'windsurf'];
export const isVscodeLike = (kind: ImportIdeKind): boolean => VSCODE_LIKE.includes(kind);

export interface IdeImportResult {
  /** Absolute folder paths, most recent first, de-duplicated. */
  recents: string[];
  keybindings: ImportedKeybinding[] | null;
  theme: ImportedTheme | null;
}

/** A recently opened folder; `openedAt` is known only where the editor leaves a timestamp (workspaceStorage mtime). */
export interface RecentFolder {
  path: string;
  openedAt: number | null;
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

/**
 * A multi-root `.code-workspace` file stands for the folder that holds it; VS Code's untitled workspaces
 * (`…/Code/Workspaces/<n>/workspace.json`) stand for nothing. Files (`fileUri`) are never project folders.
 */
export function workspaceFileToFolder(uri: string, platform: NodeJS.Platform): string | null {
  const p = fileUriToPath(uri, platform);
  if (p === null || !/\.code-workspace$/i.test(p)) return null;
  return dirname(p);
}

const asFolder = (rec: unknown, platform: NodeJS.Platform): string | null => {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as { folderUri?: unknown; workspace?: { configPath?: unknown } };
  if (typeof r.folderUri === 'string') return fileUriToPath(r.folderUri, platform);
  const cfg = r.workspace?.configPath;
  return typeof cfg === 'string' ? workspaceFileToFolder(cfg, platform) : null;
};

/**
 * The JSON stored under `ItemTable.history.recentlyOpenedPathsList` (VS Code ≤ 1.9x, Cursor):
 * `{ entries: [{ folderUri | fileUri | workspace: { configPath } }] }`, most recent first.
 */
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
    const p = asFolder(e, platform);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * `User/workspaceStorage/<hash>/workspace.json` (every VS Code / Cursor build; the only recents record VS Code 1.10x+
 * leaves): `{ "folder": "file:///…" }` or `{ "workspace": "file:///….code-workspace" }`; `{}` for untitled ones.
 */
export function parseWorkspaceJson(json: string, platform: NodeJS.Platform): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const r = doc as { folder?: unknown; workspace?: unknown };
  if (typeof r.folder === 'string') return fileUriToPath(r.folder, platform);
  if (typeof r.workspace === 'string') return workspaceFileToFolder(r.workspace, platform);
  return null;
}

/** `<Code>/Backups/workspaces.json`: `{ folderWorkspaceInfos: [{ folderUri }], rootURIWorkspaces: [{ configURIPath }] }`. */
export function parseBackupsWorkspaces(json: string, platform: NodeJS.Platform): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const r = doc as { folderWorkspaceInfos?: unknown; rootURIWorkspaces?: unknown };
  const out: string[] = [];
  const add = (p: string | null) => {
    if (p && !out.includes(p)) out.push(p);
  };
  if (Array.isArray(r.folderWorkspaceInfos))
    for (const e of r.folderWorkspaceInfos) {
      const uri = (e as { folderUri?: unknown } | null)?.folderUri;
      if (typeof uri === 'string') add(fileUriToPath(uri, platform));
    }
  if (Array.isArray(r.rootURIWorkspaces))
    for (const e of r.rootURIWorkspaces) {
      const uri = (e as { configURIPath?: unknown } | null)?.configURIPath;
      if (typeof uri === 'string') add(workspaceFileToFolder(uri, platform));
    }
  return out;
}

/**
 * Newest first, de-duplicated. Rows without a timestamp are the editor's own MRU list (the legacy key), which is
 * more recent than anything it has forgotten: they keep their order ahead of the timestamped rows, but borrow the
 * timestamp of a duplicate when one exists.
 */
export function mergeRecents(...lists: readonly (readonly RecentFolder[])[]): RecentFolder[] {
  const known = new Map<string, number>();
  for (const list of lists)
    for (const r of list)
      if (r.openedAt !== null) known.set(r.path, Math.max(known.get(r.path) ?? 0, r.openedAt));
  const seen = new Set<string>();
  const mru: RecentFolder[] = [];
  const dated: RecentFolder[] = [];
  for (const list of lists)
    for (const r of list) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      const openedAt = known.get(r.path) ?? null;
      (r.openedAt === null ? mru : dated).push({ path: r.path, openedAt });
    }
  dated.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  return [...mru, ...dated];
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

// --- Zed -----------------------------------------------------------------------

/**
 * Zed `~/.config/zed/settings.json` (JSONC): `theme` is either a name or `{ mode, light, dark }` — the name for
 * the explicit mode, else the dark one (Styx's default appearance) — and `buffer_font_family` is the editor font.
 * Zed keeps no VS Code-style keybindings and its recent workspaces live in its own SQLite store: neither is read.
 */
export function parseZedTheme(text: string): ImportedTheme {
  try {
    const doc = parseJsonc(text) as Record<string, unknown> | null;
    const theme = doc?.['theme'];
    const font = doc?.['buffer_font_family'];
    let name: unknown = theme;
    if (theme && typeof theme === 'object') {
      const t = theme as { mode?: unknown; light?: unknown; dark?: unknown };
      name = t.mode === 'light' ? t.light : (t.dark ?? t.light);
    }
    return {
      colorTheme: typeof name === 'string' && name ? name : null,
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
  /** Directory entry names (`[]` when unreadable); tests inject a map. */
  listDir?: (p: string) => string[];
  /** mtime in epoch ms, null when unreadable. */
  mtimeMs?: (p: string) => number | null;
}

export interface IdeImportSource {
  kind: ImportIdeKind;
  /** VS Code / Cursor / Windsurf `User` dir or Zed's config dir (from DetectService); ignored for JetBrains / Neovim. */
  configDir: string | null;
}

export class IdeImportService {
  private readonly exists: (p: string) => boolean;
  private readonly readFile: (p: string) => string;
  private readonly readBytes: (p: string) => Uint8Array;
  private readonly readVscdb: (file: string, platform: NodeJS.Platform) => string[];
  private readonly listDir: (p: string) => string[];
  private readonly mtimeMs: (p: string) => number | null;

  constructor(private readonly deps: IdeImportDeps) {
    this.exists = deps.exists ?? existsSync;
    this.readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    this.readBytes = deps.readBytes ?? ((p) => new Uint8Array(readFileSync(p)));
    this.readVscdb = deps.readVscdb ?? readVscdbRecents;
    this.listDir =
      deps.listDir ??
      ((p) => {
        try {
          return readdirSync(p);
        } catch {
          return [];
        }
      });
    this.mtimeMs =
      deps.mtimeMs ??
      ((p) => {
        try {
          return Math.round(statSync(p).mtimeMs);
        } catch {
          return null;
        }
      });
  }

  /** Recent project folders of one editor (existing directories only), most recent first. */
  recentFolders(src: IdeImportSource): string[] {
    return this.recentFoldersWithTime(src).map((r) => r.path);
  }

  /**
   * VS Code / Cursor keep recents in up to three places, unioned here (newest first):
   * - `User/globalStorage/state.vscdb` `history.recentlyOpenedPathsList` (older builds, Cursor) and the same key in
   *   every `User/profiles/<id>/globalStorage/state.vscdb`;
   * - `User/workspaceStorage/<hash>/workspace.json`, one per folder ever opened (VS Code 1.10x+ writes nothing
   *   else); the directory's mtime is when it was last opened;
   * - `<Code>/Backups/workspaces.json` (hot-exit backups), when present.
   */
  private vscodeRecents(configDir: string): RecentFolder[] {
    const { platform } = this.deps;
    const mru = (db: string): RecentFolder[] =>
      this.exists(db) ? this.readVscdb(db, platform).map((path) => ({ path, openedAt: null })) : [];
    const legacy = [
      ...mru(join(configDir, 'globalStorage', 'state.vscdb')),
      ...this.listDir(join(configDir, 'profiles')).flatMap((id) =>
        mru(join(configDir, 'profiles', id, 'globalStorage', 'state.vscdb')),
      ),
    ];
    const storage = join(configDir, 'workspaceStorage');
    const stored: RecentFolder[] = [];
    for (const hash of this.listDir(storage)) {
      const file = join(storage, hash, 'workspace.json');
      if (!this.exists(file)) continue;
      let path: string | null = null;
      try {
        path = parseWorkspaceJson(this.readFile(file), platform);
      } catch {
        continue;
      }
      if (path === null) continue;
      stored.push({ path, openedAt: this.mtimeMs(join(storage, hash)) ?? this.mtimeMs(file) ?? 0 });
    }
    const backups = join(dirname(configDir), 'Backups', 'workspaces.json');
    let backedUp: RecentFolder[] = [];
    if (this.exists(backups)) {
      try {
        backedUp = parseBackupsWorkspaces(this.readFile(backups), platform).map((path) => ({
          path,
          openedAt: null,
        }));
      } catch {
        /* unreadable */
      }
    }
    return mergeRecents(legacy, stored, backedUp);
  }

  /** Recent project folders of one editor with their last-opened time where the editor records one. */
  recentFoldersWithTime(src: IdeImportSource): RecentFolder[] {
    const { platform, home } = this.deps;
    let folders: RecentFolder[] = [];
    if (isVscodeLike(src.kind)) {
      if (src.configDir) folders = this.vscodeRecents(src.configDir);
    } else if (src.kind === 'jetbrains') {
      const seen = new Set<string>();
      for (const f of this.jetbrainsRecentFiles()) {
        try {
          for (const p of parseJetbrainsRecents(this.readFile(f), home, platform))
            if (!seen.has(p)) {
              seen.add(p);
              folders.push({ path: p, openedAt: null });
            }
        } catch {
          /* unreadable */
        }
      }
    } else if (src.kind === 'neovim') {
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
          const seen = new Set<string>();
          for (const f of parseShadaOldfiles(this.readBytes(shada))) {
            const root = repoRootOf(f, this.exists);
            if (root && !seen.has(root)) {
              seen.add(root);
              folders.push({ path: root, openedAt: null });
            }
          }
        } catch {
          /* unreadable */
        }
      }
    }
    // Zed: its workspace history is an internal SQLite store; nothing is read (recentsSource null).
    return folders.filter((r) => this.isDir(r.path));
  }

  /** Everything the onboarding toggles can import for one editor. */
  importFrom(
    src: IdeImportSource,
    what: { recents: boolean; keybindings: boolean; theme: boolean },
  ): IdeImportResult {
    const out: IdeImportResult = { recents: [], keybindings: null, theme: null };
    if (what.recents) out.recents = this.recentFolders(src);
    if (isVscodeLike(src.kind) && src.configDir) {
      if (what.keybindings) {
        const f = join(src.configDir, 'keybindings.json');
        if (this.exists(f)) out.keybindings = parseKeybindings(this.readFile(f));
      }
      if (what.theme) {
        const f = join(src.configDir, 'settings.json');
        if (this.exists(f)) out.theme = parseVscodeTheme(this.readFile(f));
      }
    } else if (src.kind === 'zed' && src.configDir && what.theme) {
      const f = join(src.configDir, 'settings.json');
      if (this.exists(f)) out.theme = parseZedTheme(this.readFile(f));
    }
    return out;
  }

  /** All recent folders across the editors detected on this machine, most recent first per editor. */
  allRecentFolders(sources: IdeImportSource[]): string[] {
    return this.allRecentFoldersWithTime(sources).map((r) => r.path);
  }

  /** Union across editors (`mergeRecents` order): each editor's MRU rows first, then by last-opened time. */
  allRecentFoldersWithTime(sources: IdeImportSource[]): RecentFolder[] {
    return mergeRecents(...sources.map((s) => this.recentFoldersWithTime(s)));
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
    const binDir = win32.join(
      deps.env['LOCALAPPDATA'] ?? win32.join(deps.home, 'AppData', 'Local'),
      'Styx',
      'bin',
    );
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
      // Written back with `reg add` as REG_EXPAND_SZ, never `setx`: setx cuts the value at 1024 characters and stores
      // `%USERPROFILE%`-style entries as plain text, which damages the person's PATH.
      const q = await deps
        .exec('reg', ['query', 'HKCU\\Environment', '/v', 'Path'])
        .catch(() => ({ stdout: '' }));
      const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(q.stdout);
      const current = (m?.[1] ?? '').trim();
      const next = current ? `${current.replace(/;+$/, '')};${binDir}` : binDir;
      await deps.exec('reg', [
        'add',
        'HKCU\\Environment',
        '/v',
        'Path',
        '/t',
        'REG_EXPAND_SZ',
        '/d',
        next,
        '/f',
      ]);
      // Tell Windows the environment changed so new terminals see it (setx of a variable of Styx's own broadcasts it).
      await deps.exec('setx', ['STYX_OPEN_IN', '1']).catch(() => undefined);
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
