import type { Meta, StoryObj } from '@storybook/react-vite';
import { Numeral } from './Numeral';

const meta = {
  title: 'Primitives/Numeral',
  component: Numeral,
  args: { value: 2 },
} satisfies Meta<typeof Numeral>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Medium: Story = { args: { size: 'M', value: 2 } };
export const Large: Story = { args: { size: 'L', value: 7 } };
export const Unpadded: Story = { args: { size: 'M', value: 7, pad: 0 } };
export const Inverted: Story = { args: { size: 'M', value: 1, inv: true } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: 16, alignItems: 'end', justifyContent: 'start' }}>
      <Numeral size="M" value={2} />
      <Numeral size="M" value={12} inv />
      <Numeral size="M" value={0} on />
      <Numeral size="L" value={2} />
      <Numeral size="L" value={12} inv />
      <Numeral size="L" value={0} on />
    </div>
  ),
};
