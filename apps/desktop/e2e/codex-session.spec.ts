/**
 * Codex through `codex app-server` (ADR-0016). The fake `codex` in e2e/fixtures/bin (first on PATH, see launch.ts)
 * speaks the protocol: a spawned session streams `pong`, then a command asks for approval — the ask shows in the
 * chat as needs-you, allowing it completes the turn, and the meta line shows tokens. Settings › Agents › Verify
 * reads the account through the same app-server (`account/read`).
 */
import type { CliInstall } from '@styx/core';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

test('a Codex session runs through the app-server: pong, an approval ask, tokens, and Verify names the account', async () => {
  const { app, page } = await launchStyx({ screen: 'agents', fixture: 'demo', theme: 'dark', chrome: 'mac' });
  try {
    await page.locator('[data-screen-ready="agents"]').waitFor({ state: 'attached', timeout: 20_000 });

    // The demo rows name binaries this machine does not have (and fixtures are never re-detected on their own):
    // re-detect so the fake `codex` on PATH takes over, with `app-server` read off its --help.
    const detected = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('detect.clis', {}),
    );
    const codex = ((detected.value as { clis: CliInstall[] }).clis ?? []).find((c) => c.agent === 'codex');
    expect(codex?.binary ?? '').toMatch(/e2e[/\\]fixtures[/\\]bin[/\\]codex$/);
    expect(codex?.capabilities['appServer']).toBe(true);
    expect(codex?.version).toBe('0.154.0');

    // Spawn a Codex session with a first message.
    await page.getByRole('button', { name: '+ Spawn agent' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-spawn-modal]')).toBeVisible();
    await dialog.locator('[data-agent="codex"]').click();
    await dialog.getByLabel('First message').fill('hi');
    // The Spawn button sits in the dialog footer, outside the modal body.
    await dialog.getByRole('button', { name: /^Spawn/ }).click();

    const chat = page.locator('[data-chat-pane]');
    await expect(chat).toBeVisible({ timeout: 20_000 });
    await expect(chat.locator('[data-kind="user"]').filter({ hasText: 'hi' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-kind="agent"]').filter({ hasText: 'pong' })).toBeVisible({
      timeout: 20_000,
    });

    // The command approval is an ask: the chat says needs-you, the card offers Allow / Deny.
    const decision = chat.locator('[data-kind="decision"]');
    await expect(decision).toBeVisible({ timeout: 20_000 });
    await expect(decision).toContainText('Bash: echo hi');
    await expect(chat.locator('[data-chat-meta]')).toContainText('waiting on you');
    await decision.getByRole('button', { name: 'Allow' }).click();

    // Allowed: the command runs, its row settles, the turn ends with token usage on the meta line.
    await expect(chat.locator('[data-kind="tool"][data-status="ok"]')).toBeVisible({ timeout: 20_000 });
    const tool = chat.locator('[data-kind="tool"]');
    await expect(tool).toContainText('Bash');
    await expect(tool).toContainText('echo hi');
    // The result detail is the command's output tail.
    await expect(tool).toContainText('hi');
    await expect(chat.locator('[data-chat-meta]')).toContainText('tokens', { timeout: 20_000 });
    await expect(chat.locator('[data-chat-meta]')).not.toContainText('waiting on you');

    // Settings › Agents: Verify goes through the app-server and shows `email · plan`.
    await page.click('[data-app-rail-item=\"app:agents\"]');
    const row = page.locator('[data-agent-row="codex"]');
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /^Verify · Codex/ }).click();
    await expect(row).toContainText('nic@fake.dev · team', { timeout: 20_000 });
    await expect(row).toHaveAttribute('data-agent-state', 'connected');
  } finally {
    await app.close();
  }
});
