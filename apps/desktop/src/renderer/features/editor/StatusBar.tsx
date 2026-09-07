import s from './StatusBar.module.css';

export interface StatusBarProps {
  branch: string;
  /** Target items ("Vercel prod · open 58m", "Supabase · locked"). */
  targets: readonly string[];
  /** "Monaco · LF · TS" */
  editor: string;
  /** Appended after `editor`: caret, wrap, read-only notice (owner addition, discrepancies #58). */
  extras?: readonly string[];
}

/** Editor status bar (26px, `--s1`): branch · targets in play · spacer · engine/eol/language. */
export function StatusBar({ branch, targets, editor, extras = [] }: StatusBarProps) {
  return (
    <div className={s['bar']} data-status-bar="true">
      <span>{branch}</span>
      {targets.map((t) => (
        <span key={t}>{t}</span>
      ))}
      <span className={s['spacer']} />
      <span>{editor}</span>
      {extras.map((x) => (
        <span key={x}>{x}</span>
      ))}
    </div>
  );
}
