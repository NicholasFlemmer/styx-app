import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('built session CLI', () => {
  it('runs the CommonJS bundle inside its ESM package', () => {
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    const env = { ...process.env };
    delete env['VITEST'];
    const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd, env, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    const run = spawnSync(process.execPath, ['dist/styx.js'], { cwd, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(64);
    expect(run.stderr).toContain('Styx session CLI');
  }, 20_000);
});
