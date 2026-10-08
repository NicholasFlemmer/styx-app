import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  IDE_KINDS,
  fakeIdeMachine,
  installAll,
  installJetbrains,
  installJetbrainsRecents,
  installVscodeLike,
  installZed,
  toolboxApps,
} from './__fixtures__/ide-machine';
import {
  compareVersions,
  defaultDeps,
  DetectService,
  findAllOnPath,
  findOnPath,
  parseVersion,
  pickBest,
  systemBinDirs,
  toCliInstall,
  versionSatisfies,
  wellKnownBinDirs,
  type DetectDeps,
  type IdeDetection,
} from './detect-service';
import { IdeImportService } from './ide-import-service';

const FIX = join(__dirname, '__fixtures__');
/**
 * These cases simulate a darwin search (`:`-joined PATH) over real temp dirs. On a Windows host the temp dirs carry a
 * drive-letter colon and `findAllOnPath` splits on the host's `;`, so the simulation cannot hold there.
 */
const darwinPathOnWin = process.platform === 'win32';

function bin(dir: string, name: string) {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\necho 0.0.0\n');
  chmodSync(p, 0o755);
  return p;
}

describe('DetectService', () => {
  it('parses versions', () => {
    expect(parseVersion('claude 2.4.1 (Claude Code)')).toBe('2.4.1');
    expect(parseVersion('zsh 5.9 (arm64-apple-darwin)')).toBe('5.9');
    expect(parseVersion('nothing')).toBeNull();
  });

  it('detects CLIs on PATH with version, capabilities and auth state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-det-'));
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    bin(dir, 'claude');
    bin(dir, 'gemini');
    // A darwin $SHELL; Windows has no /bin/sh, so point at a stand-in written with `/` (the row names it by basename).
    const shell = process.platform === 'win32' ? bin(dir, 'sh').replace(/\\/g, '/') : '/bin/sh';
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    const deps: DetectDeps = {
      platform: 'darwin',
      home,
      pathEnv: dir,
      env: { SHELL: shell },
      exec: async (b, args) => {
        if (args[0] === '--version')
          return {
            stdout: b.endsWith('claude') ? 'claude 2.4.1' : b.endsWith('gemini') ? 'gemini 1.2.0' : 'sh 3.2',
            exitCode: 0,
          };
        if (args[0] === '--help')
          return {
            stdout: b.endsWith('claude')
              ? 'usage: --mcp-config <f> --settings <f> --output-format stream-json -p'
              : 'usage',
            exitCode: 0,
          };
        return { stdout: '', exitCode: 0 };
      },
    };
    const svc = new DetectService(deps);
    const clis = await svc.detectClis();
    const byAgent = Object.fromEntries(clis.map((c) => [c.agent, c]));
    expect(byAgent['claude']).toMatchObject({
      found: true,
      version: '2.4.1',
      authState: 'signed-in',
      capabilities: { mcpConfigFlag: true, settingsFlag: true, streamJson: true, printMode: true },
    });
    expect(byAgent['gemini']).toMatchObject({ found: true, version: '1.2.0', authState: 'signed-out' });
    expect(byAgent['codex']).toMatchObject({ found: false, binary: null });
    expect(byAgent['shell']).toMatchObject({ found: true, authState: 'n/a', version: 'sh 3.2' });
    expect(findOnPath('missing', dir, 'darwin')).toBeNull();
  });

  it('detects OpenCode: the bare version it prints, `acp` from its help, sign-in from its auth.json or a provider key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-det-'));
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    bin(dir, 'opencode');
    // `opencode --help` as 1.18.35 prints it (abridged): `acp` is a subcommand, there is no stream-json.
    const help =
      'Commands:\n  opencode acp                 start ACP (Agent Client Protocol) server\n  opencode run [message..]     run opencode with a message\n';
    const deps = (env: NodeJS.ProcessEnv): DetectDeps => ({
      platform: 'darwin',
      home,
      pathEnv: dir,
      env: { SHELL: '/bin/sh', ...env },
      exec: async (b, args) => ({
        stdout: args[0] === '--version' ? (b.endsWith('opencode') ? '1.18.35' : 'sh 3.2') : help,
        exitCode: 0,
      }),
    });
    const opencode = async (env: NodeJS.ProcessEnv = {}) =>
      (await new DetectService(deps(env)).detectClis()).find((c) => c.agent === 'opencode');
    const none = await opencode();
    expect(none).toMatchObject({
      label: 'OpenCode',
      found: true,
      version: '1.18.35',
      // No login and no key: it can still run OpenCode's free models, so not "signed out".
      authState: 'unknown',
      capabilities: { acp: true, streamJson: false, appServer: false },
    });
    expect((await opencode({ OPENROUTER_API_KEY: 'x' }))?.authState).toBe('signed-in');
    const xdg = mkdtempSync(join(tmpdir(), 'styx-xdg-'));
    mkdirSync(join(xdg, 'opencode'));
    writeFileSync(join(xdg, 'opencode', 'auth.json'), '{}');
    expect((await opencode({ XDG_DATA_HOME: xdg }))?.authState).toBe('signed-in');
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), '{}');
    expect((await opencode())?.authState).toBe('signed-in');
  });

  it('looks in OpenCode’s installer folder (~/.opencode/bin)', () => {
    expect(wellKnownBinDirs('/Users/me', 'darwin', {})).toContain(join('/Users/me', '.opencode', 'bin'));
    expect(wellKnownBinDirs('/home/me', 'linux', {})).toContain(join('/home/me', '.opencode', 'bin'));
  });

  it('compares versions numerically; a missing version sorts lowest', () => {
    expect(compareVersions('2.1.261', '2.1.199')).toBe(1);
    expect(compareVersions('2.1.199', '2.1.261')).toBe(-1);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.1.0-beta.1', '2.1.0')).toBe(-1);
    expect(compareVersions(null, '0.0.1')).toBe(-1);
    expect(compareVersions(null, null)).toBe(0);
    expect(versionSatisfies('2.1.263', '2.1.251')).toBe(true);
    expect(versionSatisfies('2.1.199', '2.1.251')).toBe(false);
    expect(versionSatisfies(null, '2.1.251')).toBe(false);
    expect(
      pickBest([
        { binary: '/a', version: '2.1.199', source: 'path' },
        { binary: '/b', version: '2.1.261', source: 'vscode-extension' },
        { binary: '/c', version: '2.1.261', source: 'cursor-extension' },
      ]),
    ).toEqual({ binary: '/b', version: '2.1.261', source: 'vscode-extension' });
    expect(pickBest([])).toBeNull();
  });

  describe('what the terminal sees (#98)', () => {
    it.skipIf(darwinPathOnWin)(
      'unions the login PATH, the shell answer and the install folders; PATH > shell > well-known; searched lists the folders',
      async () => {
        const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
        const loginDir = join(home, 'login-bin');
        const local = join(home, '.local', 'bin');
        const nvm = join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin');
        const shims = join(home, 'shims');
        for (const d of [loginDir, local, nvm, shims]) mkdirSync(d, { recursive: true });
        const onLogin = bin(loginDir, 'codex'); // on the login PATH only — the Dock-launched process never had it
        const inLocal = bin(local, 'claude'); // the native installer's folder, on no PATH at all
        const inNvm = bin(nvm, 'gemini'); // an npm global under nvm
        const shim = bin(shims, 'agent'); // Cursor's `agent`, known to the shell alone (alias / shim)
        const versions: Record<string, string> = {
          [onLogin]: 'codex-cli 0.5.0',
          [inLocal]: 'claude 2.1.300',
          [inNvm]: 'gemini 1.0.0',
          [shim]: 'cursor-agent 1.2.0',
        };
        const execPaths: string[] = [];
        const deps: DetectDeps = {
          platform: 'darwin',
          home,
          pathEnv: '/nonexistent/bin',
          env: { SHELL: '/bin/sh' },
          login: async () => ({ path: `${loginDir}:/nonexistent/bin`, which: { agent: shim } }),
          exec: async (b, args, opts) => {
            if (opts !== undefined) execPaths.push(opts.PATH);
            if (args[0] === '--version') return { stdout: versions[b] ?? 'sh 3.2', exitCode: 0 };
            return { stdout: 'usage', exitCode: 0 };
          },
        };
        const reported: string[][] = [];
        const svc = new DetectService(deps);
        svc.onSearched = (dirs) => reported.push(dirs);
        const by = Object.fromEntries((await svc.detectClis()).map((c) => [c.agent, c]));
        expect(by['codex']).toMatchObject({ found: true, binary: onLogin, source: 'path', version: '0.5.0' });
        expect(by['claude']).toMatchObject({ found: true, binary: inLocal, source: 'well-known' });
        expect(by['gemini']).toMatchObject({ found: true, binary: inNvm, source: 'well-known' });
        expect(by['cursor']).toMatchObject({ found: true, binary: shim, source: 'shell', version: '1.2.0' });
        // The folders that exist, login PATH first; every row carries them and the watcher hears about them.
        expect(by['claude']?.searched).toEqual([loginDir, local, nvm]);
        expect(by['shell']?.searched).toEqual([loginDir, local, nvm]);
        expect(reported).toEqual([[loginDir, local, nvm]]);
        expect(toCliInstall(by['claude']!, 1).capabilities['searched']).toEqual([loginDir, local, nvm]);
        // Version probes run with the whole search space on PATH, so a shim that needs its manager's dir can answer.
        expect(execPaths[0]).toBe(`${loginDir}:/nonexistent/bin:${local}:${nvm}`);
        // A bare name typed into the modal resolves the same way: the shell's answer first, then the search space.
        expect(await svc.resolveName('agent')).toBe(shim);
        expect(await svc.resolveName('claude')).toBe(inLocal);
        expect(await svc.resolveName('nope')).toBeNull();
        // A login shell that does not answer leaves the process PATH and the install folders in play.
        const quiet = new DetectService({
          ...deps,
          login: async () => {
            throw new Error('shell timed out');
          },
        });
        const again = await quiet.detectClis();
        expect(again.find((c) => c.agent === 'claude')).toMatchObject({
          binary: inLocal,
          source: 'well-known',
        });
        expect(again.find((c) => c.agent === 'codex')).toMatchObject({
          found: false,
          searched: [local, nvm],
        });
      },
    );

    it("install folders: the vendors' and package managers' dirs under home, plus injected machine-wide ones", () => {
      const home = '/Users/nic';
      // `join` follows the host: compare the darwin dirs with `/` so a Windows host checks the same layout.
      const posix = wellKnownBinDirs(home, 'darwin', {}, ['/opt/homebrew/bin']).map((d) =>
        d.replace(/\\/g, '/'),
      );
      expect(posix.slice(0, 3)).toEqual([
        '/Users/nic/.local/bin',
        '/opt/homebrew/bin',
        '/Users/nic/.npm-global/bin',
      ]);
      expect(posix).toContain('/Users/nic/.claude/local');
      expect(posix).toContain('/Users/nic/.local/share/mise/shims');
      expect(wellKnownBinDirs(home, 'darwin', {})).not.toContain('/opt/homebrew/bin');
      const winHome = 'C:\\Users\\nic';
      const win = wellKnownBinDirs(
        winHome,
        'win32',
        { APPDATA: 'C:\\Users\\nic\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\nic\\AppData\\Local' },
        systemBinDirs('win32', { ProgramFiles: 'C:\\Program Files' }),
      );
      expect(win).toContain(join(winHome, '.local', 'bin'));
      expect(win).toContain(join('C:\\Users\\nic\\AppData\\Roaming', 'npm'));
      expect(win).toContain(join('C:\\Program Files', 'nodejs'));
      expect(systemBinDirs('darwin', {})).toEqual([
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/home/linuxbrew/.linuxbrew/bin',
      ]);
      expect(defaultDeps().systemBinDirs).toEqual(systemBinDirs(process.platform, process.env));
    });
  });

  describe('agents that came with an editor (owner request: no second install)', () => {
    it.skipIf(darwinPathOnWin)(
      "Codex inside OpenAI's extension, in VS Code Insiders and Windsurf too; Styx's own tools folder as source styx",
      async () => {
        const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
        const insiders = join(
          home,
          '.vscode-insiders',
          'extensions',
          'openai.chatgpt-0.4.1-darwin-arm64',
          'bin',
          'macos-aarch64',
        );
        const windsurf = join(
          home,
          '.windsurf',
          'extensions',
          'anthropic.claude-code-2.1.300-darwin-arm64',
          'resources',
          'native-binary',
        );
        const styx = join(home, 'styx-tools', 'npm', 'bin');
        for (const d of [insiders, windsurf, styx]) mkdirSync(d, { recursive: true });
        const versions = new Map<string, string>();
        const deps: DetectDeps = {
          platform: 'darwin',
          home,
          pathEnv: '',
          env: { SHELL: '/bin/sh' },
          applicationsDir: join(home, 'Applications'),
          styxDirs: () => [styx],
          exec: async (b, args) =>
            args[0] === '--version'
              ? { stdout: versions.get(b) ?? '', exitCode: 0 }
              : { stdout: '', exitCode: 0 },
        };
        const codex = bin(insiders, 'codex');
        versions.set(codex, 'codex-cli 0.46.0');
        const claude = bin(windsurf, 'claude');
        versions.set(claude, '2.1.300 (Claude Code)');
        const gemini = bin(styx, 'gemini');
        versions.set(gemini, '0.9.0');
        const clis = await new DetectService(deps).detectClis();
        const of = (a: string) => clis.find((c) => c.agent === a);
        expect(of('codex')).toMatchObject({ found: true, binary: codex, source: 'vscode-extension' });
        expect(of('claude')).toMatchObject({ found: true, binary: claude, source: 'windsurf-extension' });
        expect(of('gemini')).toMatchObject({ found: true, binary: gemini, source: 'styx' });
      },
    );
  });

  describe('claude candidates', () => {
    /** A fake machine: two PATH dirs, a VS Code extension bundle and a Cursor one; versions come from the fake exec. */
    function machine() {
      const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      const brew = join(home, 'brew');
      mkdirSync(brew);
      const ext = join(
        home,
        '.vscode',
        'extensions',
        'anthropic.claude-code-2.1.261-darwin-arm64',
        'resources',
        'native-binary',
      );
      mkdirSync(ext, { recursive: true });
      const cursorExt = join(
        home,
        '.cursor',
        'extensions',
        'anthropic.claude-code-2.1.250-darwin-arm64',
        'resources',
        'native-binary',
      );
      mkdirSync(cursorExt, { recursive: true });
      mkdirSync(join(home, '.vscode', 'extensions', 'other.extension-1.0.0'), { recursive: true });
      const apps = join(home, 'Applications');
      mkdirSync(join(apps, 'Claude.app', 'Contents', 'Resources'), { recursive: true });
      const versions = new Map<string, string>();
      const calls: string[] = [];
      const deps: DetectDeps = {
        platform: 'darwin',
        home,
        pathEnv: `${join(home, '.local', 'bin')}:${brew}`,
        env: { SHELL: '/bin/sh' },
        applicationsDir: apps,
        exec: async (b, args) => {
          calls.push(`${args[0]} ${b}`);
          if (args[0] === '--version') return { stdout: versions.get(b) ?? 'sh 3.2', exitCode: 0 };
          if (args[0] === '--help') return { stdout: '--mcp-config --settings stream-json -p', exitCode: 0 };
          return { stdout: '', exitCode: 0 };
        },
      };
      const add = (dir: string, name: string, version: string) => {
        const p = bin(dir, name);
        versions.set(p, `${version} (Claude Code)`);
        return p;
      };
      return {
        home,
        local: join(home, '.local', 'bin'),
        brew,
        ext,
        cursorExt,
        apps,
        deps,
        add,
        calls,
        versions,
      };
    }

    it.skipIf(darwinPathOnWin)(
      'the highest version wins across PATH, VS Code and Cursor bundles; every candidate is listed',
      async () => {
        const m = machine();
        const onPath = m.add(m.local, 'claude', '2.1.199');
        const brew = m.add(m.brew, 'claude', '2.1.15');
        const ext = m.add(m.ext, 'claude', '2.1.261');
        const cursor = m.add(m.cursorExt, 'claude', '2.1.250');
        const desk = m.add(join(m.apps, 'Claude.app', 'Contents', 'Resources'), 'claude', '2.1.100');
        const svc = new DetectService(m.deps);
        const claude = (await svc.detectClis()).find((c) => c.agent === 'claude')!;
        expect(claude).toMatchObject({
          found: true,
          binary: ext,
          version: '2.1.261',
          source: 'vscode-extension',
          capabilities: { streamJson: true },
        });
        expect(claude.alternatives).toEqual([
          { binary: onPath, version: '2.1.199', source: 'path' },
          { binary: brew, version: '2.1.15', source: 'path' },
          { binary: ext, version: '2.1.261', source: 'vscode-extension' },
          { binary: cursor, version: '2.1.250', source: 'cursor-extension' },
          { binary: desk, version: '2.1.100', source: 'desktop-app' },
        ]);
        expect(findAllOnPath('claude', m.deps.pathEnv, 'darwin')).toEqual([onPath, brew]);
        const row = toCliInstall(claude, 1);
        expect(row.capabilities['source']).toBe('vscode-extension');
        expect(row.capabilities['alternatives']).toEqual(claude.alternatives);

        // Second run: nothing changed on disk → no --version / --help is executed again (stat-keyed cache).
        const before = m.calls.length;
        const again = (await svc.detectClis()).find((c) => c.agent === 'claude')!;
        expect(again.binary).toBe(ext);
        expect(m.calls.slice(before).filter((c) => c.includes('claude'))).toEqual([]);
      },
    );

    it.skipIf(darwinPathOnWin)(
      'a manual override wins while it exists and is listed first among the alternatives',
      async () => {
        const m = machine();
        const onPath = m.add(m.local, 'claude', '2.1.199');
        const ext = m.add(m.ext, 'claude', '2.1.261');
        const picked = m.add(m.home, 'my-claude', '2.0.0');
        m.versions.set(picked, '2.0.0');
        const svc = new DetectService(m.deps);
        const claude = (await svc.detectClis({ claude: picked })).find((c) => c.agent === 'claude')!;
        expect(claude).toMatchObject({ binary: picked, version: '2.0.0', source: 'manual', found: true });
        expect(claude.alternatives.map((a) => a.binary)).toEqual([picked, onPath, ext]);
        // An override pointing at a file that is gone is ignored: detection is honest again.
        const gone = (await svc.detectClis({ claude: join(m.home, 'nope') })).find(
          (c) => c.agent === 'claude',
        )!;
        expect(gone).toMatchObject({ binary: ext, source: 'vscode-extension' });
      },
    );

    it('no candidates anywhere → not found, no alternatives', async () => {
      const m = machine();
      const svc = new DetectService(m.deps);
      const claude = (await svc.detectClis()).find((c) => c.agent === 'claude')!;
      expect(claude).toEqual({
        agent: 'claude',
        label: 'Claude Code',
        binary: null,
        version: null,
        found: false,
        authState: 'unknown',
        capabilities: {},
        source: null,
        alternatives: [],
        searched: expect.any(Array) as string[],
      });
    });

    it.skipIf(darwinPathOnWin)(
      'codex / gemini pick the highest version among PATH entries only (no bundle lookup)',
      async () => {
        const m = machine();
        const oldCodex = m.add(m.local, 'codex', '0.40.0');
        const newCodex = m.add(m.brew, 'codex', '0.42.0');
        m.versions.set(oldCodex, 'codex-cli 0.40.0');
        m.versions.set(newCodex, 'codex-cli 0.42.0');
        mkdirSync(join(m.home, '.vscode', 'extensions', 'anthropic.claude-code-9.9.9-darwin-arm64', 'x'), {
          recursive: true,
        });
        bin(join(m.home, '.vscode', 'extensions', 'anthropic.claude-code-9.9.9-darwin-arm64', 'x'), 'codex');
        const svc = new DetectService(m.deps);
        const codex = (await svc.detectClis()).find((c) => c.agent === 'codex')!;
        expect(codex).toMatchObject({ binary: newCodex, version: '0.42.0', source: 'path' });
        expect(codex.alternatives.map((a) => a.binary)).toEqual([oldCodex, newCodex]);
      },
    );
  });

  describe('probe of a picked path (Locate binary)', () => {
    /** exec by file name: a good claude, a good codex, a file that does not run, everything else silent + failing. */
    function picker() {
      const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
      const apps = join(home, 'Applications');
      mkdirSync(join(apps, 'Claude.app', 'Contents', 'Resources'), { recursive: true });
      const deps: DetectDeps = {
        platform: 'darwin',
        home,
        pathEnv: join(home, 'bin'),
        env: { SHELL: '/bin/sh' },
        applicationsDir: apps,
        exec: async (b, args) => {
          if (args[0] === '--version') {
            if (/[\\/]broken$/.test(b)) return { stdout: 'zsh: exec format error', exitCode: 126 };
            if (/[\\/]codex$/.test(b)) return { stdout: 'codex-cli 0.42.0', exitCode: 0 };
            if (/[\\/]claude$/.test(b)) return { stdout: '2.1.263 (Claude Code)', exitCode: 0 };
            return { stdout: '', exitCode: 1 };
          }
          return { stdout: '--mcp-config', exitCode: 0 };
        },
      };
      mkdirSync(join(home, 'bin'));
      return { home, apps, deps, svc: new DetectService(deps) };
    }

    it('refuses a plain folder, a file that does not run, and another agent’s CLI, naming the reason', async () => {
      const { home, svc } = picker();
      const folder = join(home, 'stuff');
      mkdirSync(folder);
      expect(await svc.probe('claude', folder)).toMatchObject({
        found: false,
        problem: { kind: 'directory' },
      });
      const broken = bin(home, 'broken');
      expect(await svc.probe('claude', broken)).toMatchObject({
        found: false,
        binary: broken,
        problem: { kind: 'not-runnable' },
      });
      const codex = bin(home, 'codex');
      expect(await svc.probe('claude', codex)).toMatchObject({
        found: false,
        problem: { kind: 'other-agent', agent: 'codex' },
      });
      expect(await svc.probe('codex', codex)).toMatchObject({
        found: true,
        version: '0.42.0',
        source: 'manual',
      });
    });

    it('resolves an .app bundle (or a folder holding the CLI) to the executable inside it', async () => {
      const { home, apps, svc } = picker();
      const inner = bin(join(apps, 'Claude.app', 'Contents', 'Resources'), 'claude');
      expect(await svc.probe('claude', join(apps, 'Claude.app'))).toMatchObject({
        found: true,
        binary: inner,
        version: '2.1.263',
      });
      const local = join(home, '.claude', 'local');
      mkdirSync(local, { recursive: true });
      const wrapper = bin(local, 'claude');
      expect(await svc.probe('claude', local)).toMatchObject({ found: true, binary: wrapper });
    });

    it('a remembered pick that no longer runs is ignored and detection falls back to PATH', async () => {
      const { home, svc } = picker();
      const onPath = bin(join(home, 'bin'), 'claude');
      const broken = bin(home, 'broken');
      const claude = (await svc.detectClis({ claude: broken })).find((c) => c.agent === 'claude')!;
      expect(claude).toMatchObject({ binary: onPath, source: 'path', found: true });
    });
  });

  describe('detectIdes', () => {
    // The test host is a real Mac with editors installed: point the system lookups at the temp home.
    const ideDeps = (home: string, over: Partial<DetectDeps> = {}): DetectDeps => ({
      platform: 'darwin',
      home,
      pathEnv: '',
      env: {},
      applicationsDir: join(home, 'SystemApplications'),
      launcherDirs: [],
      exec: async () => ({ stdout: '', exitCode: 1 }),
      ...over,
    });

    it('a User folder VS Code has written to counts as installed even when the app bundle is not in /Applications', async () => {
      const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
      const user = join(home, 'Library', 'Application Support', 'Code', 'User');
      mkdirSync(join(user, 'globalStorage'), { recursive: true });
      writeFileSync(join(user, 'keybindings.json'), '[]');
      const vscode = (await new DetectService(ideDeps(home)).detectIdes()).find((i) => i.kind === 'vscode')!;
      expect(vscode).toMatchObject({
        found: true,
        product: 'VS Code',
        location: null,
        launcher: 'open -b com.microsoft.VSCode',
        configDir: user,
        imports: { keybindings: true },
      });
    });

    it('finds an app bundle anywhere through Spotlight, and Insiders when stable is absent', async () => {
      const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
      const elsewhere = join(home, 'Downloads', 'Visual Studio Code.app');
      mkdirSync(join(elsewhere, 'Contents', 'Resources', 'app'), { recursive: true });
      writeFileSync(join(elsewhere, 'Contents', 'Resources', 'app', 'package.json'), '{"version":"1.104.2"}');
      const spotlight = ideDeps(home, {
        exec: async (b, args) =>
          b === '/usr/bin/mdfind' && args[0]?.includes('com.microsoft.VSCode"')
            ? { stdout: `${elsewhere}\n`, exitCode: 0 }
            : { stdout: '', exitCode: 1 },
      });
      const vscode = (await new DetectService(spotlight).detectIdes()).find((i) => i.kind === 'vscode')!;
      expect(vscode).toMatchObject({
        found: true,
        location: elsewhere,
        version: '1.104.2',
        launcher: 'open -a "Visual Studio Code"',
      });

      const home2 = mkdtempSync(join(tmpdir(), 'styx-home-'));
      mkdirSync(join(home2, 'Applications', 'Visual Studio Code - Insiders.app', 'Contents'), {
        recursive: true,
      });
      const insiders = (await new DetectService(ideDeps(home2)).detectIdes()).find(
        (i) => i.kind === 'vscode',
      )!;
      expect(insiders).toMatchObject({
        found: true,
        product: 'VS Code Insiders',
        launcher: 'open -a "Visual Studio Code - Insiders"',
      });
    });

    it('a `code` shim in a launcher dir that is not on the app’s PATH still counts (Homebrew, /usr/local)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
      const brewBin = join(home, 'brew', 'bin');
      mkdirSync(brewBin, { recursive: true });
      const code = bin(brewBin, 'code');
      const deps = ideDeps(home, {
        launcherDirs: [brewBin],
        exec: async (b, args) =>
          b === code && args[0] === '--version'
            ? { stdout: '1.104.0\nabc', exitCode: 0 }
            : { stdout: '', exitCode: 1 },
      });
      const vscode = (await new DetectService(deps).detectIdes()).find((i) => i.kind === 'vscode')!;
      expect(vscode).toMatchObject({ found: true, launcher: code, version: '1.104.0', location: null });
    });

    it('Windows: a system-wide install under Program Files is found, with its bin\\code.cmd as launcher', async () => {
      const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
      const programFiles = join(home, 'Program Files');
      const install = join(programFiles, 'Microsoft VS Code');
      mkdirSync(join(install, 'resources', 'app'), { recursive: true });
      writeFileSync(join(install, 'resources', 'app', 'package.json'), '{"version":"1.104.0"}');
      mkdirSync(join(install, 'bin'));
      const launcher = bin(join(install, 'bin'), 'code.cmd');
      const deps = ideDeps(home, {
        platform: 'win32',
        programFilesDir: programFiles,
        env: { LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming') },
      });
      const vscode = (await new DetectService(deps).detectIdes()).find((i) => i.kind === 'vscode')!;
      expect(vscode).toMatchObject({ found: true, location: install, version: '1.104.0', launcher });
    });
  });

  it('detects IDEs without crashing on an empty machine: six rows in Onboarding order, none found', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const svc = new DetectService({
      platform: 'darwin',
      home,
      pathEnv: '',
      env: {},
      applicationsDir: join(home, 'Applications'),
      exec: async () => ({ stdout: '', exitCode: 1 }),
    });
    const ides = await svc.detectIdes();
    expect(ides.map((i) => i.kind)).toEqual([...IDE_KINDS]);
    expect(ides.map((i) => [i.found, i.launcher, i.version])).toEqual(
      IDE_KINDS.map(() => [false, null, null]),
    );
  });
});

describe('detectIdes on a fake machine', () => {
  describe.each(['darwin', 'win32', 'linux'] as const)('%s, every editor installed', (platform) => {
    const m = fakeIdeMachine(platform);
    const expected = installAll(m);
    let byKind = new Map<string, IdeDetection>();
    beforeAll(async () => {
      byKind = new Map((await new DetectService(m.deps).detectIdes()).map((i) => [i.kind, i]));
    });

    it.each(IDE_KINDS)('%s: found, product, version, launcher, configDir, imports', (kind) => {
      expect(byKind.get(kind)).toEqual({ kind, found: true, ...expected[kind] });
    });
  });

  it('macOS bundle without its CLI shim → `open -a` launcher; Windows install without the shim on PATH → bin\\<cli>.cmd / Zed.exe', async () => {
    const mac = fakeIdeMachine('darwin');
    installVscodeLike(mac, 'cursor', '1.7.28', { cli: false });
    installZed(mac, '0.201.6', { cli: false });
    const onMac = new Map((await new DetectService(mac.deps).detectIdes()).map((i) => [i.kind, i]));
    expect(onMac.get('cursor')).toMatchObject({
      found: true,
      version: '1.7.28',
      launcher: 'open -a "Cursor"',
    });
    expect(onMac.get('zed')).toMatchObject({ found: true, version: '0.201.6', launcher: 'open -a "Zed"' });
    expect(onMac.get('vscode')).toMatchObject({ found: false, launcher: null });

    const win = fakeIdeMachine('win32');
    const ws = installVscodeLike(win, 'windsurf', '1.12.5', { cli: false });
    const zed = installZed(win, '0.201.6', { cli: false });
    const onWin = new Map((await new DetectService(win.deps).detectIdes()).map((i) => [i.kind, i]));
    expect(onWin.get('windsurf')).toMatchObject({
      found: true,
      version: '1.12.5',
      launcher: join(ws.location ?? '', 'bin', 'windsurf.cmd'),
      configDir: join(win.appData, 'Windsurf', 'User'),
    });
    expect(onWin.get('zed')).toMatchObject({
      found: true,
      launcher: join(zed.location ?? '', 'Zed.exe'),
      version: null,
    });
  });

  it('linux: the CLI on PATH is the launcher and `--version` is the only version source', async () => {
    const m = fakeIdeMachine('linux');
    const code = m.onPath('code', '1.104.0\n0123abcd\nx64');
    const ides = new Map((await new DetectService(m.deps).detectIdes()).map((i) => [i.kind, i]));
    expect(ides.get('vscode')).toMatchObject({
      found: true,
      version: '1.104.0',
      launcher: code,
      location: null,
      configDir: null,
    });
    expect(ides.get('vscode')?.imports).toEqual({ recents: 0, keybindings: false, theme: false });
  });

  describe('JetBrains', () => {
    it('several IDEs installed → the first in preference order wins (WebStorm, IntelliJ IDEA, PyCharm…)', async () => {
      const m = fakeIdeMachine('darwin');
      installJetbrains(m, 'PyCharm', '2025.1.1', 'bundle');
      installJetbrains(m, 'IntelliJ IDEA', '2025.1.2', 'bundle');
      const ws = installJetbrains(m, 'WebStorm', '2025.1.3', 'bundle');
      const first = (await new DetectService(m.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(first).toMatchObject({
        found: true,
        product: 'JetBrains (WebStorm)',
        version: '2025.1.3',
        location: ws.root,
        launcher: 'open -a "WebStorm"',
      });

      const m2 = fakeIdeMachine('darwin');
      installJetbrains(m2, 'PyCharm', '2025.1.1', 'bundle');
      installJetbrains(m2, 'IntelliJ IDEA', '2025.1.2', 'toolbox');
      const second = (await new DetectService(m2.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(second).toMatchObject({
        product: 'JetBrains (IntelliJ IDEA)',
        version: '2025.1.2',
        launcher: 'open -a "IntelliJ IDEA"',
      });
    });

    it('macOS: a bundle in /Applications beats the same product under Toolbox', async () => {
      const m = fakeIdeMachine('darwin');
      installJetbrains(m, 'WebStorm', '2024.3.1', 'toolbox');
      const bundle = installJetbrains(m, 'WebStorm', '2025.1.3', 'bundle');
      const jb = (await new DetectService(m.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(jb).toMatchObject({
        version: '2025.1.3',
        location: bundle.root,
        launcher: 'open -a "WebStorm"',
      });
    });

    it('macOS: Toolbox only → the Toolbox bundle (version from its plist), launched by name', async () => {
      const m = fakeIdeMachine('darwin');
      const tb = installJetbrains(m, 'WebStorm', '2024.3.1', 'toolbox');
      const jb = (await new DetectService(m.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(jb).toMatchObject({
        found: true,
        version: '2024.3.1',
        location: tb.root,
        launcher: 'open -a "WebStorm"',
      });
    });

    it("Windows: Program Files beats the Toolbox copy; the launcher is the bundle's bin\\webstorm64.exe", async () => {
      const m = fakeIdeMachine('win32');
      m.deps.env['LOCALAPPDATA'] = join(FIX, 'jetbrains-win', 'LocalAppData'); // Toolbox 2024.3.1 (committed fixture)
      const pf = installJetbrains(m, 'WebStorm', '2025.1.3', 'bundle');
      const jb = (await new DetectService(m.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(jb).toMatchObject({ version: '2025.1.3', location: pf.root, launcher: pf.launcher });
      expect(pf.launcher.endsWith(join('bin', 'webstorm64.exe'))).toBe(true);
    });

    it('Windows: Toolbox only (committed fixture) → Toolbox exe, version from product-info.json, recents under %APPDATA%', async () => {
      const m = fakeIdeMachine('win32');
      m.deps.env['LOCALAPPDATA'] = join(FIX, 'jetbrains-win', 'LocalAppData');
      m.deps.env['APPDATA'] = join(FIX, 'jetbrains-win', 'AppData');
      const jb = (await new DetectService(m.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(jb).toEqual({
        kind: 'jetbrains',
        found: true,
        product: 'JetBrains (WebStorm)',
        version: '2024.3.1',
        location: join(
          FIX,
          'jetbrains-win',
          'LocalAppData',
          'JetBrains',
          'Toolbox',
          'apps',
          'WebStorm',
          'ch-0',
          '243.22562.13',
        ),
        launcher: join(
          FIX,
          'jetbrains-win',
          'LocalAppData',
          'JetBrains',
          'Toolbox',
          'apps',
          'WebStorm',
          'ch-0',
          '243.22562.13',
          'bin',
          'webstorm64.exe',
        ),
        configDir: null,
        imports: { recents: 2, keybindings: false, theme: false },
      });
    });

    it('Linux: the Toolbox script on PATH is preferred as launcher; version still comes from product-info.json', async () => {
      const m = fakeIdeMachine('linux');
      const tb = installJetbrains(m, 'WebStorm', '2025.1.3', 'toolbox');
      const script = m.onPath('webstorm', '');
      installJetbrainsRecents(m);
      const jb = (await new DetectService(m.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(jb).toMatchObject({
        found: true,
        version: '2025.1.3',
        location: tb.root,
        launcher: script,
        imports: { recents: 3 },
      });
    });

    it('a Toolbox apps dir holding only unknown products still counts as found, without a launcher', async () => {
      const m = fakeIdeMachine('darwin');
      mkdirSync(join(toolboxApps(m), 'DataGrip', 'ch-0'), { recursive: true });
      const jb = (await new DetectService(m.deps).detectIdes()).find((i) => i.kind === 'jetbrains');
      expect(jb).toMatchObject({
        found: true,
        product: 'JetBrains',
        version: null,
        launcher: null,
        location: toolboxApps(m),
      });
    });
  });
});

/**
 * Runs against this machine (VS Code is installed here: /Applications/Visual Studio Code.app + `code` on PATH).
 * Skipped unless STYX_LIVE=1 so CI and other machines are unaffected; the fake-machine tests above cover the rest.
 */
const live = process.env['STYX_LIVE'] === '1';
describe.skipIf(!live)('IDE detection on this machine (live)', () => {
  it('finds VS Code with a version, the `code` launcher, its User dir and recent folders', async () => {
    const ides = await new DetectService(defaultDeps()).detectIdes();
    const vscode = ides.find((i) => i.kind === 'vscode');
    const imports = new IdeImportService({ platform: process.platform, home: homedir(), env: process.env });
    const recents = vscode?.configDir
      ? imports.recentFolders({ kind: 'vscode', configDir: vscode.configDir })
      : [];
    console.log(
      JSON.stringify({ ides, vscodeRecents: recents.length, firstRecents: recents.slice(0, 3) }, null, 2),
    );
    expect(vscode).toMatchObject({ found: true, product: 'VS Code' });
    expect(vscode?.version).toMatch(/^\d+\.\d+/);
    expect(vscode?.launcher).toMatch(/(^|\/)code$/);
    expect(vscode?.configDir).toMatch(/Library\/Application Support\/Code\/User$/);
    expect(recents.length).toBeGreaterThan(0);
  }, 60_000);
});
