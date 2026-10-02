import type { Meta, StoryObj } from '@storybook/react-vite';
import { TurnResult, type TurnResultLabels } from './TurnResult';

const labels: TurnResultLabels = {
  showChanges: 'Show changes',
  undo: 'Undo this turn',
  undoAsk: 'Put the files back as they were before this turn?',
  undoConfirm: 'Undo it',
  undoCancel: 'Keep it',
  kept: 'Kept when you carry on',
  undone: 'Undone',
  busy: 'Wait for the agent to finish before undoing',
  before: 'Before',
  after: 'After',
};
const shot = (fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${fill}"/></svg>`)}`;

const meta = {
  title: 'Message/TurnResult',
  component: TurnResult,
  args: {
    done: 'Done in 4 min',
    change: '3 files, +42 −3',
    undone: false,
    busy: false,
    labels,
    onShowChanges: () => {},
    onUndo: () => {},
    children: (
      <p style={{ margin: 0 }}>
        “Match my system” is a third option, and the default. New visitors get whatever their computer uses.
      </p>
    ),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 380, padding: 16, background: 'var(--bg)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TurnResult>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Kept: Story = {};
export const WithScreenshots: Story = { args: { before: shot('#ffffff'), after: shot('#1b1f2a') } };
export const AgentBusy: Story = { args: { busy: true } };
export const Undone: Story = { args: { undone: true } };
export const Compact: Story = { args: { compact: true } };
export const Matrix: Story = {
  render: (args) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <TurnResult {...args} />
      <TurnResult {...args} before={shot('#ffffff')} after={shot('#1b1f2a')} />
      <TurnResult {...args} busy />
      <TurnResult {...args} undone />
    </div>
  ),
};
