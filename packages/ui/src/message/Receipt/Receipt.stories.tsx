import type { Meta, StoryObj } from '@storybook/react-vite';
import { Receipt } from './Receipt';

const meta = {
  title: 'Message/Receipt',
  component: Receipt,
  args: { title: 'Add a dark-mode switch to Settings', meta: 'Kept 09:12', state: 'kept' },
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Receipt>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Kept: Story = {};
export const Undone: Story = { args: { state: 'undone', meta: 'Undone 09:31' } };
export const Answered: Story = {
  args: { title: 'How does checkout total the cart?', state: 'answered', meta: 'Answered 10:02' },
};
export const LongTitle: Story = {
  args: { title: 'Add input validation to checkout and cover it with tests, including the empty cart' },
};
export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Receipt title="Add a dark-mode switch to Settings" meta="Kept 09:12" state="kept" />
      <Receipt title="Save the choice so it survives a reload" meta="Undone 09:31" state="undone" />
      <Receipt title="How does checkout total the cart?" meta="Answered 10:02" state="answered" />
    </div>
  ),
};
