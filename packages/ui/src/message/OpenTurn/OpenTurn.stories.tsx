import type { Meta, StoryObj } from '@storybook/react-vite';
import { Receipt } from '../Receipt';
import { OpenTurn } from './OpenTurn';

const meta = {
  title: 'Message/OpenTurn',
  component: OpenTurn,
  args: {
    title: 'Add a dark-mode switch to Settings',
    meta: 'Kept 09:12',
    state: 'kept',
    onFold: () => {},
    children: (
      <>
        <div style={{ alignSelf: 'flex-end', padding: '8px 10px', background: 'var(--s2)' }}>
          Add a dark-mode switch to Settings
        </div>
        <div>Added the switch and saved the choice; 3 files changed.</div>
      </>
    ),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OpenTurn>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Undone: Story = { args: { state: 'undone', meta: 'Undone 09:31' } };
/** Among folded receipts, as the chat shows it. */
export const InThread: Story = {
  render: (args) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Receipt title="Set up the project" meta="Kept 08:40" state="kept" />
      <OpenTurn {...args} />
      <Receipt title="How does checkout total the cart?" meta="Answered 10:02" state="answered" />
    </div>
  ),
};
