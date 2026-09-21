// @vitest-environment jsdom
import { copy, fixtures, mainWorktreeOf } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { startDebtAudit } from './debt-audit';

const acme = fixtures.ids.project.acmeShop;
const commands: { name: string; input: unknown }[] = [];

/**
 * The audit is a real agent session, so the assertions that matter are the ones that keep it a *report*: it must
 * not be able to edit without asking, and it has no business requesting deploy targets.
 */
describe('startDebtAudit', () => {
  beforeEach(() => {
    commands.length = 0;
    useUiStore.setState({ taskLaunches: {}, learning: {}, overlays: [], projectSession: {} });
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return { ok: true, value: { sessionId: 'sess-new', worktreeId: 'wt-1' } };
        }),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
  });
  afterEach(() => {
    Object.assign(window, { styx: undefined });
  });

  it('spawns the project default agent in the main worktree with the audit as its first message', async () => {
    const model = useReadModel.getState().model;
    const r = await startDebtAudit(model, acme);
    expect(r).toEqual({ sessionId: 'sess-new' });
    const spawn = commands.find((c) => c.name === 'session.spawn')?.input as Record<string, unknown>;
    expect(spawn).toMatchObject({
      projectId: acme,
      // The main worktree, not a new one: an audit reads, and the developer means *this* code.
      worktree: { kind: 'existing', worktreeId: mainWorktreeOf(model, acme)?.id },
      firstMessage: copy.debtAudit.prompt,
      // Styx's own task: the project's task mode, bypass unless changed (owner decision).
      permissionMode: 'bypassPermissions',
      toggles: { autoApproveEdits: true, mayRequestTargets: false, notifyWhenNeedsMe: true },
      purpose: 'debt-audit',
    });
  });

  it("runs in the project's task mode (bypass unless changed; Styx approves its edits) and cannot reach deploy targets", async () => {
    await startDebtAudit(useReadModel.getState().model, acme);
    const spawn = commands.find((c) => c.name === 'session.spawn')?.input as {
      toggles: Record<string, boolean>;
      permissionMode: string;
    };
    expect(spawn.permissionMode).toBe('bypassPermissions');
    expect(spawn.toggles.autoApproveEdits).toBe(true);
    expect(spawn.toggles.mayRequestTargets).toBe(false);
  });

  it('does nothing for a project with no main worktree rather than spawning into nowhere', async () => {
    const model = useReadModel.getState().model;
    const stripped = { ...model, worktrees: { byId: {}, ids: [] } };
    await expect(startDebtAudit(stripped as typeof model, acme)).resolves.toBeNull();
    expect(commands.filter((c) => c.name === 'session.spawn')).toEqual([]);
  });

  it('the prompt is real: it tells the agent to report rather than fix', () => {
    const p = copy.debtAudit.prompt.toLowerCase();
    expect(copy.debtAudit.prompt.length).toBeGreaterThan(200);
    expect(p).not.toBe('placeholder');
    // The single most important instruction in the whole feature.
    expect(/do not (fix|change|edit|modify)|don't (fix|change|edit)|not to fix/.test(p)).toBe(true);
  });
});
