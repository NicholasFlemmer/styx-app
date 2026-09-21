import { test } from '@playwright/test';
import { runSim } from './harness';

/** The harness's own check: the app boots on Home, the counters read, the palette answers the keyboard. */
test('sim: smoke', async () => {
  await runSim('smoke', { screen: 'home' }, async (sim) => {
    await sim.step('boots on Home with the four counters', async () => {
      await sim.page.waitForSelector('[data-screen-ready="home"]', { timeout: 15_000 });
      const text = await sim.page.locator('body').innerText();
      for (const label of ['Needs you', 'Agents working', 'Grants active', 'Projects'])
        if (!text.toLowerCase().includes(label.toLowerCase())) throw new Error(`missing counter ${label}`);
      return 'counters present';
    });
    await sim.step('the palette opens and closes with the keyboard', async () => {
      await sim.page.keyboard.press('Meta+K');
      await sim.page.waitForSelector('[role="combobox"], [data-palette]', { timeout: 5000 });
      await sim.page.keyboard.press('Escape');
    });
  });
});
