import type { Meta, StoryObj } from '@storybook/react-vite';
import { SnakeBoard, type SnakeBoardCell, type SnakeBoardLabels } from './SnakeBoard';

const labels = (over: Partial<SnakeBoardLabels> = {}): SnakeBoardLabels => ({
  title: 'Snake',
  score: 'Score',
  best: 'best 57',
  newBest: 'new best',
  state: 'Ready',
  hint: '⏎ or an arrow to start · hjkl works too',
  board: 'Snake board · score 0',
  quit: 'Quit Snake',
  ...over,
});

const snake: SnakeBoardCell[] = [
  { x: 10, y: 8 },
  { x: 9, y: 8 },
  { x: 8, y: 8 },
];

const long: SnakeBoardCell[] = [
  { x: 6, y: 3 },
  { x: 6, y: 4 },
  { x: 6, y: 5 },
  { x: 7, y: 5 },
  { x: 8, y: 5 },
  { x: 9, y: 5 },
  { x: 9, y: 6 },
  { x: 9, y: 7 },
  { x: 8, y: 7 },
  { x: 7, y: 7 },
  { x: 6, y: 7 },
  { x: 5, y: 7 },
];

const noop = () => {};

const meta = {
  title: 'Arcade/SnakeBoard',
  component: SnakeBoard,
  args: {
    cols: 20,
    rows: 16,
    snake,
    food: { x: 15, y: 4 },
    score: 0,
    phase: 'ready',
    labels: labels(),
    cell: 16,
    onDirection: noop,
    onStart: noop,
    onPause: noop,
    onQuit: noop,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: 14, background: 'var(--s1)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SnakeBoard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const Playing: Story = {
  args: {
    snake: long,
    score: 9,
    phase: 'playing',
    labels: labels({ state: '', hint: 'Space pauses · Esc quits', board: 'Snake board · score 9' }),
  },
};

export const Paused: Story = {
  args: {
    snake: long,
    score: 9,
    phase: 'paused',
    labels: labels({
      state: 'Paused',
      hint: 'Paused · any arrow to continue',
      board: 'Snake board · score 9',
    }),
  },
};

export const Countdown: Story = {
  args: {
    snake: long,
    score: 9,
    phase: 'paused',
    countdown: 3,
    labels: labels({ state: 'Paused', hint: '3' }),
  },
};

export const Over: Story = {
  args: {
    snake: long,
    score: 12,
    phase: 'over',
    labels: labels({ state: 'Game over', hint: 'Game over · ⏎ to play again · Esc quits' }),
  },
};

export const NewBest: Story = {
  args: {
    snake: long,
    score: 58,
    phase: 'playing',
    bestBeaten: true,
    labels: labels({ state: '', hint: 'Space pauses · Esc quits' }),
  },
};

export const SmallCells: Story = {
  args: {
    cell: 12,
    snake: long,
    score: 9,
    phase: 'playing',
    labels: labels({ state: '', hint: 'Space pauses · Esc quits' }),
  },
};

export const Matrix: Story = {
  render: (args) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      <SnakeBoard {...args} cell={12} />
      <SnakeBoard
        {...args}
        cell={12}
        snake={long}
        score={9}
        phase="playing"
        labels={labels({ state: '', hint: 'Space pauses · Esc quits' })}
      />
      <SnakeBoard
        {...args}
        cell={12}
        snake={long}
        score={9}
        phase="paused"
        countdown={2}
        labels={labels({ state: 'Paused', hint: '2' })}
      />
      <SnakeBoard
        {...args}
        cell={12}
        snake={long}
        score={58}
        phase="over"
        bestBeaten
        labels={labels({ state: 'Game over', hint: 'Game over · ⏎ to play again · Esc quits' })}
      />
    </div>
  ),
};
