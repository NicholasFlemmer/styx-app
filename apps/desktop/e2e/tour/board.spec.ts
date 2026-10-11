/**
 * Tour: several agents on one board. Two more tasks start from the board (Codex and Claude Code, each on its own
 * branch); the Codex one needs you, says so on its card and in a toast, and carries on once its command is allowed.
 */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: tasks side by side, one needs you', async () => {
  // Starting a task makes a real worktree, so the demo repos are on disk here.
  const t = await startTour('board', {
    screen: 'workspace',
    env: {
      STYX_DEMO_REPOS: '1',
      // What the (fake) Codex does with the dark-mode task: says what it changed and asks to run the tests.
      STYX_FAKE_CODEX_COMMAND: 'pnpm test settings',
      STYX_FAKE_CODEX_REPLY:
        'Added a theme toggle to Settings and saved it per user. Running the settings tests.',
    },
  });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await steps.detectClis(page);
    await steps.foldTerminal(page);
    await steps.restPointer(page);
    const flaky = steps.card(page, 'Fix the flaky order test');
    const checkout = steps.card(page, 'Add input validation');
    const gemini = steps.card(page, 'Gemini, no task yet');
    await t.reach('board-three', steps.board(page), { flaky, checkout, gemini });
    await t.reach('card-flaky', flaky);
    await t.reach('card-checkout', checkout);
    await t.reach('card-gemini', gemini);
    const add = steps.addBox(page);
    await t.reach('add-box', add, {
      field: add.locator('[data-tasks-add-text]'),
      start: add.locator('[data-tasks-add-start]'),
      agent: add.locator('select'),
    });

    await steps.fillTask(page, 'Add a dark mode toggle to settings', 'codex');
    await steps.restPointer(page);
    await t.reach('add-box-typed', add, {
      field: add.locator('[data-tasks-add-text]'),
      start: add.locator('[data-tasks-add-start]'),
      agent: add.locator('select'),
    });
    await steps.pressStart(page, 'Add a dark mode toggle to settings');
    await steps.startTask(page, 'Write the release notes for 0.5', 'claude');
    const darkMode = steps.card(page, 'Add a dark mode toggle');
    const notes = steps.card(page, 'Write the release notes');
    // The Codex task asks to run a command: its card says it's your turn.
    await expect(darkMode.getByText('Your turn')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() =>
      document.querySelector('[data-tasks-card]')?.scrollIntoView({ block: 'start' }),
    );
    await steps.restPointer(page);
    await t.reach('card-dark-mode-yours', darkMode, { chip: darkMode.getByText('Your turn') });
    // Each task's own branch, named on its card.
    const branch = (card: typeof notes) => card.getByText(/^agent\/[a-z]+-\d+$/);
    await t.reach('card-release-notes', notes, { branch: branch(notes) });
    await t.reach('board-five', steps.board(page), { darkMode, notes });
    await t.reach('toast-needs-you', page.locator('[data-toast="needs-you"]').first());

    await darkMode.click();
    const decision = page.locator('[data-chat-pane] [data-kind="decision"]').last();
    await steps.restPointer(page);
    await t.reach('decision', decision, { allow: decision.getByRole('button', { name: 'Allow' }) });
    // The exchange: what the agent says it did, then the command it wants to run.
    await steps.quietToasts(page);
    await steps.restPointer(page);
    const log = page.locator('[data-chat-pane] [role="log"]');
    await t.reach('chat-decision', log, {
      reply: log.locator('[data-kind="agent"]').last(),
      decision,
      allow: decision.getByRole('button', { name: 'Allow' }),
    });
    await decision.getByRole('button', { name: 'Allow' }).click();
    await expect(darkMode.getByText('Your turn')).toHaveCount(0, { timeout: 20_000 });
    await steps.restPointer(page);
    await t.reach('card-dark-mode-after', darkMode, { branch: branch(darkMode) });
  } finally {
    await t.close();
  }
});
