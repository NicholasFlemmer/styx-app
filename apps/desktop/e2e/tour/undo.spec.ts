/**
 * Tour: undo one turn. A Codex task edits checkout.css and runs the tests; the turn settles into a result row (what
 * changed, Show changes, Undo this turn); Undo asks first, then takes that turn back and keeps the rest.
 */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: undo one turn', async () => {
  const t = await startTour('undo', {
    screen: 'workspace',
    env: {
      STYX_DEMO_REPOS: '1',
      STYX_FAKE_CODEX_COMMAND: 'pnpm test checkout',
      STYX_FAKE_CODEX_OUTPUT: '✓ 18 passed (0.9s)',
      STYX_FAKE_CODEX_REPLY: 'Made the Pay button full width on phones. Running the checkout tests.',
      STYX_FAKE_CODEX_WRITES: 'checkout.css',
      STYX_FAKE_CODEX_WRITE_TEXT: '@media (max-width: 480px) { .pay { width: 100%; } }',
    },
  });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await steps.detectClis(page);
    await steps.foldTerminal(page);
    await steps.startTask(page, 'Make the Pay button full width on phones', 'codex');
    await steps.card(page, 'Make the Pay button full width').click();
    const chat = page.locator('[data-chat-pane]');
    const decision = chat.locator('[data-kind="decision"]').last();
    await decision.getByRole('button', { name: 'Allow' }).click();
    const row = chat.locator('[data-kind="turn-result"]').last();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await steps.quietToasts(page);
    await steps.restPointer(page);
    const undo = row.getByRole('button', { name: 'Undo this turn' });
    await t.reach('turn-result', row, { undo, show: row.getByRole('button', { name: 'Show changes' }) });
    // The same turn on the Changes page, ready to land; Land held (released off the button, so nothing lands).
    await page.click('[data-workspace-mode="changes"]');
    const changes = page.locator('[data-changes-page]');
    const land = page.getByRole('button', { name: 'Land', exact: true }).first();
    await steps.restPointer(page);
    await t.reach('changes-turn', changes, { turn: changes.locator('[data-changes-turn]').first(), land });
    await steps.pressHold(page, land, () => t.reach('land-pressed', changes, { land }));
    await undo.click();
    const ask = row.locator('[data-turn-confirm]');
    await steps.restPointer(page);
    await t.reach('undo-confirm', row, { confirm: ask.getByRole('button', { name: 'Undo it' }) });
    await ask.getByRole('button', { name: 'Undo it' }).click();
    await expect(row).toContainText('Undone', { timeout: 20_000 });
    await steps.restPointer(page);
    await t.reach('undone', row);
  } finally {
    await t.close();
  }
});
