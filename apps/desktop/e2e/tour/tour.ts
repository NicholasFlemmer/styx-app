/**
 * The product tour: generic scenarios that walk the demo fixture to named states ("the access sheet is open", "the
 * Grant button is pressed"). They run in the normal e2e suite, where each `reach` is an assertion, so a UI change that
 * breaks a scenario fails CI in the same pull request.
 *
 * Capture mode: with STYX_TOUR_CAPTURE=<dir>, the window runs at device scale 2 and every `reach` also saves the state:
 * <dir>/<scenario>/<state>.png (the element alone), <state>.window.png (the whole window) and <state>.json (the
 * element's box, its parts' boxes, fills and text, and the window's size, in CSS px). Tools outside this repo's app code (docs, media) build on these.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launchStyx, type LaunchOptions } from '../launch';

export const CAPTURE_DIR = process.env['STYX_TOUR_CAPTURE'];
export const STATE_TIMEOUT = process.env['CI'] ? 30_000 : 15_000;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Tour {
  app: ElectronApplication;
  page: Page;
  /** Asserts the state is on screen; in capture mode also saves it. `parts` are boxes worth knowing inside it. */
  reach: (state: string, target: Locator, parts?: Record<string, Locator>) => Promise<void>;
  close: () => Promise<void>;
}

/** Launches the built app over the demo fixture for a scenario. */
export async function startTour(scenario: string, opts: LaunchOptions = {}): Promise<Tour> {
  const capture = CAPTURE_DIR ? join(CAPTURE_DIR, scenario) : undefined;
  if (capture) mkdirSync(capture, { recursive: true });
  const { app, page } = await launchStyx({
    theme: 'dark',
    chrome: 'mac',
    ...opts,
    env: { STYX_MFA: 'auto', STYX_DEMO_REPOS: '0', ...opts.env },
    ...(capture ? { scaleFactor: 2, logFile: join(capture, 'electron.log') } : {}),
  });
  const boxOf = async (l: Locator): Promise<Box | null> => {
    const b = await l.boundingBox();
    return b
      ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
      : null;
  };
  return {
    app,
    page,
    reach: async (state, target, parts = {}) => {
      await expect(target, `tour ${scenario}: state "${state}"`).toBeVisible({ timeout: STATE_TIMEOUT });
      if (!capture) return;
      // Let entry motion (sheets slide in 160 ms, modals fade 120 ms) settle before the picture.
      await page.waitForTimeout(260);
      const box = await boxOf(target);
      const partBoxes: Record<string, Box | null> = {};
      const partFill: Record<string, string> = {};
      const partText: Record<string, string> = {};
      for (const [name, l] of Object.entries(parts)) {
        partBoxes[name] = await boxOf(l);
        // The part's own background (the first opaque one up its ancestors), for anyone drawing over it.
        partFill[name] = await l.evaluate((el) => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
          }
          return 'rgb(0, 0, 0)';
        });
        // What the part says, as on screen (a row's cells come one per line).
        partText[name] = (await l.innerText()).trim();
      }
      await target.screenshot({ path: join(capture, `${state}.png`), animations: 'disabled' });
      await page.screenshot({ path: join(capture, `${state}.window.png`), animations: 'disabled' });
      const size =
        page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
      writeFileSync(
        join(capture, `${state}.json`),
        `${JSON.stringify({ state, box, parts: partBoxes, fills: partFill, texts: partText, window: size }, null, 2)}\n`,
      );
    },
    close: () => app.close(),
  };
}

type StyxWindow = Window & { styx: { command: (name: string, input: unknown) => Promise<unknown> } };

// ── Steps: small moves over the demo fixture, shared by the scenarios ──────────────────────────────────────────────

export const steps = {
  workspaceReady: (page: Page) =>
    page.locator('[data-screen-ready="workspace"]').waitFor({ state: 'attached', timeout: STATE_TIMEOUT }),
  homeReady: (page: Page) =>
    page.locator('[data-screen-ready="home"]').waitFor({ state: 'attached', timeout: STATE_TIMEOUT }),
  /** The demo names agent binaries this machine lacks: re-detect so the fake CLIs on PATH take over. */
  detectClis: (page: Page) =>
    page.evaluate(() => (window as unknown as StyxWindow).styx.command('detect.clis', {})),
  /** A task card on the Tasks board, by words in it. */
  card: (page: Page, text: string) => page.locator('[data-tasks-card]').filter({ hasText: text }),
  board: (page: Page) => page.getByRole('region', { name: 'Tasks in this project' }),
  addBox: (page: Page) => page.locator('[data-tasks-add]'),
  /** Fold the terminal under the board (⏎ on its handle). */
  foldTerminal: async (page: Page) => {
    const handle = page.getByRole('separator', { name: 'Terminal' });
    await handle.focus();
    await page.keyboard.press('Enter');
    await handle.blur();
  },
  /** Type a build task into the board's box, for an agent (not started yet). */
  fillTask: async (page: Page, text: string, agent: string) => {
    const add = steps.addBox(page);
    await add.locator('[data-tasks-add-kind="build"]').click();
    await add.locator('select').selectOption(agent);
    // The previous Start clears the box when its spawn resolves, which can land after the next card appears: type until
    // the words stay.
    const box = add.locator('[data-tasks-add-text]');
    await expect
      .poll(async () => {
        await box.fill(text);
        await page.waitForTimeout(250);
        return box.inputValue();
      })
      .toBe(text);
  },
  /** Press Start on the filled box; resolves when the task's card is on the board. */
  pressStart: async (page: Page, text: string) => {
    const add = steps.addBox(page);
    const go = add.locator('[data-tasks-add-start]');
    const box = add.locator('[data-tasks-add-text]');
    // Start is disabled while the previous spawn runs and when the box is empty. On a slow machine that spawn can
    // resolve (and clear the box) after the words were typed, so put them back until Start can be pressed.
    await expect
      .poll(
        async () => {
          if ((await box.inputValue()) !== text) await box.fill(text);
          if (await go.isDisabled()) await steps.detectClis(page);
          return go.isEnabled();
        },
        { timeout: STATE_TIMEOUT, intervals: [300] },
      )
      .toBe(true);
    await go.click();
    await expect(steps.card(page, text)).toBeVisible({ timeout: STATE_TIMEOUT });
    // Let this spawn clear the box before anything types the next task into it.
    await expect(box).toHaveValue('', { timeout: STATE_TIMEOUT });
  },
  /** Start a build task from the board on an agent; resolves when its card is on the board. */
  startTask: async (page: Page, text: string, agent: string) => {
    await steps.fillTask(page, text, agent);
    await steps.pressStart(page, text);
  },
  /** Open the access request waiting on a task (the demo's Codex task asks for Supabase prod). */
  openRequest: async (page: Page, cardText: string) => {
    await steps.card(page, cardText).click();
    const review = page.getByRole('button', { name: /^review request$/i });
    await review.click();
    return page.getByRole('dialog', { name: /supabase/i });
  },
  palette: (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('combobox') }),
  openPalette: async (page: Page) => {
    await page.keyboard.press(process.platform === 'darwin' ? 'ControlOrMeta+K' : 'Control+K');
    await page.getByRole('dialog').getByRole('combobox').waitFor();
  },
  /** Answers "Later" on any needs-you toasts, so they don't sit over a picture. */
  quietToasts: async (page: Page) => {
    const later = page.locator('[data-toast="needs-you"] button').filter({ hasText: 'Later' });
    for (let i = 0; i < 4 && (await later.count()) > 0; i++) await later.first().click();
  },
  /**
   * Holds a button down while `during` runs (a capture of its pressed look), then lets go off the button, so the
   * click never fires and nothing changes.
   */
  pressHold: async (page: Page, target: Locator, during: () => Promise<void>) => {
    const b = await target.boundingBox();
    if (!b) throw new Error('pressHold: target not on screen');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await during();
    await page.mouse.move(2, 2);
    await page.mouse.up();
  },
  /** Moves the pointer out of the way, so no hover state shows in a picture. */
  restPointer: (page: Page) => page.mouse.move(2, 2),
};
