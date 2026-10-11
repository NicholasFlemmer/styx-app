/**
 * Tour: revert one hunk. Claude Code's lane (fix/checkout) has three edits waiting for review; the bar under the
 * editor offers Review, the review lists each hunk with its own Revert, and reverting one takes back just those lines
 * in the worktree while the other two stay.
 */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

type StyxWindow = Window & { styx: { command: (name: string, input: unknown) => Promise<unknown> } };

test('tour: revert one hunk', async () => {
  // Reverting reverse-applies the hunk in a real worktree, so the demo repos are on disk here.
  const t = await startTour('revert', { screen: 'workspace', env: { STYX_DEMO_REPOS: '1' } });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    // The fixture's review rows are written by hand and don't apply to the files on disk. Setting edit tracking
    // (already on) re-reads every live lane, so the review lists the lane's real edits from git, which revert cleanly.
    await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('settings.set', { patch: { trackAgentEdits: true } }),
    );
    await page.click('[data-workspace-mode="code"]');
    const bar = page.locator('[data-hunk-bar]');
    await steps.restPointer(page);
    await t.reach('hunk-bar', bar, { review: bar.getByRole('button', { name: 'Review', exact: true }) });
    await bar.getByRole('button', { name: 'Review', exact: true }).click();

    const list = page.locator('[data-diff-review] [role="list"]');
    await expect(page.locator('[data-hunk]').filter({ hasText: 'checkout.test.ts' })).toBeVisible();
    const hunk = page.locator('[data-hunk]').nth(1);
    const revert = hunk.getByRole('button', { name: /^Revert/ });
    await steps.restPointer(page);
    await t.reach('hunks', list, {
      first: page.locator('[data-hunk]').nth(0),
      hunk,
      third: page.locator('[data-hunk]').nth(2),
    });
    await t.reach('hunk', hunk, { revert, status: hunk.locator('[data-hunk-status]') });
    await steps.pressHold(page, revert, () => t.reach('revert-pressed', hunk, { revert }));

    await revert.click();
    await expect(hunk).toHaveAttribute('data-status', 'rejected', { timeout: 15_000 });
    await steps.restPointer(page);
    await t.reach('reverted', hunk, { status: hunk.locator('[data-hunk-status]') });
  } finally {
    await t.close();
  }
});
