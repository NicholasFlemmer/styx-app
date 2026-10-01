import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { AgentDot, type AgentKind } from '../../primitives/AgentDot';
import s from './LaneRow.module.css';

export interface LaneRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  agent: AgentKind;
  /** What the lane is for, in the user's words. */
  task: string;
  /** Whose move it is ("Your turn", "Working, 2m", "Ready to land"). */
  status: string;
  /**
   * `yours`: the move is the user's, so the status is accent-filled. `quiet`: landed work, dimmed.
   * `normal` otherwise.
   */
  tone?: 'yours' | 'normal' | 'quiet';
  /** The lane open in the workspace. */
  inv?: boolean;
}

/**
 * One lane in the project nav (ADR-0027 §1): the agent's square, the task, and whose move it is. A button; the
 * current lane is inverted and `aria-current`.
 */
export const LaneRow = forwardRef<HTMLButtonElement, LaneRowProps>(function LaneRow(
  { agent, task, status, tone = 'normal', inv, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[s['row'], className].filter(Boolean).join(' ')}
      aria-current={inv ? 'page' : undefined}
      data-inv={inv ? 'true' : undefined}
      data-tone={tone}
      {...rest}
    >
      <AgentDot agent={agent} className={s['dot']} />
      <span className={s['task']}>{task}</span>
      <span className={s['status']} data-on={tone === 'yours' ? 'true' : undefined}>
        {status}
      </span>
    </button>
  );
});
