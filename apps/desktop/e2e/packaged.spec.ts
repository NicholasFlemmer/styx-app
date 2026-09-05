import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_NOW } from './launch';

/** Boots the packaged app (release/mac-arm64/Styx.app) when it exists — `pnpm package:mac -- --dir` then `pnpm e2e -- --grep packaged`. */
const EXE = resolve(__dirname, '../release/mac-arm64/Styx.app/Contents/MacOS/Styx');

test.describe('packaged app', () => {
  test.skip(process.platform !== 'darwin' || !existsSync(EXE), 'no packaged macOS build in release/');

  test('boots to a ready screen with the demo fixture', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
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
    await app.close();
  });
});
