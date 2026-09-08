import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionSet, type Question } from './QuestionSet';

afterEach(cleanup);

const props = {
  header: '2 questions',
  submitLabel: 'Send answers',
  freeTextPlaceholder: 'Or answer in your own words…',
};

const single: Question = {
  key: 'db',
  header: 'Storage',
  prompt: 'Which database?',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: 'Relational, what we know.' },
    { label: 'SQLite', description: null },
  ],
};

const multi: Question = {
  key: 'tests',
  header: null,
  prompt: 'Which tests?',
  multiSelect: true,
  options: [{ label: 'Unit' }, { label: 'E2E' }],
};

const freeOnly: Question = {
  key: 'notes',
  header: null,
  prompt: 'Anything else?',
  multiSelect: false,
  options: [],
};

describe('QuestionSet', () => {
  it('renders every question in one card with its header and option descriptions', () => {
    render(<QuestionSet {...props} questions={[single, multi]} onSubmit={vi.fn()} />);
    expect(screen.getByText('2 questions')).toBeTruthy();
    expect(screen.getByText('Storage')).toBeTruthy();
    expect(screen.getByText('Which database?')).toBeTruthy();
    expect(screen.getByText('Which tests?')).toBeTruthy();
    expect(screen.getByText('Relational, what we know.')).toBeTruthy();
  });

  it('single-select keeps one option; multi-select accumulates', async () => {
    const user = userEvent.setup();
    render(<QuestionSet {...props} questions={[single, multi]} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: /Postgres/ }));
    await user.click(screen.getByRole('radio', { name: /SQLite/ }));
    expect(screen.getByRole('radio', { name: /Postgres/ }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: /SQLite/ }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: /Unit/ }));
    await user.click(screen.getByRole('checkbox', { name: /E2E/ }));
    expect(screen.getByRole('checkbox', { name: /Unit/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: /E2E/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('submits one answer per question, keyed, with free text alongside the ticks', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<QuestionSet {...props} questions={[single, freeOnly]} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('radio', { name: /Postgres/ }));
    await user.type(screen.getAllByPlaceholderText(props.freeTextPlaceholder)[1] as HTMLElement, 'no');
    await user.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onSubmit).toHaveBeenCalledWith([
      { key: 'db', chosen: ['Postgres'], freeText: null },
      { key: 'notes', chosen: [], freeText: 'no' },
    ]);
  });

  it('cannot submit until every question has an answer', async () => {
    const user = userEvent.setup();
    render(<QuestionSet {...props} questions={[single, freeOnly]} onSubmit={vi.fn()} />);
    const submit = screen.getByRole('button', { name: 'Send answers' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('radio', { name: /Postgres/ }));
    expect(submit.hasAttribute('disabled')).toBe(true); // the free-text question is still blank
    await user.type(screen.getAllByPlaceholderText(props.freeTextPlaceholder)[1] as HTMLElement, 'no');
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('options and the free-text box are reachable by keyboard in order', async () => {
    const user = userEvent.setup();
    render(<QuestionSet {...props} questions={[single]} onSubmit={vi.fn()} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: /Postgres/ })).toBe(document.activeElement);
    await user.tab();
    expect(screen.getByRole('radio', { name: /SQLite/ })).toBe(document.activeElement);
    await user.tab();
    expect(screen.getByPlaceholderText(props.freeTextPlaceholder)).toBe(document.activeElement);
  });

  it('a resolved set is read-only and shows what was answered', () => {
    render(
      <QuestionSet
        {...props}
        questions={[single, freeOnly]}
        answers={[
          { key: 'db', chosen: ['Postgres'], freeText: null },
          { key: 'notes', chosen: [], freeText: 'ship it' },
        ]}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    expect(screen.getByText('Postgres')).toBeTruthy();
    expect(screen.getByText('ship it')).toBeTruthy();
  });

  it('disabled (resolved elsewhere) hides the controls too', () => {
    render(<QuestionSet {...props} questions={[single]} disabled onSubmit={vi.fn()} />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
  });
});
