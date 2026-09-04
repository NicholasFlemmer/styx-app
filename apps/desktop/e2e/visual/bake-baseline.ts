/**
 * Bakes visual baselines from the pixel-final prototype (design/handoff/Styx.dc.html).
 *
 *   pnpm visual:baseline                # all states × {dark,light} × {mac,win}
 *   pnpm visual:baseline -- home palette  # only these states
 *
 * Runs fully offline: Google Fonts requests are answered with the @styx/tokens woff2 files (so the app and the
 * prototype rasterise identical glyphs) and the React 18 UMD scripts the viewer runtime pulls from unpkg are served
 * from ./vendor. Every other network request is aborted.
 */
import { chromium, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHROMES,
  STATES,
  THEMES,
  WINDOW,
  baselineName,
  type DriveStep,
  type VisualChrome,
  type VisualTheme,
} from './states.ts';

const here = import.meta.dirname;
const ROOT = resolve(here, '../../../..');
const PROTOTYPE = join(ROOT, 'design/handoff/Styx.dc.html');
const FONT_DIR = join(ROOT, 'packages/tokens/fonts');
const FONT_CSS = join(ROOT, 'packages/tokens/css/fonts.css');
const VENDOR = join(here, 'vendor');
const OUT = join(here, '__baseline__');
const FONT_HOST = 'https://fonts.gstatic.com/styx/';

const only = new Set(process.argv.slice(2));
const requested = only.size ? STATES.filter((s) => only.has(s.name)) : STATES;
const states = requested.filter((s) => s.unreachable === undefined);
const unreachable = requested.filter((s) => s.unreachable !== undefined);
const unknown = [...only].filter((n) => !STATES.some((s) => s.name === n));
if (unknown.length) {
  console.error(`Unknown state(s): ${unknown.join(', ')}. Known: ${STATES.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const fontCss = readFileSync(FONT_CSS, 'utf8').replace(/url\('\.\.\/fonts\//g, `url('${FONT_HOST}`);
const vendorFor = (url: string): string | undefined => {
  if (/\/react@18\.3\.1\/umd\/react\.production\.min\.js$/.test(url))
    return join(VENDOR, 'react.production.min.js');
  if (/\/react-dom@18\.3\.1\/umd\/react-dom\.production\.min\.js$/.test(url))
    return join(VENDOR, 'react-dom.production.min.js');
  return undefined;
};

const FRAME = `div[style^="width: ${WINDOW.width}px; height: ${WINDOW.height}px"]`;
const STRIPS = 'div[style*="min-width: 1328px"] > div';

async function loadPrototype(page: Page): Promise<{ frame: Locator; strips: Locator }> {
  await page.goto(`file://${PROTOTYPE}`);
  await page.waitForSelector('[data-screen-label]', { state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  const frame = page.locator(FRAME);
  await frame.waitFor();
  // The 1px --ln border is a viewer affordance; the app window has none, so drop it and let content fill 1280×800.
  await frame.evaluate((el) => {
    el.style.border = '0';
  });
  const box = await frame.boundingBox();
  if (!box || Math.round(box.width) !== WINDOW.width || Math.round(box.height) !== WINDOW.height) {
    throw new Error(
      `Prototype frame is ${box?.width}×${box?.height}, expected ${WINDOW.width}×${WINDOW.height}`,
    );
  }
  return { frame, strips: page.locator(STRIPS) };
}

async function setToggle(strip: Locator, prefix: 'Theme' | 'Chrome', want: string): Promise<void> {
  const button = strip.getByRole('button', { name: new RegExp(`^${prefix}:`) });
  for (let i = 0; i < 3; i++) {
    const text = (await button.textContent()) ?? '';
    if (text.toLowerCase().endsWith(want)) return;
    await button.click();
  }
  throw new Error(`Could not set ${prefix} to ${want}`);
}

async function drive(
  page: Page,
  frame: Locator,
  strips: Locator,
  steps: readonly DriveStep[],
): Promise<void> {
  for (const step of steps) {
    switch (step.kind) {
      case 'screen':
        await strips.nth(0).getByRole('button', { name: step.label, exact: true }).click();
        break;
      case 'flow':
        await strips.nth(1).getByRole('button', { name: step.label, exact: true }).click();
        break;
      case 'frame-button':
        await frame
          .getByRole('button', { name: new RegExp(step.name) })
          .first()
          .click();
        break;
      case 'key':
        await page.keyboard.press(step.key);
        break;
    }
    await page.waitForTimeout(60);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const blocked = new Set<string>();

  await page.route(
    (u) => u.protocol !== 'file:',
    async (route) => {
      const url = route.request().url();
      if (url.startsWith('https://fonts.googleapis.com/'))
        return route.fulfill({ contentType: 'text/css', body: fontCss });
      if (url.startsWith(FONT_HOST)) {
        const file = join(FONT_DIR, url.slice(FONT_HOST.length).split('?')[0] ?? '');
        if (existsSync(file)) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(file) });
      }
      const vendored = vendorFor(url);
      if (vendored) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(vendored) });
      blocked.add(url);
      return route.abort();
    },
  );

  const produced: string[] = [];
  const failed: { file: string; error: string }[] = [];
  let index = 0;
  const total = states.length * THEMES.length * CHROMES.length;

  for (const theme of THEMES as readonly VisualTheme[]) {
    for (const chrome of CHROMES as readonly VisualChrome[]) {
      for (const state of states) {
        const file = baselineName(state.name, theme, chrome);
        index++;
        try {
          const { frame, strips } = await loadPrototype(page);
          await setToggle(strips.nth(0), 'Theme', theme);
          await setToggle(strips.nth(0), 'Chrome', chrome);
          await drive(page, frame, strips, state.drive);
          await page.mouse.move(0, 0); // clear style-hover
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(120);
          const fontsOk = await page.evaluate(
            () => document.fonts.check('600 13px Archivo') && document.fonts.check('12px "JetBrains Mono"'),
          );
          if (!fontsOk) throw new Error('bundled fonts not active');
          await frame.screenshot({ path: join(OUT, file), animations: 'disabled', caret: 'hide' });
          produced.push(file);
          process.stdout.write(`[${String(index).padStart(2, '0')}/${total}] ${file}\n`);
        } catch (e) {
          const error = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
          failed.push({ file, error });
          process.stdout.write(`[${String(index).padStart(2, '0')}/${total}] ${file}  FAILED: ${error}\n`);
        }
      }
    }
  }

  await browser.close();

  const manifest = {
    bakedAt: new Date().toISOString(),
    source: 'design/handoff/Styx.dc.html',
    sourceSha256: createHash('sha256').update(readFileSync(PROTOTYPE)).digest('hex'),
    chromium: browser.version(),
    window: WINDOW,
    deviceScaleFactor: 1,
    states: states.map((s) => ({ name: s.name, screen: s.screen })),
    themes: THEMES,
    chromes: CHROMES,
    produced,
    failed,
    unreachable: unreachable.map((s) => ({ name: s.name, reason: s.unreachable })),
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  if (blocked.size)
    console.log(`Blocked ${blocked.size} network request(s):\n  ${[...blocked].join('\n  ')}`);
  console.log(`\n${produced.length}/${total} baselines written to ${OUT}`);
  for (const s of unreachable) console.log(`skipped ${s.name} (all themes/chromes): ${s.unreachable}`);
  if (failed.length) {
    console.log(`${failed.length} failed:`);
    for (const f of failed) console.log(`  ${f.file}: ${f.error}`);
    process.exitCode = 1;
  }
}

await main();
