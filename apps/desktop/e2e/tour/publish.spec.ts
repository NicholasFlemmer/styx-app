/**
 * Tour: publish a task as a pull request. On the Repo screen the `test/flaky` lane has changes and no PR; Open PR
 * drafts the commit message and the PR's title and description (the fake `claude` reads the changed files), Publish
 * commits, pushes to a bare remote on disk and opens the PR through the fake `gh`, and the lane then reads `#7 draft`.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-C', cwd, ...args]);
};

test('tour: publish a task as a pull request', async () => {
  // Publishing commits and pushes for real, so the demo repos are on disk here.
  const t = await startTour('publish', { screen: 'repo', env: { STYX_DEMO_REPOS: '1' } });
  try {
    const { app, page } = t;
    // A bare remote under userData makes the push real and keeps it off the network.
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const bare = join(userData, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', bare]);
    git(join(userData, 'demo-repos', 'acme-shop'), 'remote', 'add', 'origin', bare);
    // The fake `claude` on PATH drafts the message, not a real install.
    await steps.detectClis(page);

    const lane = page.locator('[data-lane="test/flaky"]');
    await steps.restPointer(page);
    const openPr = lane.getByRole('button', { name: 'Open PR' });
    await t.reach('lane', lane, { row: lane, openPr });
    await openPr.click();

    const dialog = page.getByRole('dialog');
    const message = dialog.getByLabel('Commit message');
    const title = dialog.getByLabel('Pull request title');
    await expect(title).toHaveValue('Cover order retries in the flaky test', { timeout: 30_000 });
    await expect(message).toHaveValue(/orders\.test\.ts/);
    await expect(dialog.getByLabel('Description')).toHaveValue(/## Summary/);
    await dialog.locator('label:has([data-publish-draft-toggle])').click();
    await steps.restPointer(page);
    const publish = dialog.locator('[data-publish-run]');
    await t.reach('drafted', dialog, { message, title, publish });
    // Held, then let go on the button itself, so the press is the Publish (letting go outside the dialog would
    // close it).
    const b = await publish.boundingBox();
    if (!b) throw new Error('Publish not on screen');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await t.reach('publish-pressed', dialog, { publish });
    await page.mouse.up();
    const step = (name: string) => dialog.locator(`[data-publish-step="${name}"]`);
    await expect(step('pr')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await steps.restPointer(page);
    await t.reach('published', dialog, {
      commit: step('commit'),
      push: step('push'),
      pr: step('pr'),
      openPr: dialog.locator('[data-publish-open-pr]'),
    });

    await dialog.locator('[data-publish-close]').click();
    await expect(lane).toContainText('#7 draft');
    await steps.restPointer(page);
    await t.reach('lane-pr', lane, { row: lane, pr: lane.getByText('#7 draft') });
  } finally {
    await t.close();
  }
});
