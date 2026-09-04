import type { CSSProperties, ReactElement, ReactNode } from 'react';

/** A matrix axis: plain string values, or `{ label, value }` pairs when the value is not a string. */
export type MatrixAxis<T> = readonly T[] | readonly { label: string; value: T }[];

export interface MatrixOptions {
  /** Caption for the row axis, rendered in the top-left cell. */
  rowTitle?: string;
  /** Caption for the column axis, rendered in the top-left cell after rowTitle. */
  colTitle?: string;
  /** Extra styles for each cell, e.g. `{ width: 200 }` for full-width variants. */
  cellStyle?: CSSProperties;
}

interface Labelled<T> {
  label: string;
  value: T;
}

function normalise<T>(axis: MatrixAxis<T>): Labelled<T>[] {
  return (axis as readonly unknown[]).map((item) =>
    typeof item === 'object' && item !== null && 'label' in item && 'value' in item
      ? (item as Labelled<T>)
      : { label: String(item), value: item as T },
  );
}

const labelStyle: CSSProperties = { display: 'flex', alignItems: 'center', minHeight: 'var(--sp-5)' };

/**
 * Renders a labelled rows × cols grid of `cell(row, col)`; labels use the `t-label` type class.
 * Use for variants × sizes / states matrices in stories.
 */
export function renderMatrix<R, C>(
  rows: MatrixAxis<R>,
  cols: MatrixAxis<C>,
  cell: (row: R, col: C) => ReactNode,
  opts: MatrixOptions = {},
): ReactElement {
  const rs = normalise(rows);
  const cs = normalise(cols);
  const corner = [opts.rowTitle, opts.colTitle].filter(Boolean).join(' × ');
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `max-content repeat(${cs.length}, max-content)`,
        gap: 'var(--sp-3) var(--sp-4)',
        alignItems: 'center',
      }}
    >
      <div className="t-label" style={labelStyle}>
        {corner}
      </div>
      {cs.map((c) => (
        <div key={`c-${c.label}`} className="t-label" style={labelStyle}>
          {c.label}
        </div>
      ))}
      {rs.map((r) => [
        <div key={`r-${r.label}`} className="t-label" style={labelStyle}>
          {r.label}
        </div>,
        ...cs.map((c) => (
          <div
            key={`${r.label}-${c.label}`}
            style={{ display: 'flex', alignItems: 'center', ...opts.cellStyle }}
          >
            {cell(r.value, c.value)}
          </div>
        )),
      ])}
    </div>
  );
}
