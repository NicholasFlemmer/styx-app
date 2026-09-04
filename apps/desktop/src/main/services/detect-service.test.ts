import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetectService, findOnPath, parseVersion, type DetectDeps } from './detect-service';

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
        if (args[0] === '--version') return { stdout: b.endsWith('claude') ? 'claude 2.4.1' : b.endsWith('gemini') ? 'gemini 1.2.0' : 'sh 3.2', exitCode: 0 };
        if (args[0] === '--help') return { stdout: b.endsWith('claude') ? 'usage: --mcp-config <f> --settings <f> --output-format stream-json -p' : 'usage', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      },
    };
    const svc = new DetectService(deps);
    const clis = await svc.detectClis();
    const byAgent = Object.fromEntries(clis.map((c) => [c.agent, c]));
    expect(byAgent['claude']).toMatchObject({ found: true, version: '2.4.1', authState: 'signed-in', capabilities: { mcpConfigFlag: true, settingsFlag: true, streamJson: true, printMode: true } });
    expect(byAgent['gemini']).toMatchObject({ found: true, version: '1.2.0', authState: 'signed-out' });
    expect(byAgent['codex']).toMatchObject({ found: false, binary: null });
    expect(byAgent['shell']).toMatchObject({ found: true, authState: 'n/a', version: 'sh 3.2' });
    expect(findOnPath('missing', dir, 'darwin')).toBeNull();
  });

  it('detects IDEs without crashing on an empty machine', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const svc = new DetectService({ platform: 'darwin', home, pathEnv: '', env: {}, exec: async () => ({ stdout: '', exitCode: 1 }) });
    const ides = await svc.detectIdes();
    expect(ides.map((i) => i.kind)).toEqual(['vscode', 'cursor', 'jetbrains', 'neovim']);
    expect(ides.find((i) => i.kind === 'neovim')?.found).toBe(false);
  });
});
