import { useState, type ChangeEvent } from 'react';
import { Button } from '../../primitives/Button';
import s from './QuestionSet.module.css';

export interface QuestionOption {
  label: string;
  /** The agent's rationale for this option; rendered under the label so options can be told apart. */
  description?: string | null;
}

export interface Question {
  /** Stable within the set: answers are keyed by this. */
  key: string;
  /** Short category label above the prompt (e.g. "Numbers"), uppercased by the style. */
  header?: string | null;
  prompt: string;
  /** Several options may be ticked; renders squares instead of dots. */
  multiSelect: boolean;
  options: readonly QuestionOption[];
}

export interface QuestionAnswer {
  key: string;
  chosen: string[];
  freeText: string | null;
}

export interface QuestionSetProps {
  questions: readonly Question[];
  /** Set once resolved: the card renders read-only with the answers shown. */
  answers?: readonly QuestionAnswer[] | null;
  /** The ask is no longer open (resolved or cancelled elsewhere): the card renders read-only. */
  disabled?: boolean;
  onSubmit: (answers: QuestionAnswer[]) => void;
  /** Header for the set, e.g. "4 questions" (app: `copy.session.questions.header`). */
  header: string;
  submitLabel: string;
  freeTextPlaceholder: string;
  compact?: boolean;
  className?: string;
}

type Draft = Record<string, { chosen: string[]; freeText: string }>;

const emptyDraft = (questions: readonly Question[]): Draft =>
  Object.fromEntries(questions.map((q) => [q.key, { chosen: [], freeText: '' }]));

/** A question counts as answered once it has a ticked option or non-blank free text. */
const answered = (d: Draft[string] | undefined): boolean =>
  d !== undefined && (d.chosen.length > 0 || d.freeText.trim() !== '');

/**
 * A whole `AskUserQuestion` set as one card: every question is visible at once and submitted together, rather
 * than queued one at a time. Each question takes ticked options (single or multi) and free text, so the reader
 * is never forced into the agent's list.
 */
export function QuestionSet({
  questions,
  answers = null,
  disabled = false,
  onSubmit,
  header,
  submitLabel,
  freeTextPlaceholder,
  compact,
  className,
}: QuestionSetProps) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(questions));
  const settled = disabled || answers !== null;

  const toggle = (q: Question, label: string) =>
    setDraft((d) => {
      const cur = d[q.key] ?? { chosen: [], freeText: '' };
      const has = cur.chosen.includes(label);
      const chosen = q.multiSelect
        ? has
          ? cur.chosen.filter((l) => l !== label)
          : [...cur.chosen, label]
        : has
          ? []
          : [label];
      return { ...d, [q.key]: { ...cur, chosen } };
    });

  const setFreeText = (q: Question, e: ChangeEvent<HTMLTextAreaElement>) =>
    setDraft((d) => ({
      ...d,
      [q.key]: { ...(d[q.key] ?? { chosen: [], freeText: '' }), freeText: e.target.value },
    }));

  const submit = () =>
    onSubmit(
      questions.map((q) => {
        const cur = draft[q.key] ?? { chosen: [], freeText: '' };
        return {
          key: q.key,
          chosen: cur.chosen,
          freeText: cur.freeText.trim() === '' ? null : cur.freeText.trim(),
        };
      }),
    );

  // Every question must carry an answer before the set can go back, so a partial reply never reaches the agent.
  const complete = questions.every((q) => answered(draft[q.key]));

  return (
    <div
      data-kind="questions"
      data-settled={settled ? 'true' : undefined}
      className={[s['card'], compact ? s['compact'] : undefined, className].filter(Boolean).join(' ')}
    >
      <div className={s['head']}>{header}</div>
      {questions.map((q, i) => {
        const given = answers?.find((a) => a.key === q.key) ?? null;
        const cur = draft[q.key] ?? { chosen: [], freeText: '' };
        const labelId = `q-${i}`;
        return (
          <div key={q.key} className={s['q']}>
            {q.header ? <div className={s['qHeader']}>{q.header}</div> : null}
            <div className={s['prompt']} id={labelId}>
              {q.prompt}
            </div>
            {settled ? (
              <div className={s['given']}>
                {given === null
                  ? ''
                  : (given.freeText ?? (given.chosen.length > 0 ? given.chosen.join(', ') : ''))}
              </div>
            ) : (
              <>
                {q.options.length > 0 ? (
                  <div
                    className={s['options']}
                    role={q.multiSelect ? 'group' : 'radiogroup'}
                    aria-labelledby={labelId}
                  >
                    {q.options.map((o) => {
                      const on = cur.chosen.includes(o.label);
                      return (
                        <button
                          key={o.label}
                          type="button"
                          role={q.multiSelect ? 'checkbox' : 'radio'}
                          aria-checked={on}
                          data-on={on ? 'true' : undefined}
                          className={s['option']}
                          onClick={() => toggle(q, o.label)}
                        >
                          <span className={s['box']} data-multi={q.multiSelect ? 'true' : undefined} />
                          <span className={s['optionText']}>
                            <span className={s['optionLabel']}>{o.label}</span>
                            {o.description ? <span className={s['optionDesc']}>{o.description}</span> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <textarea
                  className={s['free']}
                  rows={q.options.length > 0 ? 1 : 3}
                  placeholder={freeTextPlaceholder}
                  aria-labelledby={labelId}
                  value={cur.freeText}
                  onChange={(e) => setFreeText(q, e)}
                />
              </>
            )}
          </div>
        );
      })}
      {settled ? null : (
        <div className={s['foot']}>
          <Button size="compact" variant="primary" disabled={!complete} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
