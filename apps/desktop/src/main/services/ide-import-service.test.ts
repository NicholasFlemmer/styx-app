import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fakeIdeMachine, installVscodeLike, installZed, writeStateDb } from './__fixtures__/ide-machine';
import {
  IdeImportService,
  fileUriToPath,
  installOpenIn,
  mergeRecents,
  parseBackupsWorkspaces,
  parseJetbrainsRecents,
  parseJsonc,
  parseKeybindings,
  parseShadaOldfiles,
  parseVscodeRecents,
  parseVscodeTheme,
  parseWorkspaceJson,
  parseZedTheme,
  readVscdbRecents,
  repoRootOf,
  workspaceFileToFolder,
  type OpenInInstallDeps,
} from './ide-import-service';

const FIX = join(__dirname, '__fixtures__');
const read = (p: string) => readFileSync(join(FIX, p), 'utf8');

describe('VS Code / Cursor readers', () => {
  it('maps file URIs to paths per platform and drops remote URIs', () => {
    expect(fileUriToPath('file:///Users/me/code/x', 'darwin')).toBe('/Users/me/code/x');
    expect(fileUriToPath('file:///Users/me/work/blog%20v2/', 'darwin')).toBe('/Users/me/work/blog v2');
    expect(fileUriToPath('file:///c%3A/dev/my%20app', 'win32')).toBe('C:\\dev\\my app');
    expect(fileUriToPath('vscode-remote://ssh-remote%2Bbox/home/me', 'darwin')).toBeNull();
  });

  it('parses recentlyOpenedPathsList folders (+ .code-workspace parents), de-duplicated and in order', () => {
    expect(parseVscodeRecents(read('vscode/recentlyOpened.json'), 'darwin')).toEqual([
      '/Users/me/code/acme-shop',
      '/Users/me/work/blog v2',
      '/Users/me/work/teko',
    ]);
    expect(parseVscodeRecents('not json', 'darwin')).toEqual([]);
    expect(parseVscodeRecents('{"entries": 3}', 'darwin')).toEqual([]);
  });

  it('reads the recents key from a state.vscdb (SQLite ItemTable) read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-vscdb-'));
    const file = join(dir, 'state.vscdb');
    const db = new Database(file);
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
      'history.recentlyOpenedPathsList',
      read('vscode/recentlyOpened.json'),
    );
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('secret.lookalike', 'never read');
    db.close();
    expect(readVscdbRecents(file, 'darwin')).toEqual([
      '/Users/me/code/acme-shop',
      '/Users/me/work/blog v2',
      '/Users/me/work/teko',
    ]);
    expect(readVscdbRecents(join(dir, 'missing.vscdb'), 'darwin')).toEqual([]);
  });

  it('workspaceStorage/<hash>/workspace.json: folder, .code-workspace parent, nothing for untitled workspaces', () => {
    expect(parseWorkspaceJson(read('vscode/User/workspaceStorage/aaa/workspace.json'), 'darwin')).toBe(
      '/Users/me/STYX',
    );
    expect(parseWorkspaceJson(read('vscode/User/workspaceStorage/bbb/workspace.json'), 'darwin')).toBe(
      '/Users/me/Documents/Teko/backend',
    );
    expect(parseWorkspaceJson(read('vscode/User/workspaceStorage/ccc/workspace.json'), 'darwin')).toBeNull();
    expect(parseWorkspaceJson('{}', 'darwin')).toBeNull();
    expect(parseWorkspaceJson('nope', 'darwin')).toBeNull();
    expect(parseWorkspaceJson('{"folder":"file:///c%3A/dev/app"}', 'win32')).toBe('C:\\dev\\app');
    expect(workspaceFileToFolder('file:///Users/me/x/y.code-workspace', 'darwin')).toBe('/Users/me/x');
    expect(workspaceFileToFolder('file:///Users/me/x/notes.md', 'darwin')).toBeNull();
  });

  it('Backups/workspaces.json: folder infos and root-URI workspaces', () => {
    expect(parseBackupsWorkspaces(read('vscode/Backups/workspaces.json'), 'darwin')).toEqual([
      '/Users/me/gmaps-scraper',
      '/Users/me/work/infra',
    ]);
    expect(parseBackupsWorkspaces('[]', 'darwin')).toEqual([]);
    expect(parseBackupsWorkspaces('{', 'darwin')).toEqual([]);
  });

  it('mergeRecents: MRU rows first (borrowing a known timestamp), then by time desc, de-duplicated', () => {
    expect(
      mergeRecents(
        [
          { path: '/a', openedAt: null },
          { path: '/b', openedAt: null },
        ],
        [
          { path: '/c', openedAt: 10 },
          { path: '/b', openedAt: 30 },
          { path: '/d', openedAt: 20 },
          { path: '/c', openedAt: 5 },
        ],
        [{ path: '/e', openedAt: null }],
      ),
    ).toEqual([
      { path: '/a', openedAt: null },
      { path: '/b', openedAt: 30 },
      { path: '/e', openedAt: null },
      { path: '/d', openedAt: 20 },
      { path: '/c', openedAt: 10 },
    ]);
  });

  it('parses JSONC keybindings and skips malformed rows', () => {
    expect(parseKeybindings(read('vscode/User/keybindings.json'))).toEqual([
      { key: 'cmd+shift+p', command: 'workbench.action.showCommands' },
      { key: 'ctrl+k ctrl+t', command: 'workbench.action.selectTheme', when: 'editorTextFocus' },
      { key: 'alt+z', command: '-editor.action.toggleWordWrap' },
    ]);
    expect(parseKeybindings('{}')).toEqual([]);
    expect(parseKeybindings('[[')).toEqual([]);
  });

  it('reads only theme and font family from settings.json', () => {
    expect(parseVscodeTheme(read('vscode/User/settings.json'))).toEqual({
      colorTheme: 'GitHub Dark Default',
      fontFamily: 'JetBrains Mono, Menlo, monospace',
    });
    expect(parseVscodeTheme('{ "editor.fontSize": 12 }')).toEqual({ colorTheme: null, fontFamily: null });
    expect(parseVscodeTheme('nope')).toEqual({ colorTheme: null, fontFamily: null });
  });

  it('parseJsonc keeps // and /* */ inside strings', () => {
    expect(parseJsonc('{ "a": "http://x/*y*/", /* c */ "b": [1, 2, ], } // t')).toEqual({
      a: 'http://x/*y*/',
      b: [1, 2],
    });
  });
});

describe('JetBrains / Neovim readers', () => {
  it('parses recentProjects.xml entries with $USER_HOME$ expanded', () => {
    expect(parseJetbrainsRecents(read('jetbrains/recentProjects.xml'), '/Users/me', 'darwin')).toEqual([
      '/Users/me/code/acme-shop',
      '/Users/me/work/infra-tools',
      '/opt/shared/client-x & co',
    ]);
    expect(
      parseJetbrainsRecents(
        '<application><component name="RecentProjectsManager"><option name="recentPaths"><list><option value="$USER_HOME$/old" /></list></option></component></application>',
        'C:\\Users\\me',
        'win32',
      ),
    ).toEqual(['C:\\Users\\me\\old']);
  });

  it('parses shada oldfiles from marks, jumps, changes and the buffer list', () => {
    const bytes = new Uint8Array(readFileSync(join(FIX, 'nvim', 'main.shada')));
    expect(parseShadaOldfiles(bytes)).toEqual([
      '/Users/me/code/acme-shop/src/index.ts',
      '/Users/me/work/infra-tools/main.tf',
      '/Users/me/code/acme-shop/README.md',
      '/tmp/loose.txt',
    ]);
    expect(parseShadaOldfiles(new Uint8Array([0xc1, 0xc1]))).toEqual([]);
  });

  it('resolves a file to its enclosing repo root', () => {
    const exists = (p: string) => p === '/Users/me/code/acme-shop/.git';
    expect(repoRootOf('/Users/me/code/acme-shop/src/index.ts', exists)).toBe('/Users/me/code/acme-shop');
    expect(repoRootOf('/tmp/loose.txt', exists)).toBeNull();
  });
});

describe('IdeImportService', () => {
  it('VS Code 1.10x+ (no recents key): recents come from workspaceStorage, newest dir first; Cursor reads the same layout', () => {
    const storage = '/cfg/User/workspaceStorage';
    const mtimes: Record<string, number> = {
      [`${storage}/aaa`]: 300,
      [`${storage}/bbb`]: 100,
      [`${storage}/ddd`]: 200,
    };
    const existing = new Set([
      '/Users/me/STYX',
      '/Users/me/Documents/Teko/backend',
      '/Users/me/code/acme-shop',
      `${storage}/aaa/workspace.json`,
      `${storage}/bbb/workspace.json`,
      `${storage}/ccc/workspace.json`,
      `${storage}/ddd/workspace.json`,
    ]);
    const svc = new IdeImportService({
      platform: 'darwin',
      home: '/Users/me',
      env: {},
      exists: (p) => existing.has(p),
      readFile: (p) => read(p.replace('/cfg/', 'vscode/')),
      listDir: (p) => (p === storage ? ['bbb', 'aaa', 'ccc', 'ddd', 'ext-dev'] : []),
      mtimeMs: (p) => mtimes[p] ?? null,
      readVscdb: () => {
        throw new Error('state.vscdb must not be opened when it does not exist');
      },
    });
    for (const kind of ['vscode', 'cursor'] as const)
      expect(svc.recentFoldersWithTime({ kind, configDir: '/cfg/User' })).toEqual([
        { path: '/Users/me/STYX', openedAt: 300 },
        { path: '/Users/me/code/acme-shop', openedAt: 200 },
        { path: '/Users/me/Documents/Teko/backend', openedAt: 100 },
      ]);
    expect(svc.recentFolders({ kind: 'vscode', configDir: '/cfg/User' })).toEqual([
      '/Users/me/STYX',
      '/Users/me/code/acme-shop',
      '/Users/me/Documents/Teko/backend',
    ]);
  });

  it('unions the legacy key (global + profile state.vscdb), workspaceStorage and Backups; legacy MRU order leads', () => {
    const storage = '/cfg/User/workspaceStorage';
    const existing = new Set([
      '/Users/me/STYX',
      '/Users/me/code/acme-shop',
      '/Users/me/work/blog v2',
      '/Users/me/gmaps-scraper',
      '/Users/me/work/infra',
      '/cfg/User/globalStorage/state.vscdb',
      '/cfg/User/profiles/p1/globalStorage/state.vscdb',
      `${storage}/aaa/workspace.json`,
      `${storage}/ddd/workspace.json`,
      '/cfg/Backups/workspaces.json',
    ]);
    const svc = new IdeImportService({
      platform: 'darwin',
      home: '/Users/me',
      env: {},
      exists: (p) => existing.has(p),
      readFile: (p) => read(p.replace('/cfg/', 'vscode/')),
      listDir: (p) => (p === storage ? ['aaa', 'ddd'] : p === '/cfg/User/profiles' ? ['p1'] : []),
      mtimeMs: (p) => (p === `${storage}/aaa` ? 300 : p === `${storage}/ddd` ? 200 : null),
      readVscdb: (file) =>
        file.includes('/profiles/')
          ? ['/Users/me/work/blog v2']
          : ['/Users/me/code/acme-shop', '/Users/me/missing'],
    });
    expect(svc.recentFoldersWithTime({ kind: 'vscode', configDir: '/cfg/User' })).toEqual([
      { path: '/Users/me/code/acme-shop', openedAt: 200 },
      { path: '/Users/me/work/blog v2', openedAt: null },
      { path: '/Users/me/gmaps-scraper', openedAt: null },
      { path: '/Users/me/work/infra', openedAt: null },
      { path: '/Users/me/STYX', openedAt: 300 },
    ]);
  });

  it('imports recents, keybindings and theme from a VS Code User dir; Neovim recents map to repo roots', () => {
    const existing = new Set([
      '/Users/me/code/acme-shop',
      '/Users/me/code/acme-shop/.git',
      '/Users/me/work/infra-tools',
      '/Users/me/work/infra-tools/.git',
      '/cfg/User/globalStorage/state.vscdb',
      '/cfg/User/keybindings.json',
      '/cfg/User/settings.json',
      '/Users/me/.local/share/nvim/shada/main.shada',
    ]);
    const svc = new IdeImportService({
      platform: 'darwin',
      home: '/Users/me',
      env: {},
      exists: (p) => existing.has(p),
      readFile: (p) =>
        p.endsWith('keybindings.json')
          ? read('vscode/User/keybindings.json')
          : read('vscode/User/settings.json'),
      readBytes: () => new Uint8Array(readFileSync(join(FIX, 'nvim', 'main.shada'))),
      readVscdb: () => ['/Users/me/code/acme-shop', '/Users/me/work/blog v2'],
    });
    const r = svc.importFrom(
      { kind: 'vscode', configDir: '/cfg/User' },
      { recents: true, keybindings: true, theme: true },
    );
    expect(r.recents).toEqual(['/Users/me/code/acme-shop']); // blog v2 does not exist on disk
    expect(r.keybindings?.length).toBe(3);
    expect(r.theme?.colorTheme).toBe('GitHub Dark Default');
    const nothing = svc.importFrom(
      { kind: 'vscode', configDir: '/cfg/User' },
      { recents: false, keybindings: false, theme: false },
    );
    expect(nothing).toEqual({ recents: [], keybindings: null, theme: null });
    expect(svc.recentFolders({ kind: 'neovim', configDir: null })).toEqual([
      '/Users/me/code/acme-shop',
      '/Users/me/work/infra-tools',
    ]);
    expect(
      svc.allRecentFolders([
        { kind: 'vscode', configDir: '/cfg/User' },
        { kind: 'neovim', configDir: null },
      ]),
    ).toEqual(['/Users/me/code/acme-shop', '/Users/me/work/infra-tools']);
  });
});

describe('Cursor / Windsurf / Zed', () => {
  it('Cursor: keybindings (Cursor-only commands included) and theme parse with the VS Code readers', () => {
    expect(parseKeybindings(read('cursor/User/keybindings.json'))).toEqual([
      {
        key: 'cmd+k',
        command: 'aipopup.action.modal.generate',
        when: 'editorFocus && !composerBarIsVisible',
      },
      { key: 'cmd+l', command: 'aichat.newchataction' },
      { key: 'cmd+shift+p', command: 'workbench.action.showCommands' },
    ]);
    expect(parseVscodeTheme(read('cursor/User/settings.json'))).toEqual({
      colorTheme: 'Cursor Dark Midnight',
      fontFamily: 'Berkeley Mono, Menlo, monospace',
    });
    expect(parseVscodeRecents(read('cursor/recentlyOpened.json'), 'darwin')).toEqual([
      '/Users/me/code/acme-shop',
      '/Users/me/work/client-x',
    ]);
  });

  it('Windsurf: recents (state.vscdb), keybindings and theme go through the same readers as VS Code, on real files', () => {
    const m = fakeIdeMachine('darwin');
    const ws = installVscodeLike(m, 'windsurf', '1.12.5');
    const configDir = ws.configDir ?? '';
    // The fixture folders do not exist here; point the recents at two that do (+ one that does not).
    const infra = join(m.home, 'work', 'infra-tools');
    const shop = join(m.home, 'code', 'acme-shop');
    mkdirSync(infra, { recursive: true });
    mkdirSync(shop, { recursive: true });
    writeStateDb(
      join(configDir, 'globalStorage', 'state.vscdb'),
      JSON.stringify({
        entries: [
          { folderUri: pathToFileURL(infra).href },
          { fileUri: pathToFileURL(join(shop, 'README.md')).href },
          { folderUri: pathToFileURL(join(m.home, 'gone')).href },
          { folderUri: pathToFileURL(shop).href },
        ],
      }),
    );
    const svc = new IdeImportService({ platform: 'darwin', home: m.home, env: {} });
    expect(
      svc.importFrom({ kind: 'windsurf', configDir }, { recents: true, keybindings: true, theme: true }),
    ).toEqual({
      recents: [infra, shop],
      keybindings: [
        { key: 'cmd+i', command: 'windsurf.prioritized.command.open', when: 'editorTextFocus' },
        { key: 'cmd+shift+l', command: 'windsurf.prioritized.chat.open' },
      ],
      theme: { colorTheme: 'Windsurf Dark', fontFamily: 'Fira Code' },
    });
    expect(parseVscodeRecents(read('windsurf/recentlyOpened.json'), 'darwin')).toEqual([
      '/Users/me/work/infra-tools',
      '/Users/me/code/acme-shop',
      '/Users/me/work/teko',
    ]);
  });

  it('Zed: theme name (object form → the dark one, or the explicit mode) and buffer font; nothing else', () => {
    expect(parseZedTheme(read('zed/settings.json'))).toEqual({
      colorTheme: 'Ayu Dark',
      fontFamily: 'Zed Plex Mono',
    });
    expect(parseZedTheme('{ "theme": "One Dark", "buffer_font_size": 15 }')).toEqual({
      colorTheme: 'One Dark',
      fontFamily: null,
    });
    expect(
      parseZedTheme('{ "theme": { "mode": "light", "light": "One Light", "dark": "One Dark" } }'),
    ).toEqual({
      colorTheme: 'One Light',
      fontFamily: null,
    });
    expect(parseZedTheme('{ "theme": { "mode": "dark", "light": "One Light" } }')).toEqual({
      colorTheme: 'One Light',
      fontFamily: null,
    });
    expect(parseZedTheme('nope')).toEqual({ colorTheme: null, fontFamily: null });
  });

  it('Zed import: theme only — no keybindings, no recents (never the Neovim shada), on real files', () => {
    const m = fakeIdeMachine('darwin');
    const zed = installZed(m, '0.201.6');
    const shada = join(m.home, '.local', 'share', 'nvim', 'shada');
    mkdirSync(shada, { recursive: true });
    const svc = new IdeImportService({
      platform: 'darwin',
      home: m.home,
      env: {},
      readBytes: () => new Uint8Array(readFileSync(join(FIX, 'nvim', 'main.shada'))),
    });
    expect(
      svc.importFrom(
        { kind: 'zed', configDir: zed.configDir },
        { recents: true, keybindings: true, theme: true },
      ),
    ).toEqual({
      recents: [],
      keybindings: null,
      theme: { colorTheme: 'Ayu Dark', fontFamily: 'Zed Plex Mono' },
    });
    expect(svc.recentFoldersWithTime({ kind: 'zed', configDir: zed.configDir })).toEqual([]);
    expect(
      svc.importFrom({ kind: 'zed', configDir: null }, { recents: true, keybindings: true, theme: true }),
    ).toEqual({
      recents: [],
      keybindings: null,
      theme: null,
    });
  });
});

describe('installOpenIn', () => {
  const base = (platform: NodeJS.Platform, extra: Partial<OpenInInstallDeps> = {}) => {
    const calls: string[] = [];
    const files = new Map<string, string>();
    const links: [string, string][] = [];
    const deps: OpenInInstallDeps = {
      platform,
      home: platform === 'win32' ? 'C:\\Users\\me' : '/Users/me',
      env:
        platform === 'win32'
          ? { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: 'C:\\Windows' }
          : { PATH: '/usr/bin:/bin' },
      launcherDir: platform === 'win32' ? 'C:\\ud\\open-in' : '/ud/open-in',
      exec: vi.fn(async (bin, args) => {
        calls.push([bin, ...args].join(' '));
        return {
          exitCode: 0,
          stdout:
            bin === 'reg' && args[0] === 'query' ? '    Path    REG_EXPAND_SZ    C:\\Users\\me\\bin\r\n' : '',
        };
      }),
      writeFile: (p, body) => void files.set(p, body),
      mkdir: () => undefined,
      symlink: (t, l) => void links.push([t, l]),
      exists: () => false,
      remove: () => undefined,
      ...extra,
    };
    return { deps, calls, files, links };
  };

  it('macOS: writes the launcher and symlinks it into /usr/local/bin', async () => {
    const { deps, files, links } = base('darwin');
    const r = await installOpenIn(deps);
    expect(r).toEqual({ installedAt: '/usr/local/bin/styx', pathHint: null });
    expect(files.get('/ud/open-in/styx')).toContain('styx://open?path=');
    expect(links).toEqual([['/ud/open-in/styx', '/usr/local/bin/styx']]);
  });

  it('macOS: falls back to ~/.local/bin with a PATH hint when /usr/local/bin is not writable', async () => {
    const { deps, links } = base('darwin', {
      mkdir: (p) => {
        if (p === '/usr/local/bin') throw new Error('EACCES');
      },
    });
    const r = await installOpenIn(deps);
    expect(r.installedAt).toBe('/Users/me/.local/bin/styx');
    expect(r.pathHint).toContain('.local/bin');
    expect(links).toEqual([['/ud/open-in/styx', '/Users/me/.local/bin/styx']]);
  });

  it('Windows: registers the HKCU Directory shell verb and appends the bin dir to the user PATH', async () => {
    const { deps, calls, files } = base('win32');
    const r = await installOpenIn(deps);
    const bin = 'C:\\Users\\me\\AppData\\Local\\Styx\\bin';
    expect(r.installedAt).toBe(`${bin}\\styx.cmd`);
    expect(r.pathHint).toContain(bin);
    expect(files.get(`${bin}\\styx.cmd`)).toContain('styx://open?path=');
    expect(calls[0]).toBe('reg add HKCU\\Software\\Classes\\Directory\\shell\\Styx /ve /d Open in Styx /f');
    expect(calls[1]).toBe(
      `reg add HKCU\\Software\\Classes\\Directory\\shell\\Styx\\command /ve /d "${bin}\\styx.cmd" "%V" /f`,
    );
    expect(calls.at(-1)).toBe(`setx PATH C:\\Users\\me\\bin;${bin}`);
  });
});
