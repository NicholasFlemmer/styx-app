import type { Meta, StoryObj } from '@storybook/react-vite';
import { Wordmark } from './Wordmark';

const meta = {
  title: 'Chrome/Wordmark',
  component: Wordmark,
} satisfies Meta<typeof Wordmark>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Inverted: Story = { args: { inv: true } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <Wordmark />
      <Wordmark inv />
      <Wordmark on />
    </div>
  ),
};
