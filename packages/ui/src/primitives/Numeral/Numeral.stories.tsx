import type { Meta, StoryObj } from '@storybook/react-vite';
import { Numeral, type NumeralSize } from './Numeral';
import { renderMatrix } from '../../storybook/matrix';

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

const sizes: NumeralSize[] = ['M', 'L'];
export const Matrix: Story = {
  render: () =>
    renderMatrix(
      sizes,
      ['default', 'inv', 'on'],
      (size, state) => <Numeral size={size} value={state === 'on' ? 0 : 12} inv={state === 'inv'} on={state === 'on'} />,
      { rowTitle: 'size', colTitle: 'state' },
    ),
};
