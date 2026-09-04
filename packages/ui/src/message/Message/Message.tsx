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
  | { kind: 'decision'; children: ReactNode; options: DecisionOption[]; onChoose: (label: string) => void }
  | {
      kind: 'accessRequest';
      target: string;
      env?: string;
      scopes: string[];
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
    case 'decision':
      return (
        <div ref={ref} data-kind="decision" className={cls(s['agent'])}>
          {props.children}
          <div className={s['options']}>
            {props.options.map((o, i) => (
              <Button
                key={o.label}
                size="compact"
                variant={(o.primary ?? i === 0) ? 'primary' : 'secondary'}
                onClick={() => props.onChoose(o.label)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      );
    case 'accessRequest':
      return (
        <div ref={ref} data-kind="accessRequest" className={cls(s['request'])}>
          <div className={s['requestHeader']}>
            Access request · {props.target}
            {props.env !== undefined && ` ${props.env}`}
          </div>
          <div className={s['requestBody']}>
            Scope: {props.scopes.join(', ')}. No grant on file for this target.
          </div>
          <div className={s['requestActions']}>
            <Button size="compact" variant="primary" onClick={props.onReview}>
              Review request
            </Button>
            <Button size="compact" variant="secondary" onClick={props.onDeny}>
              Deny
            </Button>
          </div>
        </div>
      );
    default:
      return null;
  }
});
