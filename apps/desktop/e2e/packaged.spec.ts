import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_NOW } from './launch';

/**
 * Boots the packaged app when it exists: `pnpm package:mac:dir` (release/mac-arm64/Styx.app) or `pnpm package:win:dir`
 * (release/win-unpacked/Styx.exe), then `pnpm package:smoke`.
 */
const WIN = process.platform === 'win32';
const EXE = WIN
  ? resolve(__dirname, '../release/win-unpacked/Styx.exe')
  : resolve(__dirname, `../release/mac-${process.arch}/Styx.app/Contents/MacOS/Styx`);
/** Where electron-builder puts `resources/` next to the binary. */
const RESOURCES = WIN ? resolve(EXE, '../resources') : resolve(EXE, '../../Resources');

test.describe('packaged app', () => {
  test.skip(
    (process.platform !== 'darwin' && !WIN) || !existsSync(EXE),
    'no packaged build for this platform in release/',
  );

  test('boots to a ready screen with the demo fixture', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const app = await electron.launch({
      executablePath: EXE,
      args: ['--force-device-scale-factor=1'],
      env: {
        ...env,
        STYX_USER_DATA: mkdtempSync(join(tmpdir(), 'styx-pkg-')),
        STYX_FIXTURE: 'demo',
        STYX_KEYCHAIN: 'memory',
        STYX_E2E: '1',
        STYX_DEMO_REPOS: '0',
        STYX_NOW: String(DEMO_NOW),
      },
      timeout: 60_000,
    });
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('Styx');
    await page.waitForSelector('[data-screen-ready]', { timeout: 20_000 });
    await expect(page.getByText('02 needs you')).toBeVisible();
    // The agent shims and `styx mcp` exec `<exe> <cliPath>` as Node: the CLI must be a real (asar-unpacked) file that
    // loads under the packaged binary. Regression guard for the 2026-09-07 wrong-path bug.
    const resources = join(RESOURCES, 'app.asar.unpacked', 'resources');
    const cliPath = join(resources, 'cli', 'styx.js');
    let help = '';
    try {
      help = execFileSync(EXE, [cliPath, '--help'], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 20_000,
      });
    } catch (e) {
      help = `ERR ${(e as { stderr?: string; message: string }).stderr ?? (e as Error).message}`;
    }
    const cli = {
      exists: existsSync(cliPath),
      templates: existsSync(join(resources, 'templates', 'node')),
      help,
    };
    expect(cli.exists).toBe(true);
    expect(cli.templates).toBe(true);
    // Usage goes to stderr with a non-zero exit; only a module-resolution failure means the path is wrong.
    expect(cli.help).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/);
    expect(cli.help).toMatch(/Styx session CLI/);
    await app.close();
  });
});
