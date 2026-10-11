/**
 * Tour: the tech debt audit. One button in a project's menu starts an agent that reads the repo and reports what is
 * worth fixing; it runs as a background task in a small dialog that leaves the app usable, asks before running a
 * command, and ends with its report.
 */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

type StyxWindow = Window & { styx: { command: (name: string, input: unknown) => Promise<unknown> } };

const REPORT = [
  'Three things worth fixing first:',
  '',
  '1. Card payments retry by hand in four places in `checkout.ts`.',
  '2. The order test waits on a timer and fails about one run in ten.',
  '3. `money.ts` rounds prices with floats.',
].join('\n');

test('tour: tech debt audit in the background', async () => {
  const t = await startTour('debt-audit', {
    screen: 'home',
    env: {
      // The audit runs in the project's checkout, so the demo repos are on disk here.
      STYX_DEMO_REPOS: '1',
      // What the (fake) Codex reports, and the command it asks to run while it reads.
      STYX_FAKE_CODEX_REPLY: REPORT,
      STYX_FAKE_CODEX_COMMAND: 'rg -c TODO src',
      STYX_FAKE_CODEX_OUTPUT: 'src/checkout.ts:4',
    },
  });
  try {
    const { page } = t;
    await steps.homeReady(page);
    const projectId = await page.evaluate(async () => {
      const api = (window as unknown as StyxWindow).styx;
      await api.command('detect.clis', {});
      const snap = (await api.command('store.snapshot', {})) as {
        ok: boolean;
        value: { projects: { id: string; name: string }[] };
      };
      const project = snap.value.projects.find((p) => p.name === 'acme-shop');
      if (!project) throw new Error('fixture');
      await api.command('project.settings.set', { projectId: project.id, patch: { defaultAgent: 'codex' } });
      return project.id;
    });
    await page.locator(`button[data-project-id="${projectId}"]`).click();
    const audit = page.locator('[data-nav-audit]');
    const nav = page.locator('nav').filter({ has: audit });
    await steps.restPointer(page);
    await t.reach('nav', nav, { audit });
    await steps.pressHold(page, audit, () => t.reach('audit-pressed', nav, { audit }));
    await audit.click();

    const dialog = page.locator('[data-task-dialog]');
    const allow = dialog.getByRole('button', { name: 'Allow', exact: true });
    await expect(allow).toBeVisible({ timeout: 20_000 });
    await steps.restPointer(page);
    const parts = {
      status: dialog.getByRole('status'),
      background: dialog.getByRole('button', { name: 'Continue in background' }),
    };
    await t.reach('running', dialog, { ...parts, allow });
    await steps.pressHold(page, allow, () => t.reach('allow-pressed', dialog, { allow }));
    await allow.click();
    await expect(dialog.getByRole('status')).toHaveText('Finished', { timeout: 20_000 });
    await steps.restPointer(page);
    await t.reach('report', dialog, {
      status: dialog.getByRole('status'),
      report: dialog.locator('ol').first(),
    });
  } finally {
    await t.close();
  }
});
