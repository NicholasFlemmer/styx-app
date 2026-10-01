import { copy } from '@styx/core';
import { Button, Label } from '@styx/ui';
import s from './HunkBar.module.css';

export interface HunkBarProps {
  /** "3 hunks from Claude · 42 tests pass" */
  label: string;
  /** Open the Diff review screen. */
  onReview: () => void;
  /** Reverse-apply every pending hunk (`hunk.revertAll`). */
  onRevertAll: () => void;
  /** Mark every pending hunk reviewed (`hunk.done`); the edits stay in the worktree. */
  onMarkReviewed: () => void;
}

/**
 * Hunk bar (40px), rendered only while an agent has pending hunks: Review (primary) / Revert all / Mark reviewed.
 * The agent already applied its edits, so there is nothing to accept (owner decision, replaces spec §4.1 Accept all).
 */
export function HunkBar({ label, onReview, onRevertAll, onMarkReviewed }: HunkBarProps) {
  return (
    <div className={s['bar']} data-hunk-bar="true">
      <Label as="span" className={s['label']} title={label}>
        {label}
      </Label>
      <Button variant="primary" onClick={onReview}>
        {copy.diff.review}
      </Button>
      <Button onClick={onRevertAll}>{copy.diff.revertAll}</Button>
      <Button onClick={onMarkReviewed}>{copy.diff.markReviewed}</Button>
    </div>
  );
}
