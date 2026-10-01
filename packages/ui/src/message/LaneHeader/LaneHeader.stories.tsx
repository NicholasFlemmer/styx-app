import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../../primitives/Button';
import { LaneHeader } from './LaneHeader';

const meta = {
  title: 'Message/LaneHeader',
  component: LaneHeader,
  args: {
    agent: 'claude',
    agentName: 'Claude',
    branch: 'agent/claude-3',
    task: 'Dark mode on Settings',
    summary: '3 turns kept, 7 files changed',
    action: (
      <Button size="compact" variant="secondary">
        Land on main
      </Button>
    ),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 400, borderLeft: '1px solid var(--ln)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LaneHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NoChangesYet: Story = { args: { summary: 'No changes yet', action: undefined } };
export const LongTask: Story = {
  args: {
    task: 'Add input validation to checkout and cover it with tests, including the empty cart and expired coupons',
  },
};
export const WithTools: Story = {
  args: {
    tools: (
      <Button size="compact" variant="ghost">
        Pop out
      </Button>
    ),
  },
};
