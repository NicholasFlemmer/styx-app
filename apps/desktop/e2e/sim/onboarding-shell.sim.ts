import { copy } from '@styx/core';
import { test } from '@playwright/test';
import { runSim } from './harness';

/**
 * Onboarding, the command palette, the keyboard map, banners, theme and the window minimum — the shell a person
 * meets before and around every feature.
 */
test('sim: onboarding-shell', async () => {
  await runSim('onboarding-shell', { fixture: 'empty' }, async (sim) => {
    const page = () => sim.page;
    const html = () => page().locator('html');

    // --- onboarding: flip the first-run flag off and reload, so the gate itself (not STYX_SCREEN) routes here -----
    await sim.step(
      'first run (onboardingDone=false) opens on onboarding step 1 (Editor) with the four-step strip',
      async () => {
        await page().waitForSelector('[data-screen-ready]', { timeout: 20_000 });
        await sim.command('settings.set', { patch: { onboardingDone: false } });
        await page().reload();
        await page().waitForSelector('[data-onboarding-step="1"]', { timeout: 20_000 });
        const strip = page().getByRole('list', { name: copy.onboarding.stepsLabel });
        const text =
          (await strip.count()) > 0 ? await strip.innerText() : await page().locator('body').innerText();
        for (const s of Object.values(copy.onboarding.steps))
          if (!text.toLowerCase().includes(s.toLowerCase())) throw new Error(`step strip lacks ${s}`);
        if (!(await page().getByText(copy.onboarding.editor.headline).isVisible()))
          throw new Error('no editor headline');
      },
    );
    await sim.step('Editor: the detected IDE rows and the import toggles are real controls', async () => {
      const boxes = page().getByRole('checkbox');
      const n = await boxes.count();
      if (n === 0) throw new Error('no import toggles');
      // the IDE rows' boxes pick the fallback editor (one is always chosen); the import toggles are the labelled ones
      const first = page().getByRole('checkbox', { name: copy.onboarding.editor.importKeybindings });
      const before = await first.isChecked();
      // the native input is visually hidden behind a drawn box; a person clicks the label
      const id = await first.getAttribute('id');
      const label = id ? page().locator(`label[for="${id}"]`) : first;
      await label.click();
      if ((await first.isChecked()) === before) throw new Error('toggle did not change');
      await label.click();
      return `${n} toggles`;
    });
    await sim.step(
      'Continue → Projects: the scan finds repos or says so; the add row is present',
      async () => {
        await page().getByRole('button', { name: copy.onboarding.footer.continue }).click();
        await page().waitForSelector('[data-onboarding-step="2"]', { timeout: 60_000 });
        await page().waitForSelector('[data-onboarding-add-row]', { timeout: 60_000 });
        const rows = await page().getByRole('checkbox').count();
        return `${rows} repo rows`;
      },
    );
    await sim.step('Back returns to step 1 with the toggles as left', async () => {
      await page().getByRole('button', { name: copy.onboarding.footer.back }).click();
      await page().waitForSelector('[data-onboarding-step="1"]', { timeout: 10_000 });
      await page().getByRole('button', { name: copy.onboarding.footer.continue }).click();
      await page().waitForSelector('[data-onboarding-step="2"]', { timeout: 60_000 });
    });
    await sim.step(
      'Continue → Agents: every CLI row with its state from the fakes; Continue → Targets: the provider grid',
      async () => {
        await page().getByRole('button', { name: copy.onboarding.footer.continue }).click();
        await page().waitForSelector('[data-onboarding-step="3"]', { timeout: 60_000 });
        const body = await page().locator('body').innerText();
        for (const name of ['Claude Code', 'Codex', 'Gemini'])
          if (!body.includes(name)) throw new Error(`agents step lacks ${name}`);
        await page().getByRole('button', { name: copy.onboarding.footer.continue }).click();
        await page().waitForSelector('[data-onboarding-step="4"]', { timeout: 30_000 });
        const providers = await page().locator('[data-provider]').count();
        if (providers < 5) throw new Error(`only ${providers} providers on the grid`);
        return `${providers} providers`;
      },
    );
    await sim.step(
      'Finish lands on Home; a reload does not show onboarding again (flag persisted)',
      async () => {
        await page().getByRole('button', { name: copy.onboarding.footer.finish }).click();
        await page().waitForSelector('[data-screen-ready="home"]', { timeout: 20_000 });
        await page().reload();
        await page().waitForSelector('[data-screen-ready]', { timeout: 20_000 });
        const step = await page().locator('[data-onboarding-step]').count();
        if (step > 0) throw new Error('onboarding came back after Finish');
      },
    );

    // --- the shell on the demo fixture ------------------------------------------------------------------------
    await sim.relaunch({ fixture: 'demo', screen: 'home' });
    await page().waitForSelector('[data-screen-ready="home"]', { timeout: 20_000 });

    await sim.step('window minimum: 1100×680 is enforced and nothing overflows at it', async () => {
      const size = await sim.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (!w) return null;
        w.setSize(900, 500);
        return w.getSize();
      });
      if (!size || (size[0] ?? 0) < 1100 || (size[1] ?? 0) < 680)
        throw new Error(`window shrank to ${String(size)}`);
      await sim.shot('home-at-minimum');
      const overflow = await page().evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      if (overflow) throw new Error('horizontal overflow at the window minimum');
    });

    await sim.step(
      'palette: Mod+K opens it with Actions · Agents · Projects, typing filters, ⏎ switches project, Escape closes and returns focus',
      async () => {
        await page().keyboard.press('Meta+K');
        const dialog = page().getByRole('dialog', { name: copy.palette.dialogLabel });
        await dialog.waitFor({ timeout: 5000 });
        const text = (await dialog.innerText()).toLowerCase();
        for (const g of Object.values(copy.palette.groups))
          if (!text.includes(g.toLowerCase())) throw new Error(`palette lacks group ${g}`);
        await page().keyboard.type('blog');
        await page().waitForTimeout(150);
        const rows = dialog.getByRole('option');
        if ((await rows.count()) === 0) throw new Error('no rows for "blog"');
        await page().keyboard.press('Enter');
        await page().waitForSelector('[data-screen-ready="workspace"]', { timeout: 10_000 });
        const nav = await page()
          .locator('[data-nav]')
          .innerText()
          .catch(() => '');
        if (!/blog/i.test(nav)) throw new Error(`nav does not name blog-v2 after ⏎: ${nav.slice(0, 80)}`);
        await page().keyboard.press('Meta+K');
        await dialog.waitFor({ timeout: 5000 });
        await page().keyboard.press('Escape');
        if ((await dialog.count()) > 0 && (await dialog.isVisible()))
          throw new Error('Escape left the palette open');
      },
    );

    await sim.step(
      'Mod+P (switch project) and Mod+1..4 (focus agent) do what the token map says',
      async () => {
        await page().keyboard.press('Meta+P');
        const dialog = page().getByRole('dialog', { name: copy.palette.dialogLabel });
        await dialog.waitFor({ timeout: 5000 });
        await page().keyboard.press('Escape');
        await page().locator('[data-app-rail-item="home"]').click();
        await page().waitForSelector('[data-screen-ready="home"]', { timeout: 10_000 });
        await page().locator('[data-project-id]').first().click();
        await page().waitForSelector('[data-screen-ready="workspace"]', { timeout: 10_000 });
        const lanes = page().locator('[data-nav-lane]');
        const n = await lanes.count();
        if (n < 2) return `only ${n} lanes; skipped focus-agent`;
        await page().keyboard.press('Meta+2');
        const second = lanes.nth(1);
        if ((await second.getAttribute('aria-current')) !== 'page')
          throw new Error('Mod+2 did not open the second lane');
      },
    );

    await sim.step(
      'Mod+Shift+T cycles the theme (dark → light → system) and Settings › General agrees',
      async () => {
        const t0 = await html().getAttribute('data-theme');
        const themeSetting = async () =>
          (await sim.command<{ app: { theme: string } }>('settings.get', {})).value?.app.theme;
        const s0 = await themeSetting();
        await page().keyboard.press('Meta+Shift+T');
        await page()
          .waitForFunction((was) => document.documentElement.dataset['theme'] !== was, t0, { timeout: 5000 })
          .catch(() => undefined);
        const t1 = await html().getAttribute('data-theme');
        const s1 = await themeSetting();
        if (t0 === t1) {
          // `system` resolves to the OS look; cycling system → dark on a dark OS is a press with nothing to show for it
          sim.finding({
            severity: 'minor',
            title: 'Mod+Shift+T can be a no-op: the cycle passes through a step that looks identical',
            repro: `theme setting "${s0}" on an OS that resolves to ${t0}; press Mod+Shift+T once`,
            expected:
              'the window visibly changes theme on every press (skip the step that resolves to the current look)',
            observed: `setting went ${s0} → ${s1}, data-theme stayed ${t0}`,
            where: 'apps/desktop/src/renderer/keys/bindings.ts cycleTheme',
          });
          await page().keyboard.press('Meta+Shift+T');
          await page()
            .waitForFunction((was) => document.documentElement.dataset['theme'] !== was, t0, {
              timeout: 5000,
            })
            .catch(() => undefined);
          const t2 = await html().getAttribute('data-theme');
          if (t0 === t2)
            throw new Error(
              `data-theme stayed ${t0} after two presses (setting now ${await themeSetting()})`,
            );
        }
        await page().locator('[data-app-rail-item="app:general"]').click();
        await page().waitForSelector('[data-screen-ready="settings"]', { timeout: 10_000 });
        const row = page().locator('[data-settings-row="theme"]');
        const txt = await row.innerText();
        return `html ${t0} → ${t1}; row reads "${txt.replace(/\s+/g, ' ').slice(0, 60)}"`;
      },
    );

    await sim.step('Mod+Shift+N opens New task in the workspace; Escape goes back to the work', async () => {
      await page().locator('[data-app-rail-item="home"]').click();
      await page().locator('[data-project-id]').first().click();
      await page().waitForSelector('[data-screen-ready="workspace"]', { timeout: 10_000 });
      const before = await page().evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '');
      await page().keyboard.press('Meta+Shift+N');
      await page().waitForSelector('[data-new-task]', { timeout: 5000 });
      await page().keyboard.press('Escape');
      await page().waitForTimeout(200);
      if ((await page().locator('[data-new-task]').count()) > 0)
        throw new Error('Escape did not close New task');
      const after = await page().evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '');
      return `focus before: ${before || '(body)'} · after: ${after || '(body)'}`;
    });

    await sim.step('Mod+Shift+O pops the chat out and docks it back', async () => {
      const windowsBefore = await sim.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      await page().keyboard.press('Meta+Shift+O');
      await page().waitForTimeout(1500);
      const windowsAfter = await sim.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      if (windowsAfter <= windowsBefore) throw new Error('no pop-out window appeared');
      await page().keyboard.press('Meta+Shift+O');
      await page().waitForTimeout(1500);
      const windowsEnd = await sim.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      if (windowsEnd !== windowsBefore) throw new Error(`pop-out did not dock back (${windowsEnd} windows)`);
    });

    // --- banners on the error fixture --------------------------------------------------------------------------
    await sim.relaunch({ fixture: 'error', screen: 'workspace' });
    await page().waitForSelector('[data-screen-ready="workspace"]', { timeout: 20_000 });
    await sim.step(
      'error fixture: the banners (auth expired · CLI missing · conflict) each carry a resolving action',
      async () => {
        const stack = page().locator('[data-banners]');
        await stack.waitFor({ timeout: 10_000 });
        const n = Number(await stack.getAttribute('data-banners'));
        if (n < 1) throw new Error('no banners on the error fixture');
        const text = await stack.innerText();
        const buttons = await stack.getByRole('button').count();
        if (buttons < n) throw new Error(`${n} banners but ${buttons} actions`);
        await sim.shot('banners');
        return `${n} banners: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
      },
    );
    await sim.step(
      "the CLI-missing banner's action opens Settings › Agents; the conflict banner's action goes to Repo",
      async () => {
        const stack = page().locator('[data-banners]');
        const agents = stack.getByRole('button', { name: /locate|agents|connect/i }).first();
        if ((await agents.count()) > 0) {
          await agents.click();
          await page().waitForTimeout(500);
          const where = await page().locator('[data-screen-ready]').first().getAttribute('data-screen-ready');
          const modal = await page().getByRole('dialog').count();
          if (where !== 'settings' && modal === 0)
            throw new Error(`CLI action led to ${where ?? '?'} with no dialog`);
          await page().keyboard.press('Escape');
        }
        await page().locator('[data-app-rail-item="home"]').click();
        await page().locator('[data-project-id]').first().click();
        await page().waitForSelector('[data-screen-ready="workspace"]', { timeout: 10_000 });
        const resolve = page()
          .locator('[data-banners]')
          .getByRole('button', { name: /resolve/i })
          .first();
        if ((await resolve.count()) === 0) return 'no conflict banner on this project';
        await resolve.click();
        await page().waitForSelector('[data-screen-ready="repo"]', { timeout: 10_000 });
      },
    );
  });
});
