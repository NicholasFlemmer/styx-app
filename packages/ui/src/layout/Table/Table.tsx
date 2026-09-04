import {
  createContext,
  forwardRef,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import s from './Table.module.css';

/** grid-template-columns per screen (prototype inline styles). */
export const TABLE_COLUMNS = {
  home: '1.2fr 1.6fr .9fr 1.4fr 1.4fr .8fr',
  repo: '1.2fr 1fr 1.6fr 1fr .7fr',
  targets: '1.4fr .7fr 1.4fr 1fr .6fr',
  onboardingIde: '20px 1.1fr 1.2fr 1fr auto',
  onboardingRepos: '20px 1fr 1fr',
  onboardingClis: '1.2fr 1.2fr 1fr auto',
} as const;

interface TableCtx {
  columns: string;
  rowPad: string;
  gap: string | undefined;
}
const Ctx = createContext<TableCtx>({ columns: '1fr', rowPad: '14px 20px', gap: undefined });

export interface TableProps extends HTMLAttributes<HTMLDivElement> {
  /** grid-template-columns string (see TABLE_COLUMNS). */
  columns: string;
  /** Header labels rendered as a t-label row with a hairline below. */
  header?: string[];
  /** Row padding; `14px 20px` by default, `12px 20px` in Targets, `10px 14px` in onboarding. */
  rowPad?: string;
  /** Column gap (onboarding tables use 14px). */
  gap?: string;
  inv?: boolean;
  on?: boolean;
  children?: ReactNode;
}

export const Table = forwardRef<HTMLDivElement, TableProps>(function Table(
  { columns, header, rowPad = '14px 20px', gap, inv, on, className, children, ...rest },
  ref,
) {
  const cls = [s['table'], className].filter(Boolean).join(' ');
  const gridStyle: CSSProperties = { gridTemplateColumns: columns, ...(gap ? { gap } : {}) };
  return (
    <Ctx.Provider value={{ columns, rowPad, gap }}>
      <div ref={ref} role="table" className={cls} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined} {...rest}>
        {header ? (
          <div role="row" className={s['header']} style={gridStyle}>
            {header.map((h, i) => (
              <span key={`${i}-${h}`} role="columnheader" className={s['headerCell']}>
                {h}
              </span>
            ))}
          </div>
        ) : null}
        {children}
      </div>
    </Ctx.Provider>
  );
});

export interface TableRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  /** Makes the row clickable: role=row tabIndex=0, Enter/Space activate, hover --s2. */
  onActivate?: (e: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void;
  /** Override the table's row padding for this row. */
  rowPad?: string;
  inv?: boolean;
  on?: boolean;
  children?: ReactNode;
}

export const TableRow = forwardRef<HTMLDivElement, TableRowProps>(function TableRow(
  { onActivate, rowPad, inv, on, className, style, onKeyDown, ...rest },
  ref,
) {
  const ctx = useContext(Ctx);
  const interactive = typeof onActivate === 'function';
  const cls = [s['row'], interactive && s['interactive'], className].filter(Boolean).join(' ');
  const rowStyle: CSSProperties = {
    gridTemplateColumns: ctx.columns,
    padding: rowPad ?? ctx.rowPad,
    ...(ctx.gap ? { gap: ctx.gap } : {}),
    ...style,
  };
  return (
    <div
      ref={ref}
      role="row"
      className={cls}
      style={rowStyle}
      tabIndex={interactive ? 0 : undefined}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      onClick={interactive ? (e) => onActivate(e) : undefined}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!interactive || e.defaultPrevented) return;
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(e);
        }
      }}
      {...rest}
    />
  );
});

export interface TableCellProps extends HTMLAttributes<HTMLSpanElement> {
  /** JetBrains Mono 12px. */
  mono?: boolean;
  /** --mu (inherits + opacity .7 inside inverted rows). */
  muted?: boolean;
  /** 600. */
  strong?: boolean;
  /** t-label styling for trailing action cells (OPEN, REVOKE …). */
  label?: boolean;
  align?: 'start' | 'end';
  children?: ReactNode;
}

export const TableCell = forwardRef<HTMLSpanElement, TableCellProps>(function TableCell(
  { mono, muted, strong, label, align, className, ...rest },
  ref,
) {
  const cls = [
    s['cell'],
    mono && s['mono'],
    muted && s['muted'],
    strong && s['strong'],
    label && s['label'],
    align === 'end' && s['end'],
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <span ref={ref} role="cell" className={cls} data-muted={muted ? 'true' : undefined} {...rest} />;
});
