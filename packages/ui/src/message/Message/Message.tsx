import { forwardRef, useId, useState, type ReactNode, type Ref } from 'react';
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

export interface MessageAttachment {
  /** Image name or file path. */
  label: string;
  kind: 'image' | 'file';
}

export type MessageKind =
  | {
      kind: 'user';
      text: string;
      /** Images / files sent with the message (owner addition, discrepancy #57): small inverted mono chips. */
      attachments?: readonly MessageAttachment[];
      /** What the message points at (#140), e.g. "Checkout › Pay button": a chip above the text. */
      pointer?: string;
    }
  | {
      kind: 'agent';
      children: ReactNode;
      /** The body is still being streamed: a blinking `▌` cursor follows the text. */
      streaming?: boolean;
    }
  | {
      /**
       * A thinking block from the stream (owner addition, discrepancy #55): a muted t-label header (`label`, e.g.
       * "Thinking…" / "Thought for 4s") over a quiet quote-like body. Streaming: body always open, cursor at the
       * end. Done: collapsed by default, Show/Hide ghost toggle in the header.
       */
      kind: 'thinking';
      text: string;
      status: 'streaming' | 'done';
      label: string;
      showLabel: string;
      hideLabel: string;
      /** Done blocks start collapsed unless set. */
      defaultOpen?: boolean;
    }
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

const Cursor = () => (
  <span className={s['cursor']} aria-hidden="true">
    ▌
  </span>
);

type ThinkingProps = Extract<MessageKind, { kind: 'thinking' }> & { className: string };

function ThinkingMessage({
  text,
  status,
  label,
  showLabel,
  hideLabel,
  defaultOpen = false,
  className,
  ref,
}: ThinkingProps & { ref: Ref<HTMLDivElement> }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const streaming = status === 'streaming';
  const shown = streaming || open;
  return (
    <div
      ref={ref}
      data-kind="thinking"
      data-status={status}
      data-open={shown ? 'true' : undefined}
      className={className}
    >
      <div className={s['thinkingHead']}>
        <span className={s['thinkingLabel']}>{label}</span>
        {!streaming && (
          <Button
            variant="ghost"
            className={s['thinkingToggle']}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? hideLabel : showLabel}
          </Button>
        )}
      </div>
      {shown && (
        <div id={bodyId} className={s['thinkingBody']}>
          {text}
          {streaming && <Cursor />}
        </div>
      )}
    </div>
  );
}

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
          {props.pointer !== undefined && props.pointer !== '' ? (
            <span className={s['pointer']} data-message-pointer="true" title={props.pointer}>
              {props.pointer}
            </span>
          ) : null}
          {props.text}
          {props.attachments !== undefined && props.attachments.length > 0 && (
            <span className={s['attachments']} data-message-attachments="true">
              {props.attachments.map((a, i) => (
                <span key={`${a.label}-${i}`} className={s['attachment']} data-kind={a.kind} title={a.label}>
                  {a.label}
                </span>
              ))}
            </span>
          )}
        </div>
      );
    case 'agent':
      return (
        <div
          ref={ref}
          data-kind="agent"
          data-streaming={props.streaming === true ? 'true' : undefined}
          className={cls(s['agent'])}
        >
          {props.children}
          {props.streaming === true && <Cursor />}
        </div>
      );
    case 'thinking': {
      const { compact: _c, className: _n, ...thinking } = props;
      return <ThinkingMessage {...thinking} className={cls(s['thinking'])} ref={ref} />;
    }
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
