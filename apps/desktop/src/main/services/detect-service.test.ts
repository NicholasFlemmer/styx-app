import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  DetectService,
  findAllOnPath,
  findOnPath,
  parseVersion,
  pickBest,
  toCliInstall,
  versionSatisfies,
  type DetectDeps,
} from './detect-service';

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
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    const deps: DetectDeps = {
      platform: 'darwin',
      home,
      pathEnv: dir,
      env: { SHELL: '/bin/sh' },
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

    it('the highest version wins across PATH, VS Code and Cursor bundles; every candidate is listed', async () => {
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
    });

    it('a manual override wins while it exists and is listed first among the alternatives', async () => {
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
    });

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
      });
    });

    it('codex / gemini pick the highest version among PATH entries only (no bundle lookup)', async () => {
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
    });
  });

  it('detects IDEs without crashing on an empty machine', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const svc = new DetectService({
      platform: 'darwin',
      home,
      pathEnv: '',
      env: {},
      exec: async () => ({ stdout: '', exitCode: 1 }),
    });
    const ides = await svc.detectIdes();
    expect(ides.map((i) => i.kind)).toEqual(['vscode', 'cursor', 'jetbrains', 'neovim']);
    expect(ides.find((i) => i.kind === 'neovim')?.found).toBe(false);
  });
});
