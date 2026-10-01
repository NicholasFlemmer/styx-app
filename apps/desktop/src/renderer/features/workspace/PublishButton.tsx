import { copy, projectHasGit, projectWorktreeOf, type ProjectId, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback } from 'react';
import { useModel, useSessionId, useUi } from '../../state/hooks';
import s from './PublishButton.module.css';

export interface PublishButtonProps {
  projectId: ProjectId;
}

/**
 * `Publish` at the right end of the workspace mode strip, before the Deploy button (owner request, modelled on
 * t3code; ADR-0021): commit, push and PR in one step for the worktree the editor column shows (what the titlebar
 * branch reads). Secondary — accent stays reserved for Grant (§8), the primary for Deploy. A plain folder has
 * no branch to publish, so the button does not render there.
 */
export function PublishButton({ projectId }: PublishButtonProps) {
  const sessionId = useSessionId();
  const worktree = useModel(
    useCallback(
      (m: ReadModel) => (projectHasGit(m, projectId) ? projectWorktreeOf(m, projectId, sessionId) : null),
      [projectId, sessionId],
    ),
  );
  const pushOverlay = useUi((u) => u.pushOverlay);
  if (worktree === null || worktree.branch === null) return null;
  const worktreeId = worktree.id;
  return (
    <div className={s['wrap']} data-publish-button="true">
      <Button
        size="compact"
        variant="secondary"
        className={s['button'] ?? ''}
        onClick={() => pushOverlay({ kind: 'modal', modal: 'publish', worktreeId })}
        title={`${copy.publish.run} · ${worktree.branch}`}
      >
        <span className={s['glyph']} aria-hidden="true">
          ↑
        </span>
        <span data-strip-label="true">{copy.publish.run}</span>
      </Button>
    </div>
  );
}
