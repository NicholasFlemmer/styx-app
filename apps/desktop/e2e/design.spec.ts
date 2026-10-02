/**
 * Tasks, design and build (#138–#140): a new task joins the Tasks board; a design task draws screens the Design tab
 * shows, a selection on them changes the file or goes to the agent with a chip; Build it starts a linked build task;
 * the tabs keep the person's order. Fake CLIs only (e2e/fixtures/bin).
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session, Worktree } from '@styx/core';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

const styx = (page: Page, name: string, input: unknown) =>
  page.evaluate(([n, i]) => (window as unknown as StyxWindow).styx.command(n as string, i), [
    name,
    input,
  ] as const);

async function ready(page: Page) {
  await page.locator('[data-screen-ready="workspace"]').waitFor({ state: 'attached', timeout: 20_000 });
  // The demo rows name binaries this machine does not have: re-detect so the fakes on PATH take over.
  await styx(page, 'detect.clis', {});
}

async function startTask(page: Page, text: string, kind: 'design' | 'build') {
  await page.click('[data-workspace-mode="tasks"]');
  const add = page.locator('[data-tasks-add]');
  await add.locator(`[data-tasks-add-kind="${kind}"]`).click();
  await add.locator('select').selectOption('codex');
  await add.locator('[data-tasks-add-text]').fill(text);
  await add.locator('[data-tasks-add-start]').click();
  const card = page.locator('[data-tasks-card]').filter({ hasText: text });
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

async function worktreeOf(page: Page, pick: (s: Session) => boolean) {
  const snap = (await styx(page, 'store.snapshot', {})) as {
    value: { sessions: Session[]; worktrees: Worktree[] };
  };
  const session = snap.value.sessions.find(pick);
  const worktree = snap.value.worktrees.find((w) => w.id === session?.worktreeId);
  if (session === undefined || worktree === undefined) throw new Error('session / worktree missing');
  return { session, worktree };
}

test('a new task joins the Tasks board as a card, marked Build', async () => {
  const { app, page } = await launchStyx({ screen: 'workspace' });
  try {
    await ready(page);
    const card = await startTask(page, 'Add a sitemap', 'build');
    await expect(card.locator('[data-tasks-kind]')).toHaveText('Build');
    // A click opens it in the chat.
    await card.click();
    await expect(page.locator('[data-lane-header] [data-lane-task]')).toContainText('Add a sitemap');
  } finally {
    await app.close();
  }
});

test('design task: screens on the canvas, select to edit and to tell the agent, Build it links a build task', async () => {
  const { app, page } = await launchStyx({ screen: 'workspace' });
  try {
    await ready(page);
    const card = await startTask(page, 'A checkout with one Pay button', 'design');
    await expect(card.locator('[data-tasks-kind]')).toHaveText('Design');
    await card.click();
    await page.click('[data-workspace-mode="canvas"]');
    await expect(page.locator('[data-design-canvas]')).toBeVisible();
    // The canvas has the room: no project nav beside it.
    await expect(page.locator('[data-nav="true"]')).toHaveCount(0);

    // The agent's screens (written here as the fake agent would), with the tokens Styx seeded for the task.
    const { session, worktree } = await worktreeOf(page, (s) => s.kind === 'design');
    const dir = join(worktree.path, '.styx', 'designs');
    expect(existsSync(join(dir, 'tokens.json'))).toBe(true);
    mkdirSync(join(dir, 'checkout'), { recursive: true });
    const screen = (w: number) =>
      `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><style>body{font-family:var(--font-body);margin:0;padding:24px;width:${w}px}#pay{display:block;background:var(--color-primary);color:#fff;border:0;border-radius:var(--radius);padding:12px;width:240px}</style></head><body><h1>Pay securely</h1><p class="total">Total €70</p><button id="pay">Pay €70</button></body></html>`;
    writeFileSync(join(dir, 'checkout', 'desktop.html'), screen(1200));
    writeFileSync(join(dir, 'checkout', 'phone.html'), screen(340));
    const board = page.locator('[data-artboard="checkout/desktop.html"]');
    await expect(board).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-artboard="checkout/phone.html"]')).toBeVisible();
    await expect(page.locator('[data-design-screen="checkout"]')).toContainText('Checkout');

    // Select (V), then click the button inside the screen.
    await page.click('[data-design-select]');
    await page.frameLocator('[data-artboard="checkout/desktop.html"] iframe').locator('#pay').click();
    const inspector = page.locator('[data-design-inspector="element"]');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('Pay');
    // Changed here: it changes in the file.
    await inspector.locator('[data-design-text]').fill('Pay now');
    await expect
      .poll(() => readFileSync(join(dir, 'checkout', 'desktop.html'), 'utf8'), { timeout: 5_000 })
      .toContain('>Pay now</button>');
    expect(readFileSync(join(dir, 'checkout', 'desktop.html'), 'utf8')).not.toContain('data-styx');

    // Told the agent: the message carries a chip naming what was pointed at.
    await inspector.locator('[data-design-tell]').fill('Make it sticky on phone');
    await inspector.locator('[data-design-send]').click();
    const chip = page.locator('[data-chat-pane] [data-message-pointer]').last();
    await expect(chip).toContainText('Checkout › Pay', { timeout: 10_000 });

    // A dragged area on the phone screen (Escape first: the element's panel goes, the canvas has its width back).
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-design-inspector]')).toHaveCount(0);
    await page.locator('[data-artboard="checkout/phone.html"]').scrollIntoViewIfNeeded();
    const phone = page.locator('[data-artboard="checkout/phone.html"] iframe');
    const box = await phone.boundingBox();
    if (box === null) throw new Error('phone screen not drawn');
    // Playwright's mouse calls never settle while a button is held over a sandboxed srcdoc frame (its drag
    // interception waits on the frame); the events do reach the page, so each call is capped and the result asserted.
    const settle = (p: Promise<void>) => Promise.race([p, new Promise<void>((r) => setTimeout(r, 1_000))]);
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.mouse.down();
    await settle(page.mouse.move(box.x + box.width / 2, box.y + 30));
    await settle(page.mouse.move(box.x + box.width - 4, box.y + 60));
    await settle(page.mouse.up());
    await expect(page.locator('[data-design-inspector="area"]')).toBeVisible();

    // Type and colour: a colour change rewrites tokens.css.
    await page.click('[data-design-tokens]');
    await page.locator('[data-design-colour="primary"]').evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(el, '#ff0000');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect
      .poll(() => readFileSync(join(dir, 'tokens.css'), 'utf8'), { timeout: 5_000 })
      .toContain('--color-primary: #FF0000;');

    // Build it: a new build task, branched from the design, linked both ways.
    await page.click('[data-design-build]');
    await expect(page.locator('[data-handover]')).toBeVisible();
    await page.click('[data-handover-start]');
    await expect(page.locator('[data-handover]')).toHaveCount(0, { timeout: 20_000 });
    const { session: build } = await worktreeOf(page, (s) => s.designSessionId === session.id);
    expect(build.kind).toBe('build');
    await page.click('[data-workspace-mode="tasks"]');
    await expect(page.locator(`[data-tasks-card="${build.id}"] [data-tasks-link="from"]`)).toBeVisible();
    await expect(
      page.locator(`[data-tasks-card="${session.id}"] [data-tasks-link="built-by"]`),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test('the tabs keep the person’s order', async () => {
  const { app, page } = await launchStyx({ screen: 'workspace' });
  try {
    await page.locator('[data-screen-ready="workspace"]').waitFor({ state: 'attached', timeout: 20_000 });
    const order = () =>
      page
        .locator('[data-instruments] [data-workspace-mode]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-workspace-mode')));
    await page.click('[data-workspace-mode="code"]', { button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to front' }).click();
    await expect.poll(order).toEqual(['code', 'tasks', 'canvas', 'design', 'changes', 'terminal']);
    // Keyboard: Alt+Shift+→ on the focused tab.
    await page.locator('[data-workspace-mode="code"]').focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(order).toEqual(['tasks', 'code', 'canvas', 'design', 'changes', 'terminal']);
    await page.reload();
    await page.locator('[data-screen-ready="workspace"]').waitFor({ state: 'attached', timeout: 20_000 });
    await expect.poll(order).toEqual(['tasks', 'code', 'canvas', 'design', 'changes', 'terminal']);
  } finally {
    await app.close();
  }
});
