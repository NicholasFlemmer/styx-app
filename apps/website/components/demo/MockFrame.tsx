'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './MockFrame.module.css';

export type Base = { readonly w: number; readonly h: number };

type Props = {
  /** Canvas size at the app's real pixel sizes. */
  full: Base;
  /** Optional narrower canvas used when the frame is thinner than `compactBelow`. */
  compact?: Base;
  compactBelow?: number;
  className?: string;
  children: ReactNode | ((compact: boolean) => ReactNode);
};

/**
 * Draws a mock at real pixel sizes and scales it as one piece to the width it is given. The frame's aspect
 * ratio reserves the space before measurement, so nothing jumps on load.
 */
export const MockFrame = ({ full, compact, compactBelow = 600, className, children }: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ k: number; compact: boolean } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = entry.contentRect.width;
      const useCompact = compact !== undefined && width < compactBelow;
      setFit({ k: width / (useCompact && compact ? compact.w : full.w), compact: useCompact });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [full.w, compact, compactBelow]);

  const isCompact = Boolean(fit?.compact) && compact !== undefined;
  const base = isCompact && compact ? compact : full;
  return (
    <div ref={ref} className={[styles.frame, className ?? ''].join(' ').trim()} style={{ aspectRatio: `${base.w} / ${base.h}` }}>
      <div className={styles.canvas} aria-hidden="true" style={{ width: base.w, height: base.h, transform: `scale(${fit?.k ?? 1})` }}>
        {typeof children === 'function' ? children(isCompact) : children}
      </div>
    </div>
  );
};
