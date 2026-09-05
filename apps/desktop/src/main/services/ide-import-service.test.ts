import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  IdeImportService,
  fileUriToPath,
  installOpenIn,
  parseJetbrainsRecents,
  parseJsonc,
  parseKeybindings,
  parseShadaOldfiles,
  parseVscodeRecents,
  parseVscodeTheme,
  readVscdbRecents,
  repoRootOf,
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

  it('parses recentlyOpenedPathsList folders only, de-duplicated and in order', () => {
    expect(parseVscodeRecents(read('vscode/recentlyOpened.json'), 'darwin')).toEqual([
      '/Users/me/code/acme-shop',
      '/Users/me/work/blog v2',
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
    expect(readVscdbRecents(file, 'darwin')).toEqual(['/Users/me/code/acme-shop', '/Users/me/work/blog v2']);
    expect(readVscdbRecents(join(dir, 'missing.vscdb'), 'darwin')).toEqual([]);
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
