/**
 * Visual fidelity: the built app vs. baselines baked from the prototype (`pnpm visual:baseline`).
 *
 *   pnpm visual                          # compare every __baseline__/<state>-<theme>-<chrome>.png
 *   STYX_VISUAL_UPDATE=1 pnpm visual     # also copy actuals to __baseline__/app/ (prototype baselines are never touched)
 *   pnpm visual:report                   # per-state diff ratios from the last run
 *
 * The renderer signals that a state is painted by setting `[data-screen-ready]` (value: the state name) on any element.
 * States the app cannot render yet are skipped, not failed.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchStyx } from '../launch';
import { comparePng, type CompareResult, type Rect } from './compare';
import { WINDOW, parseBaselineName, type VisualChrome } from './states';

const BASELINE_DIR = join(__dirname, '__baseline__');
const APP_BASELINE_DIR = join(BASELINE_DIR, 'app');
const RESULTS_DIR = join(__dirname, '../test-results/visual');
const RESULTS_FILE = join(RESULTS_DIR, 'results.ndjson');
const UPDATE = process.env['STYX_VISUAL_UPDATE'] === '1';
const READY_TIMEOUT = 5_000;

/** Native chrome that the app draws via the OS: mac traffic lights, win caption buttons. Masked on both sides. */
const NATIVE_CHROME: Record<VisualChrome, Rect[]> = {
  mac: [{ x: 0, y: 0, width: 70, height: 38 }],
  win: [{ x: WINDOW.width - 138, y: 0, width: 138, height: 38 }],
};

export interface VisualRecord {
  file: string;
  state: string;
  theme: string;
  chrome: string;
  status: 'pass' | 'fail' | 'skip' | 'updated';
  diffRatio?: number;
  diffPixels?: number;
  reason?: string;
}

function record(r: VisualRecord): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(RESULTS_FILE, JSON.stringify(r) + '\n');
}

const baselines = existsSync(BASELINE_DIR)
  ? readdirSync(BASELINE_DIR)
      .filter((f) => f.endsWith('.png'))
      .map((file) => ({ file, ...parseBaselineName(file) }))
      .filter(
        (b): b is { file: string; state: string; theme: 'dark' | 'light'; chrome: VisualChrome } =>
          b.state !== undefined,
      )
  : [];

async function sizeWindow(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no BrowserWindow');
    win.setContentSize(size.width, size.height);
  }, WINDOW);
  await page.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    WINDOW,
    { timeout: 5_000 },
  );
}

/** Resolves true when the renderer has painted a screen, false when it has not within `timeout`. */
async function waitForReady(page: Page, timeout: number): Promise<boolean> {
  return page
    .locator('[data-screen-ready]')
    .first()
    .waitFor({ state: 'attached', timeout })
    .then(() => true)
    .catch(() => false);
}

let appRendersScreens = false;

test.describe('visual fidelity vs prototype', () => {
  test.beforeAll(async () => {
    rmSync(RESULTS_FILE, { force: true });
    if (baselines.length === 0) return;
    // Fast path: if a plain launch never reports a ready screen, every state is skipped without a launch each.
    const { app, page } = await launchStyx();
    try {
      appRendersScreens = await waitForReady(page, READY_TIMEOUT);
    } finally {
      await app.close();
    }
  });

  test('has baselines', () => {
    expect(baselines.length, `no baselines in ${BASELINE_DIR}; run pnpm visual:baseline`).toBeGreaterThan(0);
  });

  for (const b of baselines) {
    test(`${b.state} · ${b.theme} · ${b.chrome}`, async () => {
      const base = { file: b.file, state: b.state, theme: b.theme, chrome: b.chrome } as const;
      if (!appRendersScreens) {
        record({ ...base, status: 'skip', reason: 'renderer does not set [data-screen-ready]' });
        test.skip(true, 'renderer does not set [data-screen-ready] yet');
      }

      const fixture = b.state.endsWith('-empty') ? 'empty' : b.state.endsWith('-error') ? 'error' : 'demo';
      const { app, page } = await launchStyx({ screen: b.state, theme: b.theme, chrome: b.chrome, fixture });
      try {
        await sizeWindow(app, page);
        const ready = await waitForReady(page, READY_TIMEOUT);
        if (!ready) {
          record({
            ...base,
            status: 'skip',
            reason: `no [data-screen-ready] for "${b.state}" within ${READY_TIMEOUT}ms`,
          });
          test.skip(true, `renderer has no "${b.state}" screen yet`);
        }
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, 0);

        mkdirSync(RESULTS_DIR, { recursive: true });
        const actualPath = join(RESULTS_DIR, b.file);
        await page.screenshot({ path: actualPath, scale: 'css', animations: 'disabled', caret: 'hide' });

        const result: CompareResult = comparePng(
          actualPath,
          join(BASELINE_DIR, b.file),
          join(RESULTS_DIR, b.file.replace(/\.png$/, '-diff.png')),
          {
            threshold: 0.1,
            maxDiffRatio: 0.002,
            masks: NATIVE_CHROME[b.chrome],
          },
        );
        test.info().annotations.push({ type: 'diffRatio', description: result.diffRatio.toFixed(5) });

        if (UPDATE) {
          mkdirSync(APP_BASELINE_DIR, { recursive: true });
          copyFileSync(actualPath, join(APP_BASELINE_DIR, b.file));
          record({ ...base, status: 'updated', diffRatio: result.diffRatio, diffPixels: result.diffPixels });
          return;
        }

        record({
          ...base,
          status: result.pass ? 'pass' : 'fail',
          diffRatio: result.diffRatio,
          diffPixels: result.diffPixels,
        });
        if (result.sizeMismatch) {
          expect.soft(result.sizeMismatch.actual, 'screenshot size').toEqual(result.sizeMismatch.baseline);
        }
        expect(
          result.diffRatio,
          `${b.file}: ${result.diffPixels} px differ (${(result.diffRatio * 100).toFixed(3)} %) — see ${RESULTS_DIR}`,
        ).toBeLessThanOrEqual(0.002);
      } finally {
        await app.close();
      }
    });
  }
});
