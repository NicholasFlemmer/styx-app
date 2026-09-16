import type { Meta, StoryObj } from '@storybook/react';
import { QuestionSet, type Question } from './QuestionSet';

const single: Question[] = [
  {
    key: 'topology',
    header: 'Numbers',
    prompt: "What's the WhatsApp number topology?",
    multiSelect: false,
    options: [
      { label: 'One number, all AMs', description: 'Simplest to run; every reply comes from one identity.' },
      { label: 'One number per trading entity', description: 'Each entity keeps its own sender identity.' },
      { label: 'One shared + per-AM numbers', description: null },
    ],
  },
];

const many: Question[] = [
  ...single,
  {
    key: 'bot',
    header: 'Bot',
    prompt: 'What happens to the existing auto-reply bot?',
    multiSelect: true,
    options: [
      { label: 'Retire it', description: 'Triage takes over entirely.' },
      { label: 'Keep it for FAQ', description: 'Answers product questions only.' },
      { label: 'Keep it for lead capture', description: null },
    ],
  },
  { key: 'notes', header: null, prompt: 'Anything else we should know?', multiSelect: false, options: [] },
];

const args = {
  header: '3 questions',
  submitLabel: 'Send answers',
  freeTextPlaceholder: 'Or answer in your own words…',
  onSubmit: () => {},
};

const meta = {
  title: 'Message/QuestionSet',
  component: QuestionSet,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof QuestionSet>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Single: Story = { args: { ...args, header: '1 question', questions: single } };

export const Set: Story = { args: { ...args, questions: many } };

/** Multi-select renders the same square marker; several may be ticked at once. */
export const MultiSelect: Story = {
  args: { ...args, header: '1 question', questions: [many[1] as Question] },
};

/** No options: free text only. */
export const FreeTextOnly: Story = {
  args: { ...args, header: '1 question', questions: [many[2] as Question] },
};

/** Resolved: read-only, showing what was answered. */
export const Answered: Story = {
  args: {
    ...args,
    questions: many,
    answers: [
      { key: 'topology', chosen: ['One number, all AMs'], freeText: null },
      { key: 'bot', chosen: ['Keep it for FAQ', 'Keep it for lead capture'], freeText: null },
      { key: 'notes', chosen: [], freeText: 'Porting the number takes about two weeks.' },
    ],
  },
};

/** The ask was resolved or cancelled elsewhere (the board, the CLI). */
export const Disabled: Story = { args: { ...args, questions: single, disabled: true } };

const secret: Question[] = [
  {
    key: 'token',
    header: 'Deploy',
    prompt: 'Paste the Vercel deploy token for this run.',
    multiSelect: false,
    options: [],
    secret: true,
  },
];

/** Codex `requestUserInput` with `isSecret`: a masked input, no option chips, the value never reaches the transcript. */
export const Secret: Story = {
  args: {
    ...args,
    header: '1 question',
    questions: secret,
    secretPlaceholder: 'Secret · kept out of the transcript',
  },
};

/** Settled secret: the card shows the mask main stored, never the value. */
export const SecretAnswered: Story = {
  args: {
    ...args,
    header: '1 question',
    questions: secret,
    answers: [{ key: 'token', chosen: [], freeText: '••••••' }],
  },
};
