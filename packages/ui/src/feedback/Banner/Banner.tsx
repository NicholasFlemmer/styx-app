import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Button } from '../../primitives/Button';
import { Icon } from '../../primitives/Icon';
import { StatusDot } from '../../primitives/StatusDot';
import s from './Banner.module.css';

export type BannerTone = 'error' | 'info';

export interface BannerAction {
  label: string;
  onClick: () => void;
}

export interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  /** error = accent square (role=alert); info = --ln square (role=status). */
  tone?: BannerTone;
  text: ReactNode;
  /** Compact secondary action (Reconnect, Review …). */
  action?: BannerAction;
  /** Shows the ✕ dismiss button. */
  onDismiss?: () => void;
  inv?: boolean;
  on?: boolean;
}

export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  { tone = 'error', text, action, onDismiss, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['banner'], className].filter(Boolean).join(' ');
  return (
    <div
      ref={ref}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cls}
      data-tone={tone}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      <StatusDot tone={tone === 'error' ? 'accent' : 'line'} size={8} />
      <span className={s['text']}>{text}</span>
      {action ? (
        <Button variant="secondary" size="compact" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {onDismiss ? (
        <button type="button" className={s['dismiss']} aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="close" />
        </button>
      ) : null}
    </div>
  );
});

export interface BannerStackProps extends HTMLAttributes<HTMLDivElement> {
  inv?: boolean;
  on?: boolean;
  children?: ReactNode;
}

/** Stacks banners under the titlebar. */
export const BannerStack = forwardRef<HTMLDivElement, BannerStackProps>(function BannerStack(
  { inv, on, className, ...rest },
  ref,
) {
  const cls = [s['stack'], className].filter(Boolean).join(' ');
  return <div ref={ref} className={cls} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined} {...rest} />;
});
