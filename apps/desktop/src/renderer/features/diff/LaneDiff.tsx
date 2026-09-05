import type { UnifiedDiff } from '@styx/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, type HTMLAttributes } from 'react';
import { DiffRowView } from './DiffBlock';
import { laneRows } from './diff-rows';
import s from './LaneDiff.module.css';

/** Row pitch: prototype lane diff is 12px × 1.75 line-height. */
export const LANE_ROW_PX = 21;
const LANE_PAD_PX = 10;

export interface LaneDiffProps extends HTMLAttributes<HTMLDivElement> {
  diff: UnifiedDiff;
}

/** Repo lane diff: the selected worktree's unified diff, virtualized (@tanstack/react-virtual, 21px rows). */
export function LaneDiff({ diff, className, ...rest }: LaneDiffProps) {
  const rows = useMemo(() => laneRows(diff), [diff]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LANE_ROW_PX,
    overscan: 16,
    paddingStart: LANE_PAD_PX,
    paddingEnd: LANE_PAD_PX,
  });
  const cls = [s['lane'], className].filter(Boolean).join(' ');
  return (
    <div ref={scrollRef} className={cls} data-lane-diff="true" data-rows={rows.length} {...rest}>
      <div className={s['inner']} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          return (
            <DiffRowView
              key={item.key}
              row={row}
              gutter="compact"
              lane
              className={s['row']}
              data-index={item.index}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            />
          );
        })}
      </div>
    </div>
  );
}
