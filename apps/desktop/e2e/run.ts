/**
 * Playwright launcher for the e2e / visual / a11y projects.
 *
 * pnpm ≥ 7 forwards a literal `--` to the script, and commander treats it as end-of-options, so
 * `pnpm e2e -- --grep a11y` would otherwise run every test. Drop the `--`, strip ELECTRON_RUN_AS_NODE (set by
 * VS Code extension hosts, which would boot Electron as plain Node) and exec Playwright's CLI in-process.
 *
 *   node --experimental-strip-types e2e/run.ts --project e2e [-- --grep a11y]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const args = process.argv.slice(2).filter((a) => a !== '--');
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;

const result = spawnSync(process.execPath, [cli, 'test', '-c', join(here, 'playwright.config.ts'), ...args], {
  stdio: 'inherit',
  env,
  cwd: join(here, '..'),
});
process.exit(result.status ?? 1);
