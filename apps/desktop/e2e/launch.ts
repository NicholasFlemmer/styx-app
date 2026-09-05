import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Matches `fixtures.DEMO_NOW` in @styx/core (2026-03-12 09:43 UTC) so demo ages render 2m/3m/9m. */
export const DEMO_NOW = Date.UTC(2026, 2, 12, 9, 43, 0);

export interface LaunchOptions {
  fixture?: string;
  screen?: string;
  now?: number;
  theme?: 'dark' | 'light';
  chrome?: 'mac' | 'win';
  env?: Record<string, string>;
}

/** Drops ELECTRON_RUN_AS_NODE (set by VS Code extension hosts) so Electron boots as an app, not as Node. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  return env;
}

/** Launches the built app (out/) with an isolated userData dir and deterministic env. Run `pnpm build` first. */
export async function launchStyx(
  opts: LaunchOptions = {},
): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = mkdtempSync(join(tmpdir(), 'styx-e2e-'));
  const app = await electron.launch({
    args: [
      resolve(__dirname, '../out/main/index.js'),
      `--user-data-dir=${userData}`,
      // Visual baselines are baked at DPR 1. Chromium rounds font ascent/descent in device pixels, so at DPR 2 every
      // `line-height: normal` box drifts by 0.5px and downsampled screenshots never match; pin the scale factor instead.
      '--force-device-scale-factor=1',
    ],
    env: {
      ...cleanEnv(),
      NODE_ENV: 'test',
      STYX_E2E: '1',
      STYX_USER_DATA: userData,
      STYX_FIXTURE: opts.fixture ?? 'demo',
      STYX_KEYCHAIN: 'memory',
      STYX_NOW: String(opts.now ?? DEMO_NOW),
      ...(opts.screen ? { STYX_SCREEN: opts.screen } : {}),
      ...(opts.theme ? { STYX_THEME: opts.theme } : {}),
      ...(opts.chrome ? { STYX_CHROME: opts.chrome } : {}),
      ...opts.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}
