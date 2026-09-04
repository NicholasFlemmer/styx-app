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
import { pathToFileURL } from 'node:url';
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
const PROTOTYPE_URL = pathToFileURL(PROTOTYPE).href;
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

/**
 * Viewer fix, NOT a design change. design/handoff/ is read-only, so the prototype is served through page.route with
 * these exact-substring replacements applied to its inline script in memory; the file on disk (and `sourceSha256` in
 * manifest.json) is untouched. Each `find` must occur exactly once or the bake aborts, so a handoff update can never
 * drift past a stale patch unnoticed. The applied list is recorded in manifest.json as `prototypePatches`.
 *
 * 1. With the "Empty states" strip toggle on, renderVals() has no sessions, so
 *      const activeSession = tabsSrc.find(s => s.id === st.session) || tabsSrc[0] || sessions[0];
 *    is undefined and the chat-header values (`activeSession.id/.agent/.branch/.age/.state`) throw
 *    "Cannot read properties of undefined (reading 'id')", which makes the viewer fall back to a placeholder skeleton
 *    for the whole frame. Extending the fallback chain with a blank stub session keeps the render alive; only the
 *    (hidden on Home/Agents) chat header reads it, so the empty-state layouts are rendered exactly as designed.
 */
const PROTOTYPE_PATCHES: readonly { find: string; replace: string }[] = [
  {
    find: 'const activeSession = tabsSrc.find(s => s.id === st.session) || tabsSrc[0] || sessions[0];',
    replace:
      'const activeSession = tabsSrc.find(s => s.id === st.session) || tabsSrc[0] || sessions[0] || ' +
      "{ id: '', agent: '', project: '', branch: '', state: 'idle', note: '', age: '—' };",
  },
];

function patchPrototype(html: string): string {
  return PROTOTYPE_PATCHES.reduce((out, { find, replace }) => {
    const at = out.indexOf(find);
    if (at === -1 || out.indexOf(find, at + 1) !== -1) {
      throw new Error(
        `Prototype patch target ${at === -1 ? 'not found' : 'not unique'} in ${PROTOTYPE}:\n  ${find}`,
      );
    }
    return out.slice(0, at) + replace + out.slice(at + find.length);
  }, html);
}

const prototypeHtml = patchPrototype(readFileSync(PROTOTYPE, 'utf8'));
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
  await page.goto(PROTOTYPE_URL);
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

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    // The prototype itself is served from memory with PROTOTYPE_PATCHES applied; its siblings (support.js) as-is.
    if (url === PROTOTYPE_URL) return route.fulfill({ contentType: 'text/html', body: prototypeHtml });
    if (url.startsWith('file:')) return route.continue();
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
  });

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

  // A partial bake (`pnpm visual:baseline <state...>`) merges into the existing manifest instead of replacing it:
  // entries for the states just attempted are superseded, everything else is carried over.
  const manifestPath = join(OUT, 'manifest.json');
  type Baked = {
    states: { name: string; screen: string }[];
    produced: string[];
    failed: { file: string; error: string }[];
  };
  const previous: Baked =
    only.size && existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Baked)
      : { states: [], produced: [], failed: [] };
  const attempted = new Set(
    states.flatMap((s) => THEMES.flatMap((t) => CHROMES.map((c) => baselineName(s.name, t, c)))),
  );
  const producedAll = new Set([...previous.produced.filter((f) => !attempted.has(f)), ...produced]);
  const bakedStates = new Set([...previous.states.map((s) => s.name), ...states.map((s) => s.name)]);

  const manifest = {
    bakedAt: new Date().toISOString(),
    source: 'design/handoff/Styx.dc.html',
    sourceSha256: createHash('sha256').update(readFileSync(PROTOTYPE)).digest('hex'),
    prototypePatches: PROTOTYPE_PATCHES,
    chromium: browser.version(),
    window: WINDOW,
    deviceScaleFactor: 1,
    states: STATES.filter((s) => bakedStates.has(s.name)).map((s) => ({ name: s.name, screen: s.screen })),
    themes: THEMES,
    chromes: CHROMES,
    produced: THEMES.flatMap((t) =>
      CHROMES.flatMap((c) => STATES.map((s) => baselineName(s.name, t, c)).filter((f) => producedAll.has(f))),
    ),
    failed: [...previous.failed.filter((f) => !attempted.has(f.file)), ...failed],
    unreachable: STATES.filter((s) => s.unreachable !== undefined).map((s) => ({
      name: s.name,
      reason: s.unreachable,
    })),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

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
