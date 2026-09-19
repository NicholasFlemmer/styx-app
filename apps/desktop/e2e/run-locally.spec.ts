/**
 * "Run locally" (owner request, AI-native): the first click hands the job to the project's agent in chat (not
 * exercised here: it would launch a real agent), and once a command is learned the button runs it itself. The
 * seeded acme-shop repo gets a package.json whose `dev` script really listens and prints a localhost URL; main
 * must run the learned command through the login shell, sniff the URL into the status bar, and stop it on ■.
 */
import { fixtures } from '@styx/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('first time it asks the agent; a learned command runs, surfaces the URL in the status bar, and Stop ends it', async () => {
  const { app, page, userData } = await launchStyx({ screen: 'workspace', fixture: 'demo', theme: 'dark' });
  // The harness materialises the demo repos under userData at boot; the script is written after that — into the
  // lane the workspace shows (Claude's fix/checkout): Run locally looks and runs there (discrepancy #103).
  const repo = join(userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'fix-checkout');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'acme-shop',
        private: true,
        // A URL is only adopted once something answers on it, so the fixture really listens before it prints.
        scripts: {
          dev: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(3999,()=>console.log('ready http://localhost:3999'))"`,
        },
      },
      null,
      2,
    ),
  );

  await page.waitForSelector('[data-workspace-mode="design"]', { timeout: 10_000 });
  await page.click('[data-workspace-mode="design"]');

  // Nothing learned yet: no command field, a hint that names the agent, and an enabled button (it would spawn the
  // agent with the task; not clicked here because it would launch a real CLI).
  // The first click hands the job to a background task (ADR-0018): the hint no longer names the chat.
  await expect(page.locator('[data-run-first-time]')).toContainText(
    'Set up and start this project locally.',
    {
      timeout: 10_000,
    },
  );
  await expect(page.locator('[data-run-command]')).toHaveCount(0);
  await expect(page.locator('[data-run-start]')).toBeEnabled();

  // What `remember_command` ends up doing: the learned command lands in the project settings.
  await page.evaluate(
    (projectId) =>
      (
        window as unknown as { styx: { command: (name: string, input: unknown) => Promise<unknown> } }
      ).styx.command('project.settings.set', { projectId, patch: { devCommand: 'npm run dev' } }),
    fixtures.ids.project.acmeShop,
  );
  // `getByLabel('Command')` also matches the titlebar's "Open command palette"; the field carries its own hook.
  const command = page.locator('[data-run-command]');
  await expect(command).toHaveValue('npm run dev', { timeout: 10_000 });
  await expect(page.locator('[data-run-first-time]')).toHaveCount(0);

  await page.click('[data-run-start]');
  const strip = page.locator('[data-run-strip]');
  await expect(strip).toBeVisible({ timeout: 10_000 });
  const bar = page.locator('[data-status-bar]');
  await expect(bar).toContainText('dev · http://localhost:3999', { timeout: 20_000 });
  await expect(page.locator('[data-run-phase]')).toHaveText('Running · http://localhost:3999');
  // The URL the server printed is now the design window's URL.
  await expect(page.getByLabel('Dev server URL')).toHaveValue('http://localhost:3999');

  await page.click('[data-run-stop]');
  await expect(page.locator('[data-run-phase]')).toContainText('Exited', { timeout: 20_000 });
  await expect(bar).not.toContainText('dev ·');
  await expect(page.locator('[data-run-start]')).toBeVisible();

  await page.click('[data-run-dismiss]');
  await expect(strip).toHaveCount(0);

  await app.close();
});
