import type { CommandInput, CommandName, CommandResult } from '@styx/core';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: {
    command<N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandResult<N>>;
  };
};

test('background audit keeps project navigation usable and retains approvals and its report', async ({}, testInfo) => {
  const { app, page } = await launchStyx({ screen: 'home', theme: 'dark' });
  try {
    await expect(page.locator('[data-screen-ready="home"]')).toBeAttached({ timeout: 20_000 });
    const projectId = await page.evaluate(async () => {
      const api = (window as unknown as StyxWindow).styx;
      await api.command('detect.clis', {}); // e2e's fake Codex, never a real agent
      const snapshot = await api.command('store.snapshot', {});
      if (!snapshot.ok) throw new Error('snapshot');
      const project = snapshot.value.projects.find((p) => p.name === 'acme-shop');
      if (!project) throw new Error('fixture');
      await api.command('project.settings.set', { projectId: project.id, patch: { defaultAgent: 'codex' } });
      return project.id;
    });
    await page.locator(`button[data-project-id="${projectId}"]`).click();
    await page.locator('[data-nav-audit]').click();
    const dialog = page.locator('[data-task-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'false');
    await expect(page.locator('#layer-app')).not.toHaveAttribute('inert', '');
    await expect(dialog.getByRole('button', { name: 'Allow', exact: true })).toBeVisible({ timeout: 20_000 });
    const taskId = await page.evaluate(async () => {
      const snapshot = await (window as unknown as StyxWindow).styx.command('store.snapshot', {});
      if (!snapshot.ok) throw new Error('snapshot');
      const task = snapshot.value.sessions.find((s) => s.purpose === 'debt-audit');
      if (!task) throw new Error('task');
      return task.id;
    });
    await page.screenshot({ path: testInfo.outputPath('background-task-approval.png') });
    const accessibility = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .include('[data-task-dialog]')
      .analyze();
    expect(accessibility.violations).toEqual([]);

    // A different project is clickable even while the task dialog is open.
    const other = page.locator(`button[data-project-id]:not([data-project-id="${projectId}"])`).first();
    await other.click();
    await expect(other).toHaveAttribute('aria-current', 'true');
    await expect(dialog).toContainText('acme-shop');
    await dialog.getByRole('button', { name: 'Continue in background' }).click();
    await expect(dialog).toHaveCount(0);
    await page.locator('[data-nav-tasks]').click();
    await page.getByRole('button', { name: /Tech debt audit · acme-shop/ }).click();
    await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Finished', { timeout: 20_000 });
    await expect(dialog).toContainText('pong');

    const finished = await page.evaluate(async (id) => {
      const snapshot = await (window as unknown as StyxWindow).styx.command('store.snapshot', {});
      return snapshot.ok ? snapshot.value.sessions.find((s) => s.id === id) : null;
    }, taskId);
    expect(finished).toMatchObject({ state: 'done', exitCode: 0, purpose: 'debt-audit' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    // The report also survives losing all renderer-local task state.
    await page.reload();
    await page.locator('[data-nav-tasks]').click();
    await page.getByRole('button', { name: /Tech debt audit · acme-shop/ }).click();
    await expect(dialog).toContainText('pong');
    await page.screenshot({ path: testInfo.outputPath('background-task-result.png') });
  } finally {
    await app.close();
  }
});
