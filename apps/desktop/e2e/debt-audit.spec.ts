/**
 * The tech-debt audit is a real agent session rather than a bundled analyzer, so what matters end to end is that
 * the button spawns one, in this project's main worktree, carrying the audit as its first message and without
 * the toggles that would let it start changing things. Whether the agent CLI then runs is environment-dependent
 * (the fixture names binaries this machine may not have), so that is deliberately not asserted here.
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('Audit debt spawns a read-only agent session with the audit as its first message', async () => {
  const { app, page } = await launchStyx({
    screen: 'repo',
    fixture: 'demo',
    theme: 'dark',
    platform: 'darwin',
  });
  await page.waitForSelector('[data-repo-audit]', { timeout: 10_000 });

  const snapshot = async () =>
    page.evaluate(async () => {
      const styx = (window as never as { styx: { command: (n: string, i: unknown) => Promise<unknown> } }).styx;
      const snap = (await styx.command('store.snapshot', {})) as {
        value?: {
          sessions: {
            id: string;
            worktreeId: string;
            firstMessage: string | null;
            toggles: { autoApproveEdits: boolean; mayRequestTargets: boolean };
          }[];
          worktrees: { id: string; isMain: boolean; projectId: string }[];
        };
      };
      return snap.value ?? { sessions: [], worktrees: [] };
    });

  const before = (await snapshot()).sessions.length;
  await page.click('[data-repo-audit]');
  await expect.poll(async () => (await snapshot()).sessions.length, { timeout: 10_000 }).toBe(before + 1);

  const after = await snapshot();
  const spawned = after.sessions.at(-1);
  expect(spawned?.firstMessage ?? '').toContain('Audit this repository for tech debt');
  // The main worktree: an audit reads, and the developer means this code.
  const main = after.worktrees.find((w) => w.isMain && w.projectId === '01JDEMOPROJ000000000000001');
  expect(spawned?.worktreeId).toBe(main?.id);
  // A report, not a rewrite.
  expect(spawned?.toggles.autoApproveEdits).toBe(false);
  expect(spawned?.toggles.mayRequestTargets).toBe(false);

  await app.close();
});
