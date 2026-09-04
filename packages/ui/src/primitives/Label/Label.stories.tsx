import type { Meta, StoryObj } from '@storybook/react-vite';
import { Label } from './Label';

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
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: 12, justifyContent: 'start' }}>
      <Label>Project</Label>
      <Label inv>Project</Label>
      <Label on>Project</Label>
      <Label strong>Project</Label>
      <Label strong inv>Project</Label>
      <Label strong on>Project</Label>
    </div>
  ),
};
