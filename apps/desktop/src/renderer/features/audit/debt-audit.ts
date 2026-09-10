import {
  copy,
  mainWorktreeOf,
  projectSettingsOfOrDefault,
  type ProjectId,
  type ReadModel,
} from '@styx/core';
import { command } from '../../state/commands';

/**
 * The tech-debt audit: a real agent session, in this project's main worktree, whose first message is the audit
 * itself.
 *
 * Deliberately not a bundled analyzer and not a lint runner. The user is already authenticated with an agent, so
 * the audit reuses it — no second auth, no API key, and no analyzer forcing a language choice onto a product
 * that is language-agnostic everywhere else. Running the repo's own checks becomes the agent's first step rather
 * than the whole product, so lint output is evidence rather than the answer.
 *
 * The main worktree, not a new one: an audit reads, and the developer means *this* code. Edits are not
 * auto-approved, so if it ignores the prompt and tries to change something, the user is asked like anywhere else.
 */
export const startDebtAudit = async (
  model: ReadModel,
  projectId: ProjectId,
): Promise<{ sessionId: string } | null> => {
  const worktree = mainWorktreeOf(model, projectId);
  if (worktree === null) return null;
  const settings = projectSettingsOfOrDefault(model, projectId);
  const r = await command('session.spawn', {
    projectId,
    agent: settings.defaultAgent,
    worktree: { kind: 'existing', worktreeId: worktree.id },
    firstMessage: copy.debtAudit.prompt,
    toggles: {
      // A report, not a rewrite: nothing it does should be auto-approved.
      autoApproveEdits: false,
      // The audit reads the repo; it has no business asking for deploy targets.
      mayRequestTargets: false,
      notifyWhenNeedsMe: settings.notifyWhenNeedsMe,
    },
    model: null,
    permissionMode: 'default',
    effort: null,
  });
  return r.ok ? { sessionId: r.value.sessionId } : null;
};
