/** Tour: what a lane changed, ready to land. The Changes page of a working lane, with Land beside it. */
import { test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: changes, then land', async () => {
  const t = await startTour('changes', { screen: 'workspace' });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await page.click('[data-nav-lane][data-lane-status="working"] >> nth=0');
    await page.click('[data-workspace-mode="changes"]');
    await steps.restPointer(page);
    const changes = page.locator('[data-changes-page]');
    await t.reach('changes-page', changes, {
      land: page.getByRole('button', { name: 'Land', exact: true }).first(),
    });
    await t.reach('files', page.locator('[data-chat-pane]'));
  } finally {
    await t.close();
  }
});
