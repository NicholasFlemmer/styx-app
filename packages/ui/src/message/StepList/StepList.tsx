import type { ReactNode } from 'react';
import s from './StepList.module.css';

export interface Step {
  key: string;
  label: string;
  status: 'running' | 'ok' | 'error';
}

export interface StepListProps {
  steps: readonly Step[];
  /** "12 steps, 1 failed": the line a finished turn folds to. */
  summary: string;
  /** The turn is running: every step shows, the last one live. */
  live: boolean;
  /** Steps are listed (a finished turn starts folded to its summary). */
  open: boolean;
  onToggle: () => void;
  /** The raw tool rows, shown instead of the steps when `showTools`. */
  tools?: ReactNode;
  showTools: boolean;
  onToggleTools: () => void;
  labels: { showTools: string; hideTools: string };
  compact?: boolean;
}

/**
 * A turn's tool calls as plain steps (ADR-0027 §4). Live, every step shows with the current one marked; finished,
 * the list folds to "12 steps" and opens on a click. The raw tool rows are one more click away.
 */
export function StepList({
  steps,
  summary,
  live,
  open,
  onToggle,
  tools,
  showTools,
  onToggleTools,
  labels,
  compact = false,
}: StepListProps) {
  const listed = live || open;
  return (
    <div
      className={[s['steps'], compact ? s['compact'] : undefined].filter(Boolean).join(' ')}
      data-kind="steps"
      data-live={live ? 'true' : undefined}
    >
      {live ? null : (
        <button type="button" className={s['summary']} aria-expanded={open} onClick={onToggle}>
          {summary}
        </button>
      )}
      {listed && !showTools ? (
        <ol className={s['list']}>
          {steps.map((step) => (
            <li key={step.key} data-status={step.status}>
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}
      {listed && showTools ? <div className={s['tools']}>{tools}</div> : null}
      {listed ? (
        <button type="button" className={s['raw']} aria-pressed={showTools} onClick={onToggleTools}>
          {showTools ? labels.hideTools : labels.showTools}
        </button>
      ) : null}
    </div>
  );
}
