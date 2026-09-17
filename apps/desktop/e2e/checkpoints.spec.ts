/**
 * Turn checkpoints (ADR-0020). The fake `codex` (e2e/fixtures/bin) turns a `write <name>` prompt into a command
 * that really writes the file once allowed, so a Codex session's first turn leaves one new file in its worktree:
 * the turn settles into a checkpoint row under the reply, Review shows the patch on the Diff screen, and a
 * confirmed "Revert this turn" deletes the file again — with nothing committed on the branch.
 */
import type { CliInstall, Session, Worktree } from '@styx/core';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('a turn that writes a file becomes a checkpoint row; Review shows its patch; Revert this turn restores the worktree', async () => {
  const { app, page } = await launchStyx({ screen: 'agents', fixture: 'demo', theme: 'dark', chrome: 'mac' });
  try {
    await page.locator('[data-screen-ready="agents"]').waitFor({ state: 'attached', timeout: 20_000 });
    // The demo rows name binaries this machine does not have: re-detect so the fake `codex` on PATH takes over.
    const detected = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('detect.clis', {}),
    );
    const codex = ((detected.value as { clis: CliInstall[] }).clis ?? []).find((c) => c.agent === 'codex');
    expect(codex?.binary ?? '').toMatch(/e2e[/\\]fixtures[/\\]bin[/\\]codex$/);

    await page.getByRole('button', { name: '+ Spawn agent' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-spawn-modal]')).toBeVisible();
    await dialog.locator('[data-agent="codex"]').click();
    await dialog.getByLabel('First message').fill('write notes.txt');
    await dialog.getByRole('button', { name: /^Spawn/ }).click();

    const chat = page.locator('[data-chat-pane]');
    await expect(chat).toBeVisible({ timeout: 20_000 });
    const decision = chat.locator('[data-kind="decision"]');
    await expect(decision).toBeVisible({ timeout: 20_000 });
    await expect(decision).toContainText('echo hi > notes.txt');
    await decision.getByRole('button', { name: 'Allow' }).click();

    // The turn settles: one file changed, said in the chat and as the checkpoint row under the reply.
    await expect(
      chat.locator('[data-kind="system"]').filter({ hasText: 'Turn 1: 1 files changed.' }),
    ).toBeVisible({
      timeout: 20_000,
    });
    const row = chat.locator('[data-kind="checkpoint"][data-turn="1"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Turn 1 · 1 files · +1 −0');

    // Where the session works, straight from main: the file is there, the branch has no new commit, the refs do.
    const snapshot = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('store.snapshot', {}),
    );
    const { sessions, worktrees } = snapshot.value as { sessions: Session[]; worktrees: Worktree[] };
    const session = sessions.find((s) => s.agent === 'codex' && s.firstMessage === 'write notes.txt');
    const worktree = worktrees.find((w) => w.id === session?.worktreeId);
    if (session === undefined || worktree === undefined) throw new Error('codex session / worktree missing');
    expect(existsSync(join(worktree.path, 'notes.txt'))).toBe(true);
    const headBefore = git(['rev-parse', 'HEAD'], worktree.path);
    expect(
      git(['for-each-ref', '--format=%(refname)', `refs/styx/checkpoints/${session.id}/`], worktree.path),
    ).toBe(
      [`refs/styx/checkpoints/${session.id}/1/after`, `refs/styx/checkpoints/${session.id}/1/base`].join(
        '\n',
      ),
    );

    // Review: the Diff screen in checkpoint mode shows the patch read-only; Done comes back.
    await row.getByRole('button', { name: 'Review · Turn 1' }).click();
    const diff = page.locator('[data-diff-checkpoint]');
    await expect(diff).toBeVisible();
    await expect(diff.locator('[data-diff-meta]')).toContainText('Turn 1 · 1 files · +1 −0');
    await expect(diff.locator('[data-patch-file="notes.txt"]')).toContainText('+ hi', { timeout: 10_000 });
    await expect(diff.getByRole('button', { name: /Revert/ })).toHaveCount(0);
    await diff.getByRole('button', { name: 'Done' }).click();
    await expect(chat).toBeVisible();

    // Revert asks first, then restores the worktree: the file is gone, the row reads Reverted, HEAD is untouched.
    await row.getByRole('button', { name: 'Revert this turn · Turn 1' }).click();
    const ask = row.locator('[data-checkpoint-confirm]');
    await expect(ask).toContainText(
      'Restore the workspace to before turn 1? Later turns are undone too, along with any edits you made since, and files created since then are deleted.',
    );
    await ask.getByRole('button', { name: 'Revert this turn · Turn 1 · Yes' }).click();
    await expect(row).toHaveAttribute('data-reverted', 'true', { timeout: 20_000 });
    await expect(row).toContainText('Reverted');
    await expect(
      chat.locator('[data-kind="system"]').filter({ hasText: 'Workspace restored to before turn 1.' }),
    ).toBeVisible();
    expect(existsSync(join(worktree.path, 'notes.txt'))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], worktree.path)).toBe(headBefore);
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  } finally {
    await app.close();
  }
});
