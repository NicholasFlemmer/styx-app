/**
 * The freeform Design canvas (ADR-0030, row 163): wheel zoom toward the pointer keeps the zoom control in step, a
 * board dragged by its name is saved to `.styx/designs/canvas.json` and is still there after a relaunch, and Tidy up
 * puts the rows back. Fake CLIs only (e2e/fixtures/bin).
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const TASK = 'A checkout to move around';

async function designWorktree(page: Page) {
  const snap = (await styx(page, 'store.snapshot', {})) as {
    value: { sessions: Session[]; worktrees: Worktree[] };
  };
  const session = snap.value.sessions.find((s) => s.kind === 'design');
  const worktree = snap.value.worktrees.find((w) => w.id === session?.worktreeId);
  if (session === undefined || worktree === undefined) throw new Error('design task missing');
  return { session, worktree };
}

const screenHtml = (w: number) =>
  `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><style>body{margin:0;padding:24px;width:${w}px;font-family:var(--font-body)}#pay{display:block;width:240px;padding:12px;border:0;background:var(--color-primary);color:#fff}</style></head><body><h1>Pay securely</h1><button id="pay">Pay €70</button></body></html>`;

const boardPos = (page: Page, path: string) =>
  page.locator(`[data-artboard="${path}"]`).evaluate((el: HTMLElement) => ({
    x: Number.parseFloat(el.style.left),
    y: Number.parseFloat(el.style.top),
  }));

const zoomValue = (page: Page) => page.locator('[data-design-canvas] select[data-design-zoom]').inputValue();

async function openCanvas(page: Page) {
  await page.click('[data-workspace-mode="tasks"]');
  await page.locator('[data-tasks-card]').filter({ hasText: TASK }).click();
  await page.click('[data-workspace-mode="canvas"]');
  await expect(page.locator('[data-design-stage]')).toBeVisible();
}

test('design canvas: wheel zoom, a drag-moved board kept across a relaunch, Tidy up', async () => {
  // A profile this test owns, so the second launch finds the first one's design task and files.
  const userData = mkdtempSync(join(tmpdir(), 'styx-e2e-canvas-'));
  const first = await launchStyx({ screen: 'workspace', userData });
  let dir = '';
  try {
    const { page } = first;
    await page.locator('[data-screen-ready="workspace"]').waitFor({ state: 'attached', timeout: 20_000 });
    await styx(page, 'detect.clis', {});
    await page.click('[data-workspace-mode="tasks"]');
    const add = page.locator('[data-tasks-add]');
    await add.locator('[data-tasks-add-kind="design"]').click();
    await add.locator('select').selectOption('codex');
    await add.locator('[data-tasks-add-text]').fill(TASK);
    await add.locator('[data-tasks-add-start]').click();
    await expect(page.locator('[data-tasks-card]').filter({ hasText: TASK })).toBeVisible({
      timeout: 20_000,
    });
    await openCanvas(page);

    const { worktree } = await designWorktree(page);
    dir = join(worktree.path, '.styx', 'designs');
    mkdirSync(join(dir, 'checkout'), { recursive: true });
    writeFileSync(join(dir, 'checkout', 'desktop.html'), screenHtml(1200));
    writeFileSync(join(dir, 'checkout', 'desktop.wire.html'), screenHtml(1200));
    writeFileSync(join(dir, 'checkout', 'phone.html'), screenHtml(340));
    await expect(page.locator('[data-artboard="checkout/phone.html"] iframe')).toBeVisible({
      timeout: 10_000,
    });

    // First open: today's rows at 33%, wireframe before hi-fi.
    expect(await zoomValue(page)).toBe('0.33');
    expect(await boardPos(page, 'checkout/desktop.wire.html')).toEqual({ x: 0, y: 0 });
    expect(await boardPos(page, 'checkout/desktop.html')).toEqual({ x: 1360, y: 0 });

    // Mod+= / Mod+− step the canvas's zoom, never the window's (the View menu's page zoom stays put).
    await page.keyboard.press('ControlOrMeta+Equal');
    await expect.poll(() => zoomValue(page)).toBe('0.5');
    const windowZoom = () =>
      first.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getZoomFactor()));
    expect((await windowZoom()).every((z) => z === 1)).toBe(true);
    await page.keyboard.press('ControlOrMeta+Minus');
    await expect.poll(() => zoomValue(page)).toBe('0.33');
    expect((await windowZoom()).every((z) => z === 1)).toBe(true);

    // Ctrl + wheel over a board zooms toward the pointer; the zoom control follows.
    const board = page.locator('[data-artboard="checkout/desktop.html"] [data-board-shield]');
    const box = await board.boundingBox();
    if (box === null) throw new Error('board not drawn');
    const at = { x: box.x + 40, y: box.y + 40 };
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(() => zoomValue(page)).toBe('0.4');
    // The board under the pointer stayed under it (to within a pixel).
    const after = await board.boundingBox();
    if (after === null) throw new Error('board gone');
    expect(Math.abs(after.x + 40 * 1.2 - at.x)).toBeLessThan(2);
    // A plain wheel pans; the zoom stays.
    await page.mouse.wheel(0, 60);
    await expect.poll(async () => (await board.boundingBox())?.y).toBeLessThan(after.y - 50);
    expect(await zoomValue(page)).toBe('0.4');
    await page.click('[data-design-fit]');

    // Drag the phone board by its name: it moves, snapped to 8px, and the layout is written.
    const handle = page.locator('[data-board-handle="checkout/phone.html"]');
    const h = await handle.boundingBox();
    if (h === null) throw new Error('no handle');
    await page.mouse.move(h.x + 6, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 6, h.y + h.height / 2 + 60, { steps: 4 });
    await page.mouse.move(h.x + 6, h.y + h.height / 2 + 120, { steps: 4 });
    await page.mouse.up();
    const moved = await boardPos(page, 'checkout/phone.html');
    expect(moved.y).toBeGreaterThan(0);
    expect(moved.x % 8).toBe(0);
    expect(moved.y % 8).toBe(0);
    const canvasJson = join(dir, 'canvas.json');
    await expect
      .poll(() => (existsSync(canvasJson) ? JSON.parse(readFileSync(canvasJson, 'utf8')) : null), {
        timeout: 5_000,
      })
      .toMatchObject({ version: 1, boards: { 'checkout/phone.html': moved } });
    // The arrow keys nudge the focused board's name.
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => boardPos(page, 'checkout/phone.html')).toEqual({ x: moved.x + 8, y: moved.y });
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(() => JSON.parse(readFileSync(canvasJson, 'utf8')).boards['checkout/phone.html'], {
        timeout: 5_000,
      })
      .toEqual(moved);
    await first.app.close();

    // Relaunch over the same profile: the board is where it was left.
    const second = await launchStyx({ screen: 'workspace', userData });
    try {
      const p2 = second.page;
      await p2.locator('[data-screen-ready="workspace"]').waitFor({ state: 'attached', timeout: 20_000 });
      await openCanvas(p2);
      await expect(p2.locator('[data-artboard="checkout/phone.html"]')).toBeVisible({ timeout: 10_000 });
      expect(await boardPos(p2, 'checkout/phone.html')).toEqual(moved);

      // Tidy up: the rows again, saved, and Undo puts the move back.
      await p2.click('[data-design-tidy]');
      await expect.poll(() => boardPos(p2, 'checkout/phone.html')).toEqual({ x: 2720, y: 0 });
      await expect(p2.locator('[data-design-notice]')).toContainText('Tidied up');
      await expect
        .poll(() => JSON.parse(readFileSync(canvasJson, 'utf8')).boards['checkout/phone.html'], {
          timeout: 5_000,
        })
        .toEqual({ x: 2720, y: 0 });
      await p2.locator('[data-design-notice-action]').click();
      await expect.poll(() => boardPos(p2, 'checkout/phone.html')).toEqual(moved);
    } finally {
      await second.app.close();
    }
  } finally {
    await first.app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
