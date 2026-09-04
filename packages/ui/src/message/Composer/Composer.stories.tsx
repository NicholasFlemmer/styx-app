import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from './Composer';

const meta = {
  title: 'Message/Composer',
  component: Composer,
  args: { placeholder: 'Message Claude…', onSend: () => {} },
  decorators: [
    (Story) => (
      <div style={{ width: 360, background: 'var(--s1)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Composer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Compact: Story = { args: { compact: true } };
export const Disabled: Story = { args: { disabled: true } };
export const NoModel: Story = { args: { modelLabel: undefined, hints: ['@file'] } };

export const Matrix: Story = {
  render: (args) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: 740 }}>
      <Composer {...args} />
      <Composer {...args} compact placeholder="Message Codex…" />
      <Composer {...args} disabled />
      <Composer {...args} modelLabel="Sonnet 4.5" />
    </div>
  ),
};
