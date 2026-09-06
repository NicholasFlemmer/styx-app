import { forwardRef, type ReactNode } from 'react';
import { Button } from '../../primitives';
import s from './Message.module.css';

export interface MessageFile {
  path: string;
  added?: number;
  removed?: number;
}

export interface DecisionOption {
  label: string;
  /** Defaults to true for the first option only. */
  primary?: boolean;
}

export type MessageKind =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; children: ReactNode }
  | { kind: 'fileList'; files: MessageFile[] }
  | {
      kind: 'decision';
      children: ReactNode;
      options: DecisionOption[];
      onChoose: (label: string) => void;
      /** The option already taken: options render disabled and the chosen one inverted (`data-inv`). */
      chosen?: string | null;
      /** The ask is no longer open (resolved / cancelled elsewhere): options render disabled. */
      disabled?: boolean;
    }
  | {
      /** One tool call from the agent's stream: compact mono row, no bubble (owner addition, discrepancy #54). */
      kind: 'tool';
      tool: string;
      hint: string;
      status: 'running' | 'ok' | 'error';
      /** Glyph for `status` (app: `copy.session.tool.*`). */
      statusGlyph: string;
      /** Second line, e.g. the error text. */
      detail?: string | null;
    }
  | {
      kind: 'accessRequest';
      /** Filled header, e.g. "Access request · Supabase prod" (app: `copy.accessRequest.header`). */
      header: ReactNode;
      /** Filled scope line (app: `copy.accessRequest.scopeLine`). */
      body: ReactNode;
      reviewLabel: string;
      denyLabel: string;
      onReview: () => void;
      onDeny: () => void;
    }
  | { kind: 'system'; text: string };

export type MessageProps = MessageKind & {
  /** Pop-out chat: 7px 10px padding, 12.5px type. */
  compact?: boolean;
  className?: string;
};

/**
 * Chat message (spec §8): user (filled) · agent (bordered) · file list · decision (buttons) ·
 * access request (accent border + header) · system (mono muted). Max width 88–92% of pane.
 */
export const Message = forwardRef<HTMLDivElement, MessageProps>(function Message(props, ref) {
  const { compact, className } = props;
  const cls = (...names: Array<string | undefined>) =>
    [s['msg'], ...names, compact ? s['compact'] : undefined, className].filter(Boolean).join(' ');

  switch (props.kind) {
    case 'user':
      return (
        <div ref={ref} data-kind="user" className={cls(s['user'])}>
          {props.text}
        </div>
      );
    case 'agent':
      return (
        <div ref={ref} data-kind="agent" className={cls(s['agent'])}>
          {props.children}
        </div>
      );
    case 'system':
      return (
        <div ref={ref} data-kind="system" className={cls(s['system'])}>
          {props.text}
        </div>
      );
    case 'fileList':
      return (
        <div ref={ref} data-kind="fileList" className={cls(s['files'])}>
          {props.files.map((f) => (
            <div key={f.path} className={s['file']}>
              <span>{f.path}</span>
              <span>
                {f.added !== undefined && <span className={s['add']}>+{f.added}</span>}
                {f.removed !== undefined && (f.added !== undefined ? ` −${f.removed}` : `−${f.removed}`)}
              </span>
            </div>
          ))}
        </div>
      );
    case 'decision': {
      const chosen = props.chosen ?? null;
      const settled = props.disabled === true || chosen !== null;
      return (
        <div
          ref={ref}
          data-kind="decision"
          data-settled={settled ? 'true' : undefined}
          className={cls(s['agent'])}
        >
          {props.children}
          <div className={s['options']}>
            {props.options.map((o, i) => (
              <Button
                key={o.label}
                size="compact"
                variant={(o.primary ?? i === 0) ? 'primary' : 'secondary'}
                inv={chosen === o.label}
                disabled={settled}
                onClick={() => props.onChoose(o.label)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      );
    }
    case 'tool':
      return (
        <div ref={ref} data-kind="tool" data-status={props.status} className={cls(s['tool'])}>
          <div className={s['toolLine']}>
            <span className={s['toolGlyph']} aria-hidden="true">
              {props.statusGlyph}
            </span>
            <span className={s['toolName']}>{props.tool}</span>
            <span className={s['toolHint']} title={props.hint}>
              {props.hint}
            </span>
          </div>
          {props.detail !== undefined && props.detail !== null && props.detail !== '' && (
            <div className={s['toolDetail']}>{props.detail}</div>
          )}
        </div>
      );
    case 'accessRequest':
      return (
        <div ref={ref} data-kind="accessRequest" className={cls(s['request'])}>
          <div className={s['requestHeader']}>{props.header}</div>
          <div className={s['requestBody']}>{props.body}</div>
          <div className={s['requestActions']}>
            <Button size="compact" variant="primary" onClick={props.onReview}>
              {props.reviewLabel}
            </Button>
            <Button size="compact" variant="secondary" onClick={props.onDeny}>
              {props.denyLabel}
            </Button>
          </div>
        </div>
      );
    default:
      return null;
  }
});
