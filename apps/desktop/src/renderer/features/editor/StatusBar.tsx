import s from './StatusBar.module.css';

export interface StatusBarProps {
  branch: string;
  /** Target items ("Vercel prod · open 58m", "Supabase · locked"). */
  targets: readonly string[];
  /** "Monaco · LF · TS" */
  editor: string;
  /** Appended after `editor`: caret, wrap, read-only notice (owner addition, discrepancies #58). */
  extras?: readonly string[];
  /** Before the coffee chip, as a plain item that is still a button: "Feedback" (owner request, #123). */
  feedback?: { label: string; title: string; onOpen: () => void };
  /** Last, as a filled accent chip: "☕ Buy us a coffee" (owner request, #120). */
  support?: { label: string; title: string; onOpen: () => void };
}

/** Editor status bar (26px, `--s1`): branch · targets in play · spacer · engine/eol/language · support. */
export function StatusBar({ branch, targets, editor, extras = [], feedback, support }: StatusBarProps) {
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
      {feedback !== undefined && (
        <button
          type="button"
          className={s['feedback']}
          title={feedback.title}
          onClick={feedback.onOpen}
          data-status-feedback="true"
        >
          {feedback.label}
        </button>
      )}
      {support !== undefined && (
        <button
          type="button"
          className={s['support']}
          title={support.title}
          onClick={support.onOpen}
          data-status-support="true"
        >
          {support.label}
        </button>
      )}
    </div>
  );
}
