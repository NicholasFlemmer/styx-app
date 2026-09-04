import type { Meta, StoryObj } from '@storybook/react-vite';
import { Label } from './Label';
import { renderMatrix } from '../../storybook/matrix';

const meta = {
  title: 'Primitives/Label',
  component: Label,
  args: { children: 'Duration' },
} satisfies Meta<typeof Label>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Strong: Story = { args: { strong: true, children: 'Access request' } };
export const AsHeading: Story = { args: { as: 'h2', children: 'Files · 3' } };
export const AsFormLabel: Story = { args: { as: 'label', htmlFor: 'x', children: 'Secret' } };
export const Inverted: Story = { args: { inv: true, strong: true, children: 'Inbox' } };

export const Matrix: Story = {
  render: () =>
    renderMatrix<boolean, string>(
      [
        { label: 'label', value: false },
        { label: 'strong', value: true },
      ],
      ['default', 'inv', 'on'],
      (strong, state) => (
        <Label strong={strong} inv={state === 'inv'} on={state === 'on'}>
          Project
        </Label>
      ),
      { rowTitle: 'weight', colTitle: 'state' },
    ),
};
