import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { AgentDot, type AgentKind } from '../../primitives/AgentDot';
import s from './Card.module.css';

/** `ready`: finished work waiting to land, drawn on paper (ADR-0027 §3); `done`/`landed`: dimmed. */
export type CardTone = 'needs' | 'working' | 'ready' | 'done' | 'landed';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  agent: ReactNode;
  age: ReactNode;
  project: ReactNode;
  branch: ReactNode;
  note: ReactNode;
  /** Action buttons row (compact buttons, gap 6). */
  actions?: ReactNode;
  /** done = muted note. */
  tone?: CardTone;
  /** The agent's square before its name (ADR-0027 §7). */
  agentKind?: AgentKind | undefined;
  inv?: boolean;
  on?: boolean;
}

/** Board card (Agents screen): header, `project · branch`, note, actions. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { agent, age, project, branch, note, actions, tone = 'working', agentKind, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['card'], s[tone], className].filter(Boolean).join(' ');
  return (
    <div
      ref={ref}
      className={cls}
      data-tone={tone}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      <div className={s['head']}>
        <span className={s['agent']}>
          {agentKind !== undefined ? <AgentDot agent={agentKind} /> : null}
          {agent}
        </span>
        <span className={s['age']} data-muted="true">
          {age}
        </span>
      </div>
      <div className={s['meta']} data-muted="true">
        {project} · {branch}
      </div>
      <div className={s['note']} data-muted={tone === 'done' || tone === 'landed' ? 'true' : undefined}>
        {note}
      </div>
      {actions !== undefined && actions !== null ? <div className={s['actions']}>{actions}</div> : null}
    </div>
  );
});
