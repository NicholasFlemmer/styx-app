import { forwardRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useTimeout } from '../../hooks';
import s from './Toast.module.css';

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** `--tx` text (Review); otherwise `--mu` (Later). */
  primary?: boolean;
}

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Accent header, left. Default "Needs you". */
  heading?: ReactNode;
  /** Accent header, right. Default "Styx · now". */
  meta?: ReactNode;
  /** 600 13px line, e.g. "Codex wants Supabase prod · write". */
  title: ReactNode;
  /** Mono 11.5px muted line. */
  detail?: ReactNode;
  actions?: ToastAction[];
  /** Auto-dismiss after ms (default 8000, spec §8); null never dismisses. Paused while hovered or focused. */
  ttl?: number | null;
  onDismiss?: () => void;
}

/** Top-right needs-you toast: 340px, `--tx` border, accent header, two footer actions; `role=status` announces politely. */
export const Toast = forwardRef<HTMLDivElement, ToastProps>(function Toast(
  {
    heading = 'Needs you',
    meta = 'Styx · now',
    title,
    detail,
    actions = [],
    ttl = 8000,
    onDismiss,
    className,
    ...rest
  },
  ref,
) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useTimeout(() => onDismiss?.(), ttl === null || paused || !onDismiss ? null : ttl);

  return (
    <div
      ref={ref}
      role="status"
      className={[s['toast'], className].filter(Boolean).join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      {...rest}
    >
      <div className={s['header']}>
        <span>{heading}</span>
        <span>{meta}</span>
      </div>
      <div className={s['body']}>
        <span className={s['title']}>{title}</span>
        {detail !== undefined && <span className={s['detail']}>{detail}</span>}
      </div>
      {actions.length > 0 && (
        <div className={s['actions']}>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={[s['action'], a.primary ? s['primary'] : ''].filter(Boolean).join(' ')}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
