import s from './StatusBar.module.css';

export interface StatusBarProps {
  branch: string;
  /** Target items ("Vercel prod · open 58m", "Supabase · locked"). */
  targets: readonly string[];
  /** "Monaco · LF · TS" */
  editor: string;
}

/** Editor status bar (26px, `--s1`): branch · targets in play · spacer · engine/eol/language. */
export function StatusBar({ branch, targets, editor }: StatusBarProps) {
  return (
    <div className={s['bar']} data-status-bar="true">
      <span>{branch}</span>
      {targets.map((t) => (
        <span key={t}>{t}</span>
      ))}
      <span className={s['spacer']} />
      <span>{editor}</span>
    </div>
  );
}
