/**
 * Accessibility (spec §9): axe-core over every visual-harness state (`STYX_SCREEN=<state>`), dark theme, mac chrome.
 *
 *   pnpm e2e -- --grep a11y                                          # part of the e2e project
 *   playwright test -c e2e/playwright.config.ts --project a11y       # the dedicated project
 *
 * Monaco and xterm paint their own accessibility trees (spec §9: "expose their own accessible modes"), so their
 * internals are excluded; everything Styx renders itself must be clean. `popout` is a second BrowserWindow the
 * harness does not drive here.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';
import { STATES } from './visual/states';

const READY_TIMEOUT = 10_000;
const SKIP = new Set(['popout']);
const THIRD_PARTY = ['.monaco-editor', '.xterm'];

test.describe('a11y (axe) per harness state', () => {
  for (const state of STATES) {
    if (SKIP.has(state.name)) continue;
    test(`a11y · ${state.name}`, async () => {
      const fixture = state.name.endsWith('-empty')
        ? 'empty'
        : state.name.endsWith('-error')
          ? 'error'
          : 'demo';
      const { app, page } = await launchStyx({
        screen: state.name,
        theme: 'dark',
        chrome: 'mac',
        fixture,
        env: { STYX_DEMO_REPOS: '0' },
      });
      try {
        await page
          .locator('[data-screen-ready]')
          .first()
          .waitFor({ state: 'attached', timeout: READY_TIMEOUT });
        // Legacy mode: the default run opens a blank page via `context.newPage()`, which Electron does not support.
        let builder = new AxeBuilder({ page })
          .setLegacyMode(true)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
        for (const sel of THIRD_PARTY) builder = builder.exclude(sel);
        const results = await builder.analyze();
        const summary = results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
        }));
        expect(summary, `${state.name}: ${JSON.stringify(summary, null, 2)}`).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }
});
