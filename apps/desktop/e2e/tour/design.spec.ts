/**
 * Tour: design before you build. A design task starts from the board; its screens (written here as the agent would)
 * show on the Design canvas at desktop, tablet and phone size; Select picks the Pay button and says what to change;
 * Build it offers to hand the screens to a build task.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Session, Worktree } from '@styx/core';
import { startTour, steps } from './tour';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

const TASK = 'A checkout with a summary and one Pay button';

/** The design task's worktree path, from the store. */
async function designDir(page: Page): Promise<string> {
  const snap = (await page.evaluate(() =>
    (window as unknown as StyxWindow).styx.command('store.snapshot', {}),
  )) as { value: { sessions: Session[]; worktrees: Worktree[] } };
  const session = snap.value.sessions.find((s) => s.kind === 'design');
  const worktree = snap.value.worktrees.find((w) => w.id === session?.worktreeId);
  if (worktree === undefined) throw new Error('design worktree missing');
  return join(worktree.path, '.styx', 'designs');
}

/** One checkout screen at a size: two columns from tablet up, one on a phone. */
function checkout(size: 'desktop' | 'tablet' | 'phone'): string {
  const wide = size !== 'phone';
  const pad = size === 'desktop' ? 64 : size === 'tablet' ? 40 : 20;
  const item = (name: string, meta: string, price: string) =>
    `<li><span class="thumb"></span><span class="what"><b>${name}</b><small>${meta}</small></span><span class="price">${price}</span></li>`;
  return `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><style>
body{margin:0;font-family:var(--font-body);color:var(--color-ink);background:var(--color-tint)}
header{display:flex;align-items:center;justify-content:space-between;padding:20px ${pad}px;background:var(--color-surface)}
header b{font-size:20px;letter-spacing:-0.02em}header span{color:var(--color-muted);font-size:14px}
main{display:${wide ? 'grid' : 'block'};grid-template-columns:1.4fr 1fr;gap:32px;padding:32px ${pad}px}
h1{font-size:var(--text-display-size);line-height:var(--text-display-line);font-weight:var(--text-display-weight);margin:0 0 20px}
section{background:var(--color-surface);border-radius:var(--radius);padding:24px;margin-bottom:20px}
ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid var(--color-tint)}
.thumb{width:56px;height:56px;border-radius:var(--radius);background:var(--color-tint);flex:none}
.what{flex:1;display:flex;flex-direction:column;gap:4px}.what small{color:var(--color-muted)}.price{font-weight:600}
.row{display:flex;justify-content:space-between;padding:8px 0;color:var(--color-muted)}
.total{color:var(--color-ink);font-weight:700;font-size:18px;border-top:1px solid var(--color-tint);margin-top:8px;padding-top:16px}
#pay{display:block;width:100%;margin-top:20px;padding:16px;border:0;border-radius:var(--radius);background:var(--color-primary);color:#fff;font:600 16px var(--font-body)}
.safe{margin-top:12px;text-align:center;color:var(--color-success);font-size:13px}
</style></head><body>
<header><b>Acme shop</b><span>Secure checkout</span></header>
<main><div><h1>Checkout</h1><section><ul>
${item('Trail runner', 'Size 42 · Blue', '€54')}
${item('Running socks', 'Pack of 3', '€12')}
${item('Gift wrap', 'Paper · Green', '€0')}
</ul></section></div>
<div><section><div class="row"><span>Subtotal</span><span>€66</span></div>
<div class="row"><span>Shipping</span><span>€4</span></div>
<div class="row"><span>Delivery</span><span>Tue 14 Oct</span></div>
<div class="row total"><span>Total</span><span>€70</span></div>
<button id="pay">Pay €70</button><p class="safe">Paid in one step</p></section></div></main>
</body></html>`;
}

test('tour: design screens before building', async () => {
  // A design task makes a real worktree, so the demo repos are on disk here.
  const t = await startTour('design', {
    screen: 'workspace',
    env: {
      STYX_DEMO_REPOS: '1',
      // What the (fake) Codex says it drew, and the command it asks to run (allowed below).
      STYX_FAKE_CODEX_REPLY: 'Drew the checkout at desktop, tablet and phone size, in your type and colours.',
      STYX_FAKE_CODEX_COMMAND: 'ls .styx/designs/checkout',
    },
  });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await steps.detectClis(page);
    await steps.foldTerminal(page);

    // The board's box, set to Design, with what to design.
    const add = steps.addBox(page);
    await add.locator('[data-tasks-add-kind="design"]').click();
    await add.locator('select').selectOption('codex');
    const start = add.locator('[data-tasks-add-start]');
    const parts = {
      kind: add.locator('[data-tasks-add-kind="design"]'),
      field: add.locator('[data-tasks-add-text]'),
      start,
    };
    await steps.restPointer(page);
    await t.reach('add-empty', add, parts);
    await add.locator('[data-tasks-add-text]').fill(TASK);
    await add.locator('[data-tasks-add-text]').blur();
    await t.reach('add-design', add, parts);
    await steps.pressHold(page, start, () => t.reach('start-pressed', add, parts));
    await steps.pressStart(page, TASK);
    const card = steps.card(page, TASK);
    await expect(card.locator('[data-tasks-kind]')).toHaveText('Design');
    await steps.restPointer(page);
    await t.reach('card-design', card, { kind: card.locator('[data-tasks-kind]') });

    // The agent's screens, at three sizes, on the Design canvas.
    await card.click();
    await steps.quietToasts(page);
    await page
      .locator('[data-chat-pane] [data-kind="decision"]')
      .last()
      .getByRole('button', { name: 'Allow' })
      .click();
    const dir = await designDir(page);
    mkdirSync(join(dir, 'checkout'), { recursive: true });
    for (const size of ['desktop', 'tablet', 'phone'] as const)
      writeFileSync(join(dir, 'checkout', `${size}.html`), checkout(size));
    await page.click('[data-workspace-mode="canvas"]');
    const canvas = page.locator('[data-design-canvas]');
    const board = (size: string) => canvas.locator(`[data-artboard="checkout/${size}.html"]`);
    const row = canvas.locator('[data-design-row="checkout"]');
    for (const size of ['desktop', 'tablet', 'phone'])
      await expect(board(size).locator('iframe')).toBeVisible();
    // Each screen has drawn (its Pay button is there) before the picture.
    for (const size of ['desktop', 'tablet', 'phone'])
      await expect(board(size).frameLocator('iframe').locator('#pay')).toBeVisible();
    // A quarter size, so the three sizes sit side by side beside the chat.
    await canvas.getByLabel('Zoom').selectOption('0.25');
    const build = canvas.locator('[data-design-build]');
    await steps.restPointer(page);
    // The scrolling area the rows sit in: the row itself is narrower than its boards.
    await t.reach('screens', row.locator('xpath=..'), {
      desktop: board('desktop'),
      tablet: board('tablet'),
      phone: board('phone'),
    });
    await t.reach('canvas', canvas, {
      row,
      desktop: board('desktop'),
      tablet: board('tablet'),
      phone: board('phone'),
      sizes: canvas.getByRole('radiogroup', { name: 'Sizes' }),
      select: canvas.locator('[data-design-select]'),
      build,
    });

    // Select, then the Pay button on the desktop screen: the element's panel, with a note for the agent.
    await canvas.locator('[data-design-select]').click();
    await board('desktop').frameLocator('iframe').locator('#pay').click();
    const inspector = canvas.locator('[data-design-inspector="element"]');
    await expect(inspector).toContainText('Pay');
    await inspector.locator('[data-design-tell]').fill('Make it sticky on phones');
    await steps.restPointer(page);
    await t.reach('element', inspector, {
      text: inspector.locator('[data-design-text]'),
      tell: inspector.locator('[data-design-tell]'),
      send: inspector.locator('[data-design-send]'),
    });
    await t.reach('canvas-selected', canvas, {
      desktop: board('desktop'),
      inspector,
      send: inspector.locator('[data-design-send]'),
    });
    await inspector.locator('[data-design-tell]').blur();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);

    // Build it: held for the picture, then pressed; the handover sheet.
    await steps.restPointer(page);
    await steps.pressHold(page, build, () => t.reach('build-pressed', canvas, { build }));
    await build.click();
    const handover = page.getByRole('dialog', { name: 'Build these designs' });
    const go = handover.locator('[data-handover-start]');
    const handoverParts = { newTask: handover.locator('[data-handover-mode="new"]'), start: go };
    await steps.restPointer(page);
    await t.reach('handover', handover, handoverParts);
    await steps.pressHold(page, go, () => t.reach('handover-pressed', handover, handoverParts));
    await go.click();
    await expect(handover).toHaveCount(0, { timeout: 20_000 });

    // The build task on the board, linked to the design it came from.
    await page.click('[data-workspace-mode="tasks"]');
    const built = page.locator('[data-tasks-card]').filter({ has: page.locator('[data-tasks-link="from"]') });
    await steps.quietToasts(page);
    await steps.restPointer(page);
    await t.reach('card-build', built, { link: built.locator('[data-tasks-link="from"]') });
  } finally {
    await t.close();
  }
});
