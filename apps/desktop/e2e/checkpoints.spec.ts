/**
 * Turn checkpoints (ADR-0020). The fake `codex` (e2e/fixtures/bin) turns a `write <name>` prompt into a command
 * that really writes the file once allowed, so a Codex session's first turn leaves one new file in its worktree:
 * the turn settles into a checkpoint row under the reply, Review shows the patch on the Diff screen, and a
 * confirmed "Revert this turn" deletes the file again — with nothing committed on the branch.
 */
import { fixtures, type Checkpoint, type CliInstall, type Session, type Worktree } from '@styx/core';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A `dev` script that really serves a page on 3998 and prints its URL once it listens (run-locally.spec.ts). */
const DEV_PORT = 3998;
const DEV_SCRIPT = `node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'Content-Type':'text/html'});s.end('<html><head><title>Acme Shop</title></head><body><h1>ACME SHOP</h1></body></html>')}).listen(${DEV_PORT},()=>console.log('ready http://localhost:${DEV_PORT}'))"`;

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

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

/**
 * Screens (owner request: the design window as a simulator). With the project's dev server running in the design
 * window, a turn's checkpoint keeps a picture of the page as it was before the turn and once it settled, and
 * Review shows them as Before / After. The web path is exercised here; a mirrored simulator has no Xcode on this
 * machine and is unit-tested. The `write` turn is the session's second one so that both captures happen with the
 * design tab showing and no overlay open (the spawn modal covers the native view while the first turn starts).
 */
test('a turn keeps the design window page before and after; Review shows Before / After', async () => {
  const { app, page, userData } = await launchStyx({
    screen: 'workspace',
    fixture: 'demo',
    theme: 'dark',
    chrome: 'mac',
  });
  try {
    const repo = join(userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'fix-checkout');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'acme-shop', private: true, scripts: { dev: DEV_SCRIPT } }, null, 2),
    );
    await page.waitForSelector('[data-workspace-mode="design"]', { timeout: 10_000 });
    await page.click('[data-workspace-mode="design"]');
    await page.evaluate(
      (projectId) =>
        (window as unknown as StyxWindow).styx.command('project.settings.set', {
          projectId,
          patch: { devCommand: 'npm run dev' },
        }),
      fixtures.ids.project.acmeShop,
    );
    await expect(page.locator('[data-run-command]')).toHaveValue('npm run dev', { timeout: 10_000 });
    await page.click('[data-run-start]');
    await expect(page.getByLabel('Dev server URL')).toHaveValue(`http://localhost:${DEV_PORT}`, {
      timeout: 20_000,
    });
    // The native view has the page once its title arrives; the "waiting" placeholder is gone by then.
    const view = () =>
      app.evaluate(
        ({ webContents }, port: number) =>
          webContents
            .getAllWebContents()
            .find((w) => w.getURL().includes(String(port)))
            ?.getTitle() ?? null,
        DEV_PORT,
      );
    await expect.poll(view, { timeout: 20_000 }).toBe('Acme Shop');
    await expect(page.locator('[data-preview-status]')).toHaveCount(0);

    // A precondition, measured rather than assumed: `capturePage` on the WebContentsView yields pixels while it is
    // shown — and also while an overlay hides it (the palette; `setVisible(false)`), which is what lets a first
    // turn's `before` land while the spawn modal is still up. Only the shown case is asserted; the hidden one is
    // recorded with the run.
    const capture = () =>
      app.evaluate(async ({ webContents }, port: number) => {
        const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
        if (w === undefined) return null;
        const img = await w.capturePage();
        return { empty: img.isEmpty(), ...img.getSize() };
      }, DEV_PORT);
    const shown = await capture();
    await page.keyboard.press('Meta+K');
    await expect(page.getByRole('dialog')).toBeVisible();
    const hidden = await capture();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    test.info().annotations.push({ type: 'capturePage', description: JSON.stringify({ shown, hidden }) });
    expect(shown?.empty).toBe(false);

    // Spawn Codex from the chat pane; the first turn is plain so it settles without a checkpoint row.
    await page.evaluate(() => (window as unknown as StyxWindow).styx.command('detect.clis', {}));
    const chat = page.locator('[data-chat-pane]');
    await chat.getByRole('button', { name: 'Spawn agent' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-spawn-modal]')).toBeVisible();
    await dialog.locator('[data-agent="codex"]').click();
    await dialog.getByLabel('First message').fill('hi');
    await dialog.getByRole('button', { name: /^Spawn/ }).click();
    await expect(dialog).toHaveCount(0);
    const decision = chat.locator('[data-kind="decision"]');
    await expect(decision).toBeVisible({ timeout: 20_000 });
    await decision.getByRole('button', { name: 'Allow' }).click();
    await expect(chat.locator('[data-kind="tool"][data-status="ok"]')).toBeVisible({ timeout: 20_000 });
    const snapshot = async () =>
      (await page.evaluate(() => (window as unknown as StyxWindow).styx.command('store.snapshot', {})))
        .value as { sessions: Session[]; checkpoints: Record<string, Checkpoint[]> };
    const codexSession = async () =>
      (await snapshot()).sessions.find((s) => s.agent === 'codex' && s.firstMessage === 'hi') ?? null;
    await expect.poll(async () => (await codexSession())?.state ?? null, { timeout: 20_000 }).toBe('idle');
    const session = await codexSession();
    if (session === null) throw new Error('codex session missing');
    const turnTwo = async () => (await snapshot()).checkpoints[session.id]?.find((c) => c.turn === 2) ?? null;

    // The second turn writes a file with the design tab showing and nothing over it: both pictures land. The fake
    // answers the moment the message lands, so the approval waits for the turn's base (and `before`) to be
    // captured first — a real agent's first think is that window (ADR-0020).
    const composer = chat.getByRole('textbox', { name: /^Message Codex/ });
    await composer.fill('write notes.txt');
    await composer.press('Enter');
    await expect
      .poll(async () => (await turnTwo())?.screens ?? null, { timeout: 20_000 })
      .toEqual(['before']);
    await expect(decision.last()).toContainText('echo hi > notes.txt', { timeout: 20_000 });
    await decision.last().getByRole('button', { name: 'Allow' }).click();
    await expect(
      chat.locator('[data-kind="system"]').filter({ hasText: 'Turn 2: 1 files changed.' }),
    ).toBeVisible({ timeout: 20_000 });
    const row = chat.locator('[data-kind="checkpoint"][data-turn="2"]');
    await expect(row).toBeVisible();

    // Main kept both PNGs beside the row and named them on it (`after` arrives after the settle line: poll).
    await expect
      .poll(async () => (await turnTwo())?.screens ?? null, { timeout: 20_000 })
      .toEqual(['before', 'after']);
    const checkpoint = await turnTwo();
    if (checkpoint === null) throw new Error('turn 2 checkpoint missing');
    for (const side of ['before', 'after']) {
      const file = join(userData, 'screens', `${checkpoint.id}-${side}.png`);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    }

    // Review: Before turn 2 / After turn 2, both images served over styx-device:// and really decoded.
    await row.getByRole('button', { name: 'Review · Turn 2' }).click();
    const diff = page.locator('[data-diff-checkpoint]');
    await expect(diff).toBeVisible();
    const screens = diff.locator('[data-checkpoint-screens]');
    await expect(screens).toBeVisible();
    await expect(screens.locator('figcaption')).toHaveText(['Before turn 2', 'After turn 2']);
    const imgs = screens.locator('img');
    await expect(imgs).toHaveCount(2);
    await expect(imgs.nth(0)).toHaveAttribute('src', `styx-device://checkpoint/${checkpoint.id}/before`);
    await expect(imgs.nth(1)).toHaveAttribute('src', `styx-device://checkpoint/${checkpoint.id}/after`);
    await expect
      .poll(() => imgs.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth)), {
        timeout: 10_000,
      })
      .toEqual([expect.any(Number), expect.any(Number)]);
    const widths = await imgs.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth));
    expect(widths.every((w) => w > 0)).toBe(true);
    await expect(screens.getByText('No screenshot: the app was not running.')).toHaveCount(0);
    await diff.getByRole('button', { name: 'Done' }).click();
    await expect(chat).toBeVisible();
  } finally {
    await app.close();
  }
});
