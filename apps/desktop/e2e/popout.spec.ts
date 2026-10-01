import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { launchStyx } from './launch';
import { comparePng, type Rect } from './visual/compare';

/**
 * Pop-out chat window (roadmap 12-03, spec §4.13). ⤢ in the chat pane opens `index.html?popout=<sessionId>` as a
 * real 400×500 BrowserWindow with the compact chat; Mod+Shift+O inside it docks (window closes, main chat returns).
 *
 * Fidelity: the prototype draws the pop-out inside its 1280×800 frame at right:48 bottom:40 as a 400×500 border-box
 * with a 1px --tx frame, so the visual harness cannot diff the `popout` state 1:1. Here the pop-out window's own
 * screenshot is compared against the crop inside that frame: 398×498 of content (an OS window has no drawn border),
 * so right/bottom-anchored chrome (Dock, composer) lines up pixel for pixel.
 */
const POPOUT = { width: 400, height: 500 } as const;
const FRAME = 1;
/** Content inside the prototype's frame; the window is sized to this for the screenshot. */
const INNER = { width: POPOUT.width - 2 * FRAME, height: POPOUT.height - 2 * FRAME } as const;
const CROP: Rect = { x: 1280 - 48 - POPOUT.width + FRAME, y: 800 - 40 - POPOUT.height + FRAME, ...INNER };
const BASELINE_DIR = join(__dirname, 'visual', '__baseline__');
const TITLEBAR_H = 32;

/** Masked on both sides: the mac traffic-light area (native lights in the app, three 10px dots in the prototype). */
const MASKS: readonly Rect[] = [{ x: 0, y: 0, width: 64, height: TITLEBAR_H }];

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function cropBaseline(file: string, outPath: string): void {
  const src = PNG.sync.read(readFileSync(join(BASELINE_DIR, file)));
  const out = new PNG({ width: CROP.width, height: CROP.height });
  PNG.bitblt(src, out, CROP.x, CROP.y, CROP.width, CROP.height, 0, 0);
  writeFileSync(outPath, PNG.sync.write(out));
}

async function popOut(app: ElectronApplication, page: Page): Promise<Page> {
  await expect(page.locator('[data-screen-ready="workspace"]')).toBeAttached({ timeout: 20_000 });
  const opened = app.waitForEvent('window', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Pop out chat' }).click();
  const popout = await opened;
  await popout.waitForLoadState('domcontentloaded');
  expect(popout.url()).toMatch(/[?&]popout=/);
  await expect(popout.locator('[data-screen-ready="popout"]')).toBeAttached({ timeout: 20_000 });
  return popout;
}

async function sizePopout(
  app: ElectronApplication,
  popout: Page,
  size: { width: number; height: number },
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout='));
    if (!win) throw new Error('no pop-out BrowserWindow');
    win.setContentSize(s.width, s.height);
  }, size);
  await popout.waitForFunction(
    (s) => window.innerWidth === s.width && window.innerHeight === s.height,
    size,
    { timeout: 5_000 },
  );
}

test('⤢ opens a pop-out window with the compact chat; Mod+Shift+O docks it', async () => {
  const { app, page } = await launchStyx({
    screen: 'workspace',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  try {
    const popout = await popOut(app, page);
    // Spec §4.13 default: 400×500.
    expect(await popout.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([
      POPOUT.width,
      POPOUT.height,
    ]);

    // Compact chat: no session tabs, no meta line, live composer for the popped-out session.
    const chat = popout.locator('[data-chat-compact="true"]');
    await expect(chat).toBeVisible();
    await expect(popout.getByRole('tab')).toHaveCount(0);
    await expect(popout.locator('[data-lane-meta]')).toHaveCount(0);
    await expect(popout.getByText('Add input validation to checkout and cover it with tests.')).toBeVisible();
    const composer = popout.getByPlaceholder('Message Claude…');
    await expect(composer).toBeEnabled();

    // Own titlebar: agent 600, project · branch mono, Dock.
    const titlebar = popout.getByRole('banner');
    await expect(titlebar.getByText('Claude', { exact: true })).toBeVisible();
    await expect(titlebar.getByText('acme-shop · fix/checkout')).toBeVisible();
    await expect(titlebar.getByRole('button', { name: 'Dock' })).toBeVisible();

    // Main window shows the "Popped out" state with a Dock button and a disabled composer.
    const pane = page.locator('[data-chat-pane]');
    await expect(pane.getByText('Popped out')).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Dock' })).toBeVisible();
    await expect(page.getByPlaceholder('Message Claude…')).toBeDisabled();

    // No palette in the pop-out; Esc does nothing.
    await composer.focus();
    await popout.keyboard.press(`${MOD}+KeyK`);
    await expect(popout.getByRole('combobox')).toHaveCount(0);
    await popout.keyboard.press('Escape');
    await expect(chat).toBeVisible();

    // Mod+Shift+O inside the pop-out docks: the window closes and the main chat comes back.
    const closed = popout.waitForEvent('close', { timeout: 10_000 });
    // Dock fires on keydown and the window closes before keyup lands: the press itself may reject.
    await Promise.all([closed, popout.keyboard.press(`${MOD}+Shift+KeyO`).catch(() => undefined)]);
    expect(app.windows()).toHaveLength(1);
    await expect(pane.getByText('Popped out')).toHaveCount(0);
    await expect(page.getByPlaceholder('Message Claude…')).toBeEnabled();
    await expect(page.locator('[data-lane-header]')).toContainText('Claude');
  } finally {
    await app.close();
  }
});

for (const theme of ['dark', 'light'] as const) {
  test(`pop-out window matches its reference · ${theme} · mac`, async () => {
    const file = `popout-${theme}-mac.png`;
    const { app, page } = await launchStyx({
      screen: 'workspace',
      theme,
      chrome: 'mac',
      env: { STYX_DEMO_REPOS: '0' },
    });
    try {
      const popout = await popOut(app, page);
      await sizePopout(app, popout, INNER);
      await popout.evaluate(async () => {
        await Promise.all([
          document.fonts.load('600 13px Archivo'),
          document.fonts.load('12px "JetBrains Mono"'),
        ]);
      });
      await popout.mouse.move(0, 0);
      await popout.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

      const actualPath = test.info().outputPath(file);
      const diffPath = test.info().outputPath(file.replace(/\.png$/, '-diff.png'));
      await popout.screenshot({ path: actualPath, scale: 'css', animations: 'disabled', caret: 'hide' });
      // ADR-0027: the app's own reference when there is one, else the prototype crop (kept as history).
      const appRef = join(__dirname, 'visual', '__baseline__', 'app', file);
      if (process.env['STYX_VISUAL_UPDATE'] === '1') {
        mkdirSync(dirname(appRef), { recursive: true });
        copyFileSync(actualPath, appRef);
      }
      const baselinePath = existsSync(appRef) ? appRef : test.info().outputPath(`baseline-crop-${file}`);
      if (!existsSync(appRef)) cropBaseline(file, baselinePath);

      // Full-window ratio (reported): the prototype's pop-out shows an abridged conversation ("Plan: … Proceeding.")
      // that the demo fixture does not contain, so the transcript body can never match pixel for pixel.
      const full = comparePng(actualPath, baselinePath, diffPath, { threshold: 0.1, masks: MASKS });
      // Chrome ratio (asserted): titlebar + composer, with the transcript body masked on both sides.
      const log = await popout.locator('[role="log"]').boundingBox();
      if (log === null) throw new Error('transcript not rendered');
      const chrome = comparePng(
        actualPath,
        baselinePath,
        diffPath.replace(/-diff\.png$/, '-chrome-diff.png'),
        {
          threshold: 0.1,
          maxDiffRatio: 0.002,
          masks: [...MASKS, { x: log.x, y: log.y, width: log.width, height: log.height }],
        },
      );
      test
        .info()
        .annotations.push(
          { type: 'diffRatio', description: full.diffRatio.toFixed(5) },
          { type: 'diffRatioChrome', description: chrome.diffRatio.toFixed(5) },
        );
      console.log(
        `[popout] ${file}: full ${full.diffPixels} px (${(full.diffRatio * 100).toFixed(3)} %) · ` +
          `chrome (transcript masked) ${chrome.diffPixels} px (${(chrome.diffRatio * 100).toFixed(3)} %)`,
      );
      if (full.sizeMismatch) {
        expect(full.sizeMismatch.actual, 'screenshot size').toEqual(full.sizeMismatch.baseline);
      }
      expect(
        chrome.diffRatio,
        `${file}: ${chrome.diffPixels} px differ outside the transcript (${(chrome.diffRatio * 100).toFixed(3)} %) — see ${diffPath}`,
      ).toBeLessThanOrEqual(0.002);
    } finally {
      await app.close();
    }
  });
}
