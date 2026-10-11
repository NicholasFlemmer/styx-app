/**
 * Tour: the agent dock. A small always-on-top window lists every agent across projects, the ones that need you first;
 * clicking one brings the main window forward on that agent's chat.
 *
 * The dock is its own window, so its states are saved here in the same shape `reach` uses for the main window (the
 * element alone, the whole dock window, and a JSON of boxes, fills and text in the dock's own CSS px). Boxes are
 * clipped to the window: the dock's content can lay out wider than its 300px window.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CAPTURE_DIR, startTour, steps, type Box } from './tour';

const SCENARIO = 'dock';

/** The locator's box, within the window's own 0, 0, width, height. */
const boxIn = async (l: Locator, win: { width: number; height: number }): Promise<Box | null> => {
  const b = await l.boundingBox();
  if (!b) return null;
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return {
    x,
    y,
    width: Math.min(Math.round(b.x + b.width), win.width) - x,
    height: Math.min(Math.round(b.y + b.height), win.height) - y,
  };
};

/** `reach` for the dock window: asserts the state, and in capture mode saves it beside the main window's states. */
async function reachDock(dock: Page, state: string, target: Locator, parts: Record<string, Locator> = {}) {
  await expect(target, `tour ${SCENARIO}: state "${state}"`).toBeVisible();
  if (!CAPTURE_DIR) return;
  const dir = join(CAPTURE_DIR, SCENARIO);
  await dock.waitForTimeout(260);
  const size = await dock.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const box = await boxIn(target, size);
  if (!box) throw new Error(`tour ${SCENARIO}: state "${state}" has no box`);
  const partBoxes: Record<string, Box | null> = {};
  const fills: Record<string, string> = {};
  const texts: Record<string, string> = {};
  for (const [name, l] of Object.entries(parts)) {
    partBoxes[name] = await boxIn(l, size);
    fills[name] = await l.evaluate((el) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
      }
      return 'rgb(0, 0, 0)';
    });
    texts[name] = (await l.innerText()).trim();
  }
  await dock.screenshot({ path: join(dir, `${state}.png`), clip: box, animations: 'disabled' });
  await dock.screenshot({ path: join(dir, `${state}.window.png`), animations: 'disabled' });
  writeFileSync(
    join(dir, `${state}.json`),
    `${JSON.stringify({ state, box, parts: partBoxes, fills, texts, window: size }, null, 2)}\n`,
  );
}

test('tour: the agent dock', async () => {
  const t = await startTour(SCENARIO, { screen: 'home' });
  try {
    const { app, page } = t;
    await steps.homeReady(page);
    // Listen before asking: the window can open before the command's reply arrives.
    const opened = app.waitForEvent('window');
    await page.evaluate(() =>
      (window as unknown as { styx: { command: (n: string, i: unknown) => Promise<unknown> } }).styx.command(
        'window.agentDock',
        { open: true },
      ),
    );
    const dock = await opened;
    const root = dock.locator('[data-dock]');
    const cards = root.locator('[data-dock-card]');
    const needs = cards.and(dock.locator('[data-on="true"]'));
    await expect(needs.first()).toBeVisible();
    await steps.restPointer(dock);
    await reachDock(dock, 'dock', root, {
      needs: needs.first(),
      second: needs.nth(1),
      working: cards.and(dock.locator(':not([data-on])')).first(),
    });
    const first = needs.first();
    await reachDock(dock, 'card-needs', first);
    await steps.pressHold(dock, first, () => reachDock(dock, 'card-pressed', root, { needs: first }));

    // A card brings the main window forward on that agent's chat.
    await first.click();
    const chat = page.locator('[data-chat-pane]');
    await expect(chat).toBeVisible();
    await steps.quietToasts(page);
    await steps.restPointer(page);
    const review = chat.getByRole('button', { name: /^review request$/i });
    await t.reach('focused', chat.locator('[role="log"]'), {
      request: review.locator('xpath=ancestor::*[@data-kind][1]'),
      review,
    });
  } finally {
    await t.close();
  }
});
