import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHIM_TOOLS, writeShims } from './shim-service';

describe('writeShims', () => {
  it.each([
    ['darwin', ''],
    ['win32', '.cmd'],
  ] as const)('%s: writes styx and one shim per provider tool, nothing else', (platform, ext) => {
    const userData = mkdtempSync(join(tmpdir(), 'styx-shims-'));
    const { dir, styx } = writeShims(userData, platform);
    expect(styx).toBe(join(dir, `styx${ext}`));
    expect(readdirSync(dir).sort()).toEqual(['styx', ...SHIM_TOOLS].map((t) => `${t}${ext}`).sort());
  });

  it.each([
    ['darwin', 'git-credential-styx'],
    ['win32', 'git-credential-styx.cmd'],
  ] as const)('%s: removes the git-credential-styx left by earlier versions (issue 13)', (platform, file) => {
    const userData = mkdtempSync(join(tmpdir(), 'styx-shims-'));
    mkdirSync(join(userData, 'bin'));
    writeFileSync(join(userData, 'bin', file), 'old');
    const { dir } = writeShims(userData, platform);
    expect(existsSync(join(dir, file))).toBe(false);
  });
});
