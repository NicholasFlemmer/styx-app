import { forwardRef, useLayoutEffect, useRef, type HTMLAttributes, type UIEvent } from 'react';
import s from './Transcript.module.css';

export interface TranscriptProps extends HTMLAttributes<HTMLDivElement> {
  /** Pop-out chat: 12px padding, 10px gap, 12.5px type. */
  compact?: boolean;
  /** Distance from the bottom (px) within which new messages keep the view pinned. */
  pinThreshold?: number;
}

/** Scrolling message column: `role=log aria-live=polite`; stays pinned to the bottom while the reader is within 24px of it. */
export const Transcript = forwardRef<HTMLDivElement, TranscriptProps>(function Transcript(
  { compact, pinThreshold = 24, className, onScroll, children, ...rest },
  ref,
) {
  const inner = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const setRef = (node: HTMLDivElement | null) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= pinThreshold;
    onScroll?.(e);
  };

  useLayoutEffect(() => {
    const el = inner.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={setRef}
      role="log"
      aria-live="polite"
      className={[s['transcript'], compact ? s['compact'] : undefined, className].filter(Boolean).join(' ')}
      onScroll={handleScroll}
      {...rest}
    >
      {children}
    </div>
  );
});
