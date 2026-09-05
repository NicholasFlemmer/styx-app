import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import s from './DiffBlock.module.css';
import { rowText, type DiffGutter, type DiffRow } from './diff-rows';

export interface DiffRowViewProps extends HTMLAttributes<HTMLDivElement> {
  row: DiffRow;
  gutter: DiffGutter;
  /** Lane rows drop the 16px inner padding. */
  lane?: boolean;
}

/** One line: `data-kind` drives the `--add` band and the muted `@@` header. */
export const DiffRowView = forwardRef<HTMLDivElement, DiffRowViewProps>(function DiffRowView(
  { row, gutter, lane, className, ...rest },
  ref,
) {
  const cls = [s['row'], lane && s['lane'], className].filter(Boolean).join(' ');
  return (
    <div ref={ref} className={cls} data-kind={row.kind} {...rest}>
      {rowText(row, gutter)}
    </div>
  );
});

export interface DiffBlockProps extends HTMLAttributes<HTMLDivElement> {
  rows: readonly DiffRow[];
  gutter?: DiffGutter;
  style?: CSSProperties;
}

/** Non-virtualized diff body (Diff review hunks are a handful of lines each). */
export const DiffBlock = forwardRef<HTMLDivElement, DiffBlockProps>(function DiffBlock(
  { rows, gutter = 'spaced', className, ...rest },
  ref,
) {
  const cls = [s['block'], className].filter(Boolean).join(' ');
  return (
    <div ref={ref} className={cls} data-diff-block="true" {...rest}>
      {rows.map((row, i) => (
        <DiffRowView key={i} row={row} gutter={gutter} />
      ))}
    </div>
  );
});
