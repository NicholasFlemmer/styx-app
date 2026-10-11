/**
 * Tour: select to fix in the running app. Preview shows a dev server; Select to fix, then a click on the Pay button
 * there, opens a note box naming the element; the note goes to the lane's agent with a chip and a picture of it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { startTour, steps } from './tour';

/** A small shop page with a Pay button that runs off its card: the thing to point at. */
const PAGE = `<!doctype html><html><head><title>Acme shop</title><style>
body{margin:0;font:16px system-ui,sans-serif;background:#eef1ff;color:#141a2b}
header{display:flex;justify-content:space-between;padding:18px 32px;background:#fff}
main{padding:32px}h1{margin:0 0 20px;font-size:28px}
.card{width:300px;background:#fff;border-radius:8px;padding:20px}
.row{display:flex;justify-content:space-between;padding:6px 0;color:#6a7184}
.total{color:#141a2b;font-weight:700;border-top:1px solid #eef1ff;margin-top:8px;padding-top:12px}
#pay{margin-top:16px;width:360px;padding:14px;border:0;border-radius:8px;background:#2f5bff;color:#fff;font:600 16px system-ui}
</style></head><body><header><b>Acme shop</b><span>Secure checkout</span></header>
<main><h1>Checkout</h1><div class="card"><div class="row"><span>Subtotal</span><span>€66</span></div>
<div class="row"><span>Shipping</span><span>€4</span></div><div class="row total"><span>Total</span><span>€70</span></div>
<button id="pay">Pay €70</button></div></main></body></html>`;

let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  // A dev server's usual port when it is free (it reads as one in the URL bar), else any.
  await new Promise<void>((resolve) => {
    server.once('error', () => server.listen(0, resolve));
    server.listen(5173, resolve);
  });
  port = (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Runs a script in the preview's page (a native view, outside the window's own page). */
const inPreview = (app: ElectronApplication, js: string) =>
  app.evaluate(
    async ({ webContents }, [p, code]) => {
      const w = webContents.getAllWebContents().find((x) => x.getURL().includes(`:${p}`));
      return w === undefined ? null : ((await w.executeJavaScript(code)) as unknown);
    },
    [String(port), js] as const,
  );

test('tour: select to fix in the running app', async () => {
  const t = await startTour('fix', { screen: 'workspace' });
  try {
    const { app, page } = t;
    await steps.workspaceReady(page);
    await page.click('[data-workspace-mode="design"]');
    const pane = page.locator('[data-design-pane]');
    const url = page.getByLabel('Dev server URL');
    await url.fill(`localhost:${port}`);
    await url.press('Enter');
    await url.blur();
    await expect.poll(() => inPreview(app, 'document.title'), { timeout: 15_000 }).toBe('Acme shop');

    const bar = pane.locator('[data-preview-pick]').locator('xpath=..');
    const pick = pane.locator('[data-preview-pick]');
    await expect(pick).toBeEnabled();
    await steps.restPointer(page);
    await t.reach('bar', bar, { url, pick });
    await steps.pressHold(page, pick, () => t.reach('pick-pressed', bar, { pick }));
    await pick.click();
    await expect(pick).toHaveAttribute('data-preview-pick', 'picking');
    await steps.restPointer(page);
    await t.reach('picking', bar, { pick });

    // The page draws its pick layer; click the Pay button in it (view coordinates, at the page's zoom).
    await expect
      .poll(() => inPreview(app, '!!document.querySelector("[data-styx-pick]")'), { timeout: 5_000 })
      .toBe(true);
    await app.evaluate(async ({ webContents }, p) => {
      const w = webContents.getAllWebContents().find((x) => x.getURL().includes(`:${p}`));
      if (w === undefined) return;
      const r = (await w.executeJavaScript(
        'JSON.stringify(document.querySelector("#pay").getBoundingClientRect())',
      )) as string;
      const b = JSON.parse(r) as { x: number; y: number; width: number; height: number };
      const z = w.getZoomFactor();
      const x = Math.round((b.x + b.width / 2) * z);
      const y = Math.round((b.y + b.height / 2) * z);
      w.sendInputEvent({ type: 'mouseMove', x, y });
      w.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      w.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }, String(port));

    // The note box: what was picked, and what is wrong with it.
    const strip = pane.locator('[data-preview-fix]');
    await expect(strip).toContainText('button#pay “Pay €70”', { timeout: 10_000 });
    const note = strip.locator('[data-preview-fix-text]');
    const send = strip.locator('[data-preview-fix-send]');
    const chip = strip.locator('span[title]').first();
    await steps.restPointer(page);
    await t.reach('note-empty', strip, { chip, note, send });
    await note.fill('The Pay button runs off the card. Keep it inside, full width.');
    await steps.restPointer(page);
    await t.reach('note', strip, { chip, note, send });
    await steps.pressHold(page, send, () => t.reach('send-pressed', strip, { send }));
    await send.click();
    await expect(strip).toHaveCount(0);

    // In the chat: the note, with a chip naming the element and a picture of it.
    const pointer = page.locator('[data-chat-pane] [data-message-pointer]').last();
    await expect(pointer).toContainText('button#pay', { timeout: 10_000 });
    const message = pointer.locator('xpath=ancestor::*[@data-kind][1]');
    await steps.quietToasts(page);
    await steps.restPointer(page);
    await t.reach('sent', message, { pointer });
  } finally {
    await t.close();
  }
});
