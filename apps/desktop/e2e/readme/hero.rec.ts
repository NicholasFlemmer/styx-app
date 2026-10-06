/**
 * The README GIF: a task asks for production access, you grant it, the work carries on. Records the demo
 * workspace with a drawn pointer (recorded video has none), then `scripts/readme-gif.sh` turns the video into
 * `.github/assets/readme-hero.gif`. Re-record whenever the screens it walks through change:
 *
 *   pnpm -F @styx/desktop build && pnpm -F @styx/desktop readme:gif
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type Locator, type Page } from '@playwright/test';
import { launchStyx } from '../launch';

const SIZE = { width: 1280, height: 800 };
const OUT = resolve(__dirname, '../../../../.github/assets/readme-video');

/** A pointer and a click ripple, drawn in the page: Playwright's video has no cursor of its own. */
const drawPointer = (page: Page) =>
  page.evaluate(() => {
    const p = document.createElement('div');
    p.id = 'readme-pointer';
    p.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.5 20 L13.2 18.8 L10.3 12.6 L16.5 12.6 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(p.style, {
      position: 'fixed',
      left: '640px',
      top: '420px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-3px,-2px)',
      transition: 'none',
    });
    document.body.appendChild(p);
    document.addEventListener(
      'mousemove',
      (e) => {
        p.style.left = `${e.clientX}px`;
        p.style.top = `${e.clientY}px`;
      },
      true,
    );
    document.addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div');
        Object.assign(r.style, {
          position: 'fixed',
          left: `${e.clientX - 14}px`,
          top: `${e.clientY - 14}px`,
          width: '28px',
          height: '28px',
          border: '2px solid #d6ff3d',
          borderRadius: '50%',
          zIndex: '2147483646',
          pointerEvents: 'none',
          transition: 'transform 380ms ease-out, opacity 380ms ease-out',
        });
        document.body.appendChild(r);
        requestAnimationFrame(() => {
          r.style.transform = 'scale(1.9)';
          r.style.opacity = '0';
        });
        setTimeout(() => r.remove(), 420);
      },
      true,
    );
  });

/** Glide to the middle of `target`, rest a beat, click. */
async function glideClick(page: Page, target: Locator, restMs = 350): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('target not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
  await page.waitForTimeout(restMs);
  await page.mouse.down();
  await page.mouse.up();
}

test('README hero: a task asks for production, you grant it', async () => {
  mkdirSync(OUT, { recursive: true });
  const { app, page } = await launchStyx({
    screen: 'workspace',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_MFA: 'auto', STYX_DEMO_REPOS: '0' },
    recordVideo: { dir: OUT, size: SIZE },
  });
  await page.waitForSelector('[data-screen-ready="workspace"]');
  await drawPointer(page);
  await page.mouse.move(700, 470);
  await page.waitForTimeout(1600); // the board: two tasks waiting on you

  // Codex's card: "Your turn · Requesting Supabase prod · read + write".
  await glideClick(
    page,
    page.getByText('Fix the flaky order test and make sure the schema matches prod.').nth(1),
  );
  const review = page.getByRole('button', { name: /^review request$/i });
  await review.waitFor();
  await page.waitForTimeout(1300);

  await glideClick(page, review);
  const sheet = page.getByRole('dialog', { name: /supabase/i });
  await sheet.waitFor();
  await page.waitForTimeout(1900); // read the request: prod db, scope, one hour

  await glideClick(page, sheet.getByRole('button', { name: /^grant/i }), 500);
  await page
    .getByText(/grant: supabase-prod · read\+write · expires in/)
    .first()
    .waitFor();
  await page.mouse.move(1180, 560, { steps: 20 });
  await page.waitForTimeout(2600); // the grant in the chat, one fewer waiting on you

  const video = page.video();
  await app.close();
  if (video) console.log('video:', join(await video.path()));
});
