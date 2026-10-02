import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AgentDot, type AgentKind } from '../../primitives/AgentDot';
import s from './LaneHeader.module.css';

export interface LaneHeaderProps {
  agent: AgentKind;
  agentName: string;
  branch: string;
  /** After the branch: how much the session has used ("14.6k tokens · 1 turn"), when known. */
  meta?: string | null | undefined;
  task: string;
  /** "3 turns kept, 7 files changed". */
  summary: string;
  /** The lane's main action (Land on main) at the summary's right. */
  action?: ReactNode;
  /** Small controls at the top right (play, pop out, the lane's menu). */
  tools?: ReactNode;
}

/**
 * The lane over the chat (ADR-0027 §1): which agent on which branch, the task in the user's words, and what the
 * lane holds so far, with its main action. Replaces the session tab row: the lanes themselves are in the nav.
 */
export function LaneHeader({
  agent,
  agentName,
  branch,
  meta,
  task,
  summary,
  action,
  tools,
}: LaneHeaderProps) {
  // The task is clamped to two lines; when it runs longer, clicking it shows the whole thing (and again folds it).
  const taskRef = useRef<HTMLHeadingElement | null>(null);
  // Held per task, so another lane's task starts folded.
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const expanded = expandedTask === task;
  const toggle = () => setExpandedTask(expanded ? null : task);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = taskRef.current;
    if (el === null) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [task, expanded]);
  const toggles = expanded || clamped;
  return (
    <header className={s['head']} data-lane-header="true">
      <div className={s['who']}>
        <AgentDot agent={agent} />
        <span>{agentName}</span>
        <span className={s['branch']}>{branch}</span>
        {meta !== undefined && meta !== null ? (
          <span className={s['meta']} data-lane-meta="true">
            {meta}
          </span>
        ) : null}
        {tools !== undefined ? <span className={s['tools']}>{tools}</span> : null}
      </div>
      <h2
        ref={taskRef}
        className={s['task']}
        data-expanded={expanded ? 'true' : undefined}
        data-lane-task="true"
      >
        {/* One inline span either way, so the clamp (and what it measures) never changes with the toggle. */}
        <span
          className={toggles ? s['taskToggle'] : undefined}
          role={toggles ? 'button' : undefined}
          tabIndex={toggles ? 0 : undefined}
          aria-expanded={toggles ? expanded : undefined}
          onClick={toggles ? toggle : undefined}
          onKeyDown={
            toggles
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                  }
                }
              : undefined
          }
        >
          {task}
        </span>
      </h2>
      <div className={s['sum']}>
        <span data-lane-summary="true">{summary}</span>
        {action !== undefined ? <span className={s['action']}>{action}</span> : null}
      </div>
    </header>
  );
}
