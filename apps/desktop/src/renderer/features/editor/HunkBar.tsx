import { copy } from '@styx/core';
import { Button, Label } from '@styx/ui';
import s from './HunkBar.module.css';

export interface HunkBarProps {
  /** "3 hunks from Claude · 42 tests pass" */
  label: string;
  onAcceptAll: () => void;
  onReview: () => void;
  onRejectAll: () => void;
}

/** Hunk bar (40px), rendered only while an agent has pending hunks: Accept all (primary) / Review / Reject. */
export function HunkBar({ label, onAcceptAll, onReview, onRejectAll }: HunkBarProps) {
  return (
    <div className={s['bar']} data-hunk-bar="true">
      <Label as="span" className={s['label']}>
        {label}
      </Label>
      <Button variant="primary" onClick={onAcceptAll}>
        {copy.diff.acceptAll}
      </Button>
      <Button onClick={onReview}>{copy.diff.review}</Button>
      <Button onClick={onRejectAll}>{copy.diff.reject}</Button>
    </div>
  );
}
