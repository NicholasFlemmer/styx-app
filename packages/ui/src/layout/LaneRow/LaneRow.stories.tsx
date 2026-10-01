import type { Meta, StoryObj } from '@storybook/react-vite';
import { LaneRow } from './LaneRow';

const meta = {
  title: 'Layout/LaneRow',
  component: LaneRow,
  args: { agent: 'claude', task: 'Dark mode on Settings', status: 'Working, 2m' },
  decorators: [
    (Story) => (
      <div style={{ width: 216, borderRight: '1px solid var(--ln)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LaneRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};
export const Current: Story = { args: { inv: true } };
export const YourTurn: Story = {
  args: { agent: 'codex', task: 'Fix the flaky orders test', status: 'Your turn', tone: 'yours' },
};
export const YourTurnCurrent: Story = { args: { ...YourTurn.args, inv: true } };
export const Landed: Story = {
  args: { agent: 'cursor', task: 'Promo banner', status: 'Landed 1d ago', tone: 'quiet' },
};
export const LongTask: Story = {
  args: {
    task: 'Add input validation to checkout and cover it with tests, including the empty-cart and expired-coupon cases',
  },
};

/** The project nav's work list, in the order it shows (ADR-0027 §1). */
export const Matrix: Story = {
  render: () => (
    <div style={{ width: 216 }}>
      <LaneRow agent="codex" task="Fix the flaky orders test" status="Your turn" tone="yours" />
      <LaneRow agent="claude" task="Dark mode on Settings" status="Working, 2m" inv />
      <LaneRow agent="gemini" task="Explain checkout" status="Waiting for you" />
      <LaneRow agent="shell" task="npm run build" status="Ready to land" />
      <LaneRow agent="cursor" task="Promo banner" status="Landed 1d ago" tone="quiet" />
    </div>
  ),
};
