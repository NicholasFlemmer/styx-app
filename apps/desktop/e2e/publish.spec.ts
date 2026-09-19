/**
 * Commit, push and PR in one step (owner request, modelled on t3code; ADR-0021). On the Repo screen the `test/flaky`
 * lane (uncommitted changes, no PR) offers `Open PR`; the modal's message is drafted by the fake `claude` in
 * e2e/fixtures/bin (the demo project's default agent, re-detected so it wins over a real install), and Publish
 * commits, pushes to a bare `origin` created under userData, and opens the PR through the fake `gh` under a
 * `write` grant on the demo's GitHub target. The lane then reads `#7 draft`.
 */
import type { AuditEntry, Grant } from '@styx/core';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('Open PR on a lane: the agent drafts the message, Publish commits, pushes and opens the PR under a grant', async () => {
  const { app, page, userData } = await launchStyx({
    screen: 'repo',
    fixture: 'demo',
    theme: 'dark',
    chrome: 'mac',
  });
  try {
    // The harness materialises the demo repos under userData at boot; a bare remote makes the push real.
    const repo = join(userData, 'demo-repos', 'acme-shop');
    const bare = join(userData, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', bare]);
    git(repo, 'remote', 'add', 'origin', bare);

    // The demo rows name binaries this machine may have for real: re-detect so the fake `claude` (highest
    // version) drafts the message instead of spending anyone's usage.
    const detected = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('detect.clis', {}),
    );
    const claude = ((detected.value as { clis: { agent: string; binary: string | null }[] }).clis ?? []).find(
      (c) => c.agent === 'claude',
    );
    expect(claude?.binary ?? '').toMatch(/e2e[/\\]fixtures[/\\]bin[/\\]claude$/);

    await page.locator('[data-repo]').waitFor({ timeout: 20_000 });
    const lane = page.locator('[data-lane="test/flaky"]');
    await expect(lane).toContainText('—');
    await lane.getByRole('button', { name: 'Open PR' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Publish · test/flaky');
    await expect(dialog).toContainText('drafted by Claude Code');
    // The fake claude reads the numstat block off stdin and names the changed file back.
    await expect(dialog.getByLabel('Commit message')).toHaveValue(/Cover order retries in the flaky test/, {
      timeout: 30_000,
    });
    await expect(dialog.getByLabel('Commit message')).toHaveValue(/orders\.test\.ts/);
    await expect(dialog.getByLabel('Pull request title')).toHaveValue(
      'Cover order retries in the flaky test',
      {
        timeout: 30_000,
      },
    );
    await expect(dialog.getByLabel('Description')).toHaveValue(/## Summary/);
    // The Checkbox input is visually hidden under its label, so the label row is the click target.
    await dialog.locator('label:has([data-publish-draft-toggle])').click();
    await expect(dialog.locator('[data-publish-draft-toggle]')).toBeChecked();
    await dialog.getByRole('button', { name: 'Publish' }).click();

    const step = (name: string) => page.locator(`[data-publish-step="${name}"]`);
    await expect(step('commit')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await expect(step('commit')).toContainText('Committed');
    await expect(step('push')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await expect(step('push')).toContainText('Pushed test/flaky');
    await expect(step('pr')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await expect(step('pr')).toContainText('Opened PR #7');
    await expect(dialog.getByRole('button', { name: 'Open PR #7' })).toBeVisible();

    // The branch really landed on the remote, with the drafted subject as the commit message.
    const wt = join(userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'test-flaky');
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(bare, 'log', '-1', '--format=%s', 'refs/heads/test/flaky')).toBe(
      'Cover order retries in the flaky test',
    );

    await page.locator('[data-publish-close]').click();
    await expect(dialog).toHaveCount(0);
    await expect(lane).toContainText('#7 draft');
    // With a PR on the lane the verb becomes Commit & push.
    await expect(lane.getByRole('button', { name: 'Commit & push' })).toBeVisible();

    // gh ran under a write grant on the demo's GitHub target (the same path an agent's shim call takes), the PR is
    // audited, and the Home feed has the row.
    const snap = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('store.snapshot', {}),
    );
    const { grants, auditEntries, activity } = snap.value as {
      grants: Grant[];
      auditEntries: AuditEntry[];
      activity: { what: string }[];
    };
    const grant = grants.find((g) => g.reason.startsWith('Publish test/flaky'));
    expect(grant).toMatchObject({ state: 'active', scope: ['write'], sessionId: null });
    expect(
      auditEntries.some(
        (e) => e.action === 'opened-pr' && e.triggeredBy === 'worktree.publish' && e.detail['prNumber'] === 7,
      ),
    ).toBe(true);
    expect(auditEntries.some((e) => e.action === 'used' && /^gh pr create/.test(e.triggeredBy ?? ''))).toBe(
      true,
    );
    // The modal runs one `worktree.publish` per step, so the feed has a row per step.
    const feed = activity.map((a) => a.what).filter((w) => w.includes('published test/flaky'));
    expect(feed).toHaveLength(3);
    expect(feed.some((w) => /\(commit [0-9a-f]{7}\)$/.test(w))).toBe(true);
    expect(feed).toContain('acme-shop · published test/flaky (push)');
    expect(feed).toContain('acme-shop · published test/flaky (PR #7)');
  } finally {
    await app.close();
  }
});
