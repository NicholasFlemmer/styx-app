import type { HTMLAttributes, ReactNode } from 'react';
import { Receipt, type ReceiptProps } from '../Receipt';
import s from './OpenTurn.module.css';

export interface OpenTurnProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The turn's receipt, which heads it while it is open. */
  title: string;
  meta: string;
  state: ReceiptProps['state'];
  /** Clicking the head folds the turn back to its receipt. */
  onFold: () => void;
  /** Rides on the head (the receipt button), e.g. a test hook. */
  headProps?: Record<`data-${string}`, string>;
  /** The turn's rows. */
  children: ReactNode;
}

/**
 * An earlier turn opened from its receipt (ADR-0027 §3): the receipt, in lime, heads it and a lime rule runs down
 * its rows, so where the opened turn starts and ends reads at a glance.
 */
export function OpenTurn({
  title,
  meta,
  state,
  onFold,
  headProps,
  children,
  className,
  ...rest
}: OpenTurnProps) {
  return (
    <div className={[s['turn'], className].filter(Boolean).join(' ')} {...rest}>
      <Receipt title={title} meta={meta} state={state} open onClick={onFold} {...headProps} />
      <div className={s['body']}>{children}</div>
    </div>
  );
}
