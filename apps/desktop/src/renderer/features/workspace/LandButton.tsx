import {
  landLabelOf,
  projectHasGit,
  projectSettingsOfOrDefault,
  projectWorktreeOf,
  type ProjectId,
  type ReadModel,
} from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback } from 'react';
import { useModel, useSessionId, useUi } from '../../state/hooks';
import s from './LandButton.module.css';

export interface LandButtonProps {
  projectId: ProjectId;
  /**
   * `toolbar` (default): the workspace mode strip. `lane`: the lane header over the chat (ADR-0027 §1), which
   * marks itself differently so the walkthrough and tests can tell the two apart.
   */
  placement?: 'toolbar' | 'lane';
}

/**
 * `Land` (or `Merge into main` in review mode) at the right end of the workspace mode strip, before Publish
 * (owner request, discrepancy #111: "the land/merge is not obvious enough, I don't want to flick to the repo tab
 * to do this"). Same lane as the editor column and the titlebar branch, same modal the Repo row opens. Secondary,
 * like Publish — accent stays reserved for Grant (§8) and the primary for Deploy.
 */
export function LandButton({ projectId, placement = 'toolbar' }: LandButtonProps) {
  const sessionId = useSessionId();
  const lane = useModel(
    useCallback(
      (m: ReadModel) => {
        if (!projectHasGit(m, projectId)) return null;
        const worktree = projectWorktreeOf(m, projectId, sessionId);
        if (worktree === null) return null;
        const settings = projectSettingsOfOrDefault(m, projectId);
        const label = landLabelOf(worktree, settings.integration, settings.baseBranch);
        return label === null ? null : { worktreeId: worktree.id, branch: worktree.branch, label };
      },
      [projectId, sessionId],
    ),
  );
  const pushOverlay = useUi((u) => u.pushOverlay);
  if (lane === null) return null;
  return (
    <div
      className={placement === 'lane' ? s['inLane'] : s['wrap']}
      {...(placement === 'lane' ? { 'data-lane-land': 'true' } : { 'data-land-button': 'true' })}
    >
      <Button
        size="compact"
        variant="secondary"
        className={s['button'] ?? ''}
        onClick={() => pushOverlay({ kind: 'modal', modal: 'land', worktreeId: lane.worktreeId })}
        title={`${lane.label} · ${lane.branch ?? ''}`.trim()}
      >
        <span className={s['glyph']} aria-hidden="true">
          ⤵
        </span>
        {lane.label}
      </Button>
    </div>
  );
}
