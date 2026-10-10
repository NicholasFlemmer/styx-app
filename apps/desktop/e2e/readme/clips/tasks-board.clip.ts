/**
 * Clip: several tasks side by side on the Tasks board. Two more tasks start from the board (one on Codex, one on
 * Claude Code), each on its own branch, and the one that needs you says so. The fake agent CLIs from
 * e2e/fixtures/bin answer, so nothing real runs. Each beat records where it happens on screen.
 */
import { expect, test, type Page } from '@playwright/test';
import { startScene } from './scene';

type StyxWindow = Window & { styx: { command: (name: string, input: unknown) => Promise<unknown> } };
const detectClis = (page: Page) =>
  page.evaluate(() => (window as unknown as StyxWindow).styx.command('detect.clis', {}));

test('clip: tasks-board', async () => {
  // The demo repos are created on disk here: starting a task makes a real worktree.
  const s = await startScene('tasks-board', { screen: 'workspace', env: { STYX_DEMO_REPOS: '1' } });
  const { page } = s;
  await page.waitForSelector('[data-screen-ready="workspace"]');
  // The demo names agent binaries this machine doesn't have: re-detect so the fakes on PATH take over.
  await detectClis(page);
  // More room for the board: the terminal under it folded (⏎ on its handle toggles it), before the cut starts.
  const split = page.getByRole('separator', { name: 'Terminal' });
  await split.focus();
  await page.keyboard.press('Enter');
  await split.blur();
  await s.moveTo(600, 300, 4);
  await s.hold(600);

  const add = page.locator('[data-tasks-add]');
  const card = (text: string) => page.locator('[data-tasks-card]').filter({ hasText: text });
  const toTop = () =>
    page.evaluate(() => document.querySelector('[data-tasks-card]')?.scrollIntoView({ block: 'start' }));
  const startTask = async (text: string, agent: string, beat: string) => {
    await add.scrollIntoViewIfNeeded();
    await s.hold(200);
    await s.beat(beat, add);
    await s.hold(500);
    const field = add.locator('[data-tasks-add-text]');
    await s.click(field, 250);
    await s.type(field, text);
    await add.locator('select').selectOption(agent);
    const go = add.locator('[data-tasks-add-start]');
    for (let i = 0; i < 10 && (await go.isDisabled()); i++) {
      await detectClis(page);
      await s.hold(300);
    }
    await s.hold(500);
    await s.click(go, 300);
    await expect(card(text)).toBeVisible({ timeout: 20_000 });
    await toTop();
    await s.hold(300);
    await s.beat(`${beat}-card`, card(text));
  };

  await s.beat('board', card('Fix the flaky order test'));
  const chip = await card('Fix the flaky order test').getByText('Your turn').boundingBox();
  if (chip) await s.moveTo(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await s.hold(2200);

  await startTask('Add a dark mode toggle to settings', 'codex', 'type-first');
  await s.hold(2000);

  await startTask('Write the release notes for 0.5', 'claude', 'type-second');
  await s.hold(1800);

  // The new Codex task wants to run a command: it's your turn there.
  const yours = card('dark mode');
  await s.beat('needs-you', yours);
  const turn = await yours.getByText('Your turn').boundingBox();
  if (turn) await s.moveTo(turn.x + turn.width / 2, turn.y + turn.height / 2);
  await s.hold(2800);
  await s.beat('end');
  await s.finish();
});
