/**
 * Tour: talk to an agent while it works. A Codex task is mid-turn (it has said what it did and waits on a command);
 * a message typed into the chat goes straight into the running turn, and Codex answers it without starting over.
 */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: message an agent mid-turn', async () => {
  const t = await startTour('steer', {
    screen: 'workspace',
    env: {
      STYX_DEMO_REPOS: '1',
      STYX_FAKE_CODEX_COMMAND: 'pnpm test checkout',
      STYX_FAKE_CODEX_REPLY: 'Moved the coupon field above the total. Running the checkout tests.',
    },
  });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await steps.detectClis(page);
    await steps.foldTerminal(page);
    await steps.startTask(page, 'Move the coupon field above the total', 'codex');
    await steps.card(page, 'Move the coupon field above the total').click();
    const chat = page.locator('[data-chat-pane]');
    const log = chat.locator('[role="log"]');
    const reply = log.locator('[data-kind="agent"]').last();
    const decision = log.locator('[data-kind="decision"]').last();
    // The scripted turn now waits on its command: the agent is mid-turn.
    await expect(decision).toBeVisible({ timeout: 20_000 });
    await steps.quietToasts(page);
    await steps.restPointer(page);
    await t.reach('mid-turn', log, { reply, decision });

    const field = chat.getByRole('textbox', { name: /^Message Codex/ });
    const send = chat.locator('[data-composer-send]');
    const composer = field.locator('xpath=ancestor::div[.//*[@data-composer-send]][1]');
    await t.reach('composer', composer, { field, send });
    await field.fill('Also keep the total in view on phones');
    await steps.restPointer(page);
    await t.reach('composer-typed', composer, { field, send });
    await field.press('Enter');

    // Codex takes the message into the same turn and answers it; nothing waits in a queue.
    const mine = log.locator('[data-kind="user"]').filter({ hasText: 'Also keep the total in view' });
    const steered = log.locator('[data-kind="agent"]').filter({ hasText: 'steered: Also keep the total' });
    await expect(steered).toBeVisible({ timeout: 20_000 });
    await expect(chat.locator('[data-queued]')).toHaveCount(0);
    await steps.quietToasts(page);
    await steps.restPointer(page);
    await t.reach('steered', log, { mine, steered, decision });
  } finally {
    await t.close();
  }
});
