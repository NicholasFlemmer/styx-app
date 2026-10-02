/**
 * Gemini CLI through the Agent Client Protocol (ADR-0017). The fake `gemini` in e2e/fixtures/bin (first on PATH,
 * see launch.ts) speaks ACP over stdio: a spawned session streams `pong`, then a command asks for permission — the
 * ask shows in the chat as needs-you and allowing it completes the turn. Switching the permission mode from the
 * composer goes to the agent as `session/set_mode`: in YOLO the next turn's command runs without an ask.
 * Neither real CLI is installed on the verifying machine; this is the runner's end-to-end proof.
 */
import type { CliInstall } from '@styx/core';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

test('a Gemini session runs over ACP: pong, a permission ask, the allowed command, and a live mode switch', async () => {
  const { app, page } = await launchStyx({ screen: 'agents', fixture: 'demo', theme: 'dark', chrome: 'mac' });
  try {
    await page.locator('[data-screen-ready="agents"]').waitFor({ state: 'attached', timeout: 20_000 });

    // The demo rows name binaries this machine does not have (and fixtures are never re-detected on their own):
    // re-detect so the fake `gemini` on PATH takes over, with `--acp` read off its --help.
    const detected = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('detect.clis', {}),
    );
    const gemini = ((detected.value as { clis: CliInstall[] }).clis ?? []).find((c) => c.agent === 'gemini');
    expect(gemini?.binary ?? '').toMatch(/e2e[/\\]fixtures[/\\]bin[/\\]gemini(\.cmd)?$/);
    expect(gemini?.capabilities['acp']).toBe(true);
    expect(gemini?.version).toBe('0.39.1');

    // Spawn a Gemini session with a first message.
    await page.getByRole('button', { name: '+ Spawn agent' }).click();
    const modal = page.locator('[data-spawn-modal]');
    await expect(modal).toBeVisible();
    await modal.locator('[data-agent="gemini"]').click();
    await modal.getByLabel('First message').fill('hi');
    // The footer sits outside the modal body's hook, inside the dialog.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Spawn/ })
      .click();

    const chat = page.locator('[data-chat-pane]');
    await expect(chat).toBeVisible({ timeout: 20_000 });
    await expect(chat.locator('[data-kind="user"]').filter({ hasText: 'hi' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-kind="agent"]').filter({ hasText: 'pong' })).toBeVisible({
      timeout: 20_000,
    });

    // The agent's `session/request_permission` is a Styx ask: needs-you in the chat, Allow / Deny on the card.
    const decision = chat.locator('[data-kind="decision"]');
    await expect(decision).toBeVisible({ timeout: 20_000 });
    await expect(decision).toContainText('Bash: echo pong');
    await expect(chat.locator('[data-lane-meta]')).toContainText('waiting on you');
    await decision.getByRole('button', { name: 'Allow' }).click();

    // Allowed: the step settles in plain words (ADR-0027 §4), the agent's closing text lands, the turn is over.
    const tool = chat.locator('[data-kind="steps"] li[data-status="ok"]');
    await expect(tool).toBeVisible({ timeout: 20_000 });
    await expect(tool).toContainText('Ran echo pong');
    await expect(
      chat.locator('[data-kind="agent"]').filter({ hasText: 'the command printed pong' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(chat.locator('[data-lane-meta]')).not.toContainText('waiting on you', { timeout: 20_000 });
    // The agent's slash commands (available_commands_update) reached the session.
    const snapshot = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('store.snapshot', {}),
    );
    const session = (
      snapshot.value as { sessions: { id: string; agent: string; slashCommands: string[]; runner: string }[] }
    ).sessions.find((s) => s.agent === 'gemini' && s.runner === 'stream' && s.slashCommands.length > 0);
    expect(session?.slashCommands).toEqual(['/help', '/memory']);

    // Permission mode switch. The composer's controls row is hidden under the e2e harness (ChatPane keeps the
    // prototype-baked workspace baseline), so this dispatches what its Permissions select dispatches:
    // `session.configure {permissionMode}` → Bypass → Gemini's `yolo` over `session/set_mode`, no error row.
    const configured = await page.evaluate(
      (sessionId) =>
        (window as unknown as StyxWindow).styx.command('session.configure', {
          sessionId,
          permissionMode: 'bypassPermissions',
        }),
      session?.id,
    );
    expect(configured.ok).toBe(true);
    await expect(
      chat.locator('[data-kind="system"]').filter({ hasText: 'permissions: Bypass permissions' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      chat.locator('[data-kind="system"]').filter({ hasText: /error|refused|no equivalent/ }),
    ).toHaveCount(0);

    // In YOLO the fake agent no longer asks: the second turn's command runs straight through.
    const composer = chat.getByRole('textbox', { name: /^Message Gemini/ });
    await composer.fill('again');
    await composer.press('Enter');
    await expect(chat.locator('[data-kind="user"]').filter({ hasText: 'again' })).toBeVisible({
      timeout: 20_000,
    });
    // The first turn folds to a receipt once the second settles (ADR-0027 §3); the second's step is listed.
    await expect(chat.locator('[data-kind="receipt"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(chat.locator('[data-kind="steps"] li[data-status="ok"]')).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(chat.locator('[data-lane-meta]')).not.toContainText('waiting on you');
  } finally {
    await app.close();
  }
});
