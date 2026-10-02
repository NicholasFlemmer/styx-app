/**
 * Pictures of the app for the website (apps/website/public/app): the real app over the demo fixture, at 1600 × 1000. Only when asked (`STYX_SITE_SHOTS=1 pnpm e2e -- --grep "site shots"`); never part of a normal run.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Session, Worktree } from '@styx/core';
import { launchStyx } from './launch';

const OUT = resolve(__dirname, '../../website/public/app');
const W = 1600;
const H = 1000;

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};
const styx = (page: Page, name: string, input: unknown) =>
  page.evaluate(([n, i]) => (window as unknown as StyxWindow).styx.command(n as string, i), [
    name,
    input,
  ] as const);

async function sized(app: ElectronApplication, page: Page) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setContentSize(w as number, h as number);
    },
    [W, H] as const,
  );
  await page.waitForTimeout(400);
}

/** Needs-you toasts from the demo's asks would sit over the picture: Later on each. */
async function quiet(page: Page) {
  const later = page.locator('[data-toast="needs-you"] button').filter({ hasText: 'Later' });
  for (let i = 0; i < 4 && (await later.count()) > 0; i++) await later.first().click();
}

/** The part of the window the picture is about: the lane's instrument, down to the terminal. */
async function focus(page: Page) {
  const a = await page.locator('[data-instrument]').boundingBox();
  if (a === null) throw new Error('no instrument');
  const term = await page
    .getByText(/^Terminal, /)
    .first()
    .boundingBox();
  const bottom = term === null ? a.y + a.height : term.y - 6;
  return {
    x: Math.round(a.x),
    y: Math.round(a.y),
    width: Math.round(a.width),
    height: Math.round(bottom - a.y),
  };
}

/** `until`: crop at this element's right edge (the design shot ends at the inspector, before the chat). */
const shot = async (page: Page, name: string, until?: string) => {
  await quiet(page);
  const clip = await focus(page);
  if (until !== undefined) {
    const r = await page.locator(until).boundingBox();
    if (r !== null) clip.width = Math.round(r.x + r.width - clip.x);
  }
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 85, clip });
};

async function startTask(page: Page, text: string, kind: 'design' | 'build', agent = 'codex') {
  // The demo rows name binaries this machine does not have: re-detect so the fakes on PATH take over.
  await styx(page, 'detect.clis', {});
  await page.click('[data-workspace-mode="tasks"]');
  const add = page.locator('[data-tasks-add]');
  await add.locator(`[data-tasks-add-kind="${kind}"]`).click();
  await add.locator('select').selectOption(agent);
  // The previous Start clears the box when its spawn resolves, which can land after the next card appears: type
  // until the words stay.
  const box = add.locator('[data-tasks-add-text]');
  await expect
    .poll(async () => {
      await box.fill(text);
      await page.waitForTimeout(300);
      return box.inputValue();
    })
    .toBe(text);
  // Detection can land after the pick: re-detect and re-pick until Start is enabled.
  const go = add.locator('[data-tasks-add-start]');
  for (let i = 0; i < 10 && (await go.isDisabled()); i++) {
    await styx(page, 'detect.clis', {});
    await add.locator('select').selectOption(agent === 'codex' ? 'claude' : 'codex');
    await add.locator('select').selectOption(agent);
    await page.waitForTimeout(500);
  }
  await go.click();
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

/** A believable checkout at one size, drawn the way a design agent writes screens (tokens.css, plain HTML). */
const checkout = (size: 'desktop' | 'tablet' | 'phone', wire = false) => {
  const width = { desktop: 1280, tablet: 834, phone: 390 }[size];
  const two = size !== 'phone';
  const box = wire ? 'background:#e7e7e7;color:#777' : '';
  const items = [
    ['Linen shirt', 'Size M · Sand', '€48'],
    ['Canvas tote', 'Natural', '€22'],
  ]
    .map(
      ([n, d, p]) =>
        `<div class="item"><div class="thumb" style="${box}"></div><div class="grow"><div class="name">${n}</div><div class="muted">${d}</div></div><div class="price">${p}</div></div>`,
    )
    .join('');
  return `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><style>
body{margin:0;font-family:var(--font-body);background:${wire ? '#fff' : 'var(--color-background)'};color:var(--color-text);width:${width}px}
header{display:flex;justify-content:space-between;align-items:center;padding:20px ${two ? 48 : 20}px;border-bottom:1px solid ${wire ? '#ccc' : 'var(--color-border)'}}
.logo{font-family:var(--font-heading);font-weight:700;font-size:20px}
main{display:${two ? 'grid' : 'block'};grid-template-columns:1.4fr 1fr;gap:40px;padding:${two ? 40 : 20}px ${two ? 48 : 20}px}
h1{font-family:var(--font-heading);font-size:${two ? 34 : 26}px;margin:0 0 20px}
.item{display:flex;gap:16px;align-items:center;padding:16px 0;border-bottom:1px solid ${wire ? '#ddd' : 'var(--color-border)'}}
.thumb{width:64px;height:64px;border-radius:var(--radius);background:${wire ? '#e7e7e7' : 'var(--color-surface)'}}
.grow{flex:1}.name{font-weight:600}.muted{color:${wire ? '#999' : 'var(--color-muted)'};font-size:14px}.price{font-weight:600}
.summary{background:${wire ? '#f3f3f3' : 'var(--color-surface)'};border-radius:var(--radius);padding:24px;margin-top:${two ? 0 : 24}px}
.row{display:flex;justify-content:space-between;padding:8px 0}.total{font-size:20px;font-weight:700;border-top:1px solid ${wire ? '#ccc' : 'var(--color-border)'};margin-top:8px;padding-top:16px}
#pay{display:block;width:100%;margin-top:20px;padding:16px;border:0;border-radius:var(--radius);background:${wire ? '#999' : 'var(--color-primary)'};color:#fff;font-size:16px;font-weight:600}
.note{color:${wire ? '#999' : 'var(--color-muted)'};font-size:13px;text-align:center;margin-top:12px}
</style></head><body><header><span class="logo">Field &amp; Co</span><span class="muted">Cart (2)</span></header>
<main><section><h1>Checkout</h1>${items}</section><aside class="summary"><div class="row"><span>Subtotal</span><span>€70</span></div><div class="row"><span class="muted">Delivery</span><span>Free</span></div><div class="row total"><span>Total</span><span>€70</span></div><button id="pay">Pay €70</button><div class="note">Secure payment · Free returns</div></aside></main></body></html>`;
};

let PORT = 0;
let server: Server;
test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // The "running app" Preview shows: the same checkout, as the build task made it, with its theme inline.
    res.end(
      checkout('desktop')
        .replace(
          '<link rel="stylesheet" href="../tokens.css">',
          '<title>Field &amp; Co</title><style>:root{--font-body:system-ui,sans-serif;--font-heading:Georgia,serif;--color-background:#fbfaf7;--color-text:#1d1b16;--color-muted:#7a756a;--color-surface:#f1eee6;--color-border:#e4e0d6;--color-primary:#2f5d50;--radius:10px}</style>',
        )
        .replace('width:1280px', 'width:auto'),
    );
  });
  await new Promise<void>((r) => server.listen(0, r));
  const a = server.address();
  PORT = typeof a === 'object' && a !== null ? a.port : 0;
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test.describe('site shots', () => {
  test.skip(process.env['STYX_SITE_SHOTS'] !== '1', 'pictures for the website only when asked');
  test.setTimeout(180_000);

  test('tasks, design, preview', async () => {
    const { app, page } = await launchStyx({ screen: 'workspace' });
    try {
      await page.locator('[data-screen-ready="workspace"]').waitFor({ state: 'attached', timeout: 20_000 });
      await styx(page, 'detect.clis', {});
      await sized(app, page);

      // Tasks: a design task and its build alongside the demo's lanes.
      const card = await startTask(page, 'Design the checkout: summary and one Pay button', 'design');
      await startTask(page, 'Add input validation to the address form', 'build', 'claude');
      await page.evaluate(() =>
        document.querySelector('[data-tasks-card]')?.closest('[class]')?.parentElement?.scrollTo(0, 0),
      );
      await page.locator('[data-tasks-card]').first().scrollIntoViewIfNeeded();
      await shot(page, 'tasks');

      // Design: the design task's screens, at every size, one element selected.
      await card.click();
      await page.click('[data-workspace-mode="canvas"]');
      const { worktree } = await worktreeOf(page, (s) => s.kind === 'design');
      const dir = join(worktree.path, '.styx', 'designs');
      mkdirSync(join(dir, 'checkout'), { recursive: true });
      writeFileSync(
        join(dir, 'tokens.json'),
        JSON.stringify({
          colors: [
            { name: 'background', value: '#FBFAF7' },
            { name: 'surface', value: '#F1EEE6' },
            { name: 'text', value: '#1D1B16' },
            { name: 'muted', value: '#7A756A' },
            { name: 'border', value: '#E4E0D6' },
            { name: 'primary', value: '#2F5D50' },
          ],
          fonts: { heading: 'Georgia', body: 'system-ui' },
          scale: [
            { name: 'display', size: 34, line: 40, weight: 700 },
            { name: 'body', size: 16, line: 24, weight: 400 },
          ],
          radius: 10,
          spacing: 8,
        }),
      );
      for (const size of ['desktop', 'tablet', 'phone'] as const) {
        writeFileSync(join(dir, 'checkout', `${size}.html`), checkout(size));
        writeFileSync(join(dir, 'checkout', `${size}.wire.html`), checkout(size, true));
      }
      await expect(page.locator('[data-artboard="checkout/phone.html"]')).toBeVisible({ timeout: 10_000 });
      // Room for every size: the canvas at 25%.
      await quiet(page);
      await page.getByLabel('Zoom', { exact: true }).selectOption('0.25');
      await page.click('[data-design-select]');
      await page.frameLocator('[data-artboard="checkout/desktop.html"] iframe').locator('#pay').click();
      const inspector = page.locator('[data-design-inspector="element"]');
      await expect(inspector).toBeVisible();
      await inspector.locator('[data-design-tell]').fill('Make this sticky at the bottom on phone');
      await shot(page, 'design', '[data-design-inspector]');

      // Preview: the running app, Select to fix on the Pay button.
      await page.keyboard.press('Escape');
      await page.click('[data-workspace-mode="tasks"]');
      await page.locator('[data-tasks-card]').filter({ hasText: 'address form' }).click();
      await page.click('[data-workspace-mode="design"]');
      const field = page.getByLabel('Dev server URL');
      await field.fill(`localhost:${PORT}`);
      await field.press('Enter');
      const view = () =>
        app.evaluate(({ webContents }, port: number) => {
          const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
          return w?.getTitle() ?? null;
        }, PORT);
      await expect.poll(view, { timeout: 15_000 }).toContain('Field');
      await page.locator('[data-preview-pick]').click();
      await expect
        .poll(
          () =>
            app.evaluate(async ({ webContents }, port: number) => {
              const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
              return (await w?.executeJavaScript('!!document.querySelector("[data-styx-pick]")')) ?? false;
            }, PORT),
          { timeout: 5_000 },
        )
        .toBe(true);
      await app.evaluate(async ({ webContents }, port: number) => {
        const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
        if (w === undefined) return;
        const r = (await w.executeJavaScript(
          'JSON.stringify(document.getElementById("pay").getBoundingClientRect())',
        )) as string;
        const b = JSON.parse(r) as { x: number; y: number; width: number; height: number };
        const z = w.getZoomFactor();
        const x = Math.round((b.x + b.width / 2) * z);
        const y = Math.round((b.y + b.height / 2) * z);
        w.sendInputEvent({ type: 'mouseMove', x, y });
        w.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        w.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }, PORT);
      const strip = page.locator('[data-preview-fix]');
      await expect(strip).toBeVisible({ timeout: 10_000 });
      await strip.locator('[data-preview-fix-text]').fill('Too low contrast on the hover state');
      // The preview is a native view over the window: capture both and lay the page over the window's picture.
      await quiet(page);
      const parts = await app.evaluate(async ({ BrowserWindow }, port: number) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win === undefined) return null;
        const views = win.contentView.children as unknown as {
          webContents?: Electron.WebContents;
          getBounds(): Electron.Rectangle;
        }[];
        const view = views.find((v) => v.webContents?.getURL().includes(String(port)));
        const base = await win.webContents.capturePage();
        const over = view?.webContents ? await view.webContents.capturePage() : null;
        return {
          base: base.toPNG().toString('base64'),
          over: over?.toPNG().toString('base64') ?? null,
          at: view?.getBounds() ?? null,
        };
      }, PORT);
      if (parts === null || parts.over === null || parts.at === null) throw new Error('preview not captured');
      const clip = await focus(page);
      const png = await page.evaluate(
        async ({ base, over, at, clip }) => {
          // Decoded by hand: the app's policy allows no fetch of a data: URL.
          const img = async (b64: string) =>
            createImageBitmap(
              new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: 'image/png' }),
            );
          const a = await img(base);
          const b = await img(over as string);
          const s = a.width / window.innerWidth;
          const k = clip as { x: number; y: number; width: number; height: number };
          const c = new OffscreenCanvas(Math.round(k.width * s), Math.round(k.height * s));
          const g = c.getContext('2d');
          if (g === null) return '';
          g.translate(-k.x * s, -k.y * s);
          g.drawImage(a, 0, 0);
          const r = at as { x: number; y: number; width: number; height: number };
          g.drawImage(b, r.x * s, r.y * s, r.width * s, r.height * s);
          const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (const x of bytes) bin += String.fromCharCode(x);
          return btoa(bin);
        },
        { ...parts, clip },
      );
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'preview.jpg'), Buffer.from(png, 'base64'));
    } finally {
      await app.close();
    }
  });
});
