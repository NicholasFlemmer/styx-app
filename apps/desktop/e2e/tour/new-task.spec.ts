/**
 * Tour: start a task from anywhere. New task on the home screen opens the New task page for a project: one box for
 * the task, the agents to pick from, and Start; the task then runs on its own branch.
 */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: new task from home', async () => {
  // Starting a task makes a real worktree, so the demo repos are on disk here.
  const t = await startTour('new-task', {
    screen: 'home',
    env: {
      STYX_DEMO_REPOS: '1',
      STYX_FAKE_CODEX_COMMAND: 'pnpm test checkout',
      STYX_FAKE_CODEX_REPLY: 'Added a loading state to the Pay button. Running the checkout tests.',
    },
  });
  try {
    const { page } = t;
    await steps.homeReady(page);
    // Re-detect the agents (the fakes on PATH) while the home screen is looked at.
    const detected = steps.detectClis(page);
    await steps.restPointer(page);
    const open = page.locator('[data-home-new-task]');
    const head = page.locator('header').filter({ has: open });
    await t.reach('home-head', head, { newTask: open });
    await steps.pressHold(page, open, () => t.reach('home-new-task-pressed', head, { newTask: open }));
    await detected;
    await open.click();

    const sheet = page.locator('[data-new-task]');
    const main = sheet.locator('section').first();
    const headline = main.getByRole('heading', { level: 2 });
    const field = sheet.locator('[data-new-task-text]');
    const start = sheet.locator('[data-new-task-start]');
    const agents = sheet.getByRole('radiogroup', { name: 'Agent' });
    const agent = (a: string) => agents.locator(`[role="radio"][data-agent="${a}"]`);
    await expect(field).toBeVisible();
    await steps.restPointer(page);
    await t.reach('new-task', main, { headline, field, start, agents });
    await t.reach('agents', agents, {
      claude: agent('claude'),
      codex: agent('codex'),
      gemini: agent('gemini'),
      cursor: agent('cursor'),
    });
    await agent('codex').click();
    await expect(agent('codex')).toHaveAttribute('aria-checked', 'true');
    await steps.restPointer(page);
    await t.reach('agents-codex', agents, { codex: agent('codex') });

    const box = field.locator('xpath=ancestor::div[.//*[@data-new-task-start]][1]');
    await field.blur();
    await t.reach('box', box, { field, start });
    await field.fill('Add a loading state to the Pay button');
    await steps.restPointer(page);
    await t.reach('box-typed', box, { field, start });
    await steps.pressHold(page, start, () => t.reach('start-pressed', box, { field, start }));
    await start.click();

    // The task is running in its own lane: its chat opens on what the agent says.
    const chat = page.locator('[data-chat-pane]');
    const reply = chat.locator('[data-kind="agent"]').filter({ hasText: 'Added a loading state' });
    await expect(reply).toBeVisible({ timeout: 20_000 });
    await steps.quietToasts(page);
    await steps.restPointer(page);
    await t.reach('started', chat.locator('[role="log"]'), {
      task: chat.locator('[data-kind="user"]').first(),
      reply,
    });
  } finally {
    await t.close();
  }
});
