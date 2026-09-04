import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusDot, type DotTone, type DotSize } from './StatusDot';
import { renderMatrix } from '../../storybook/matrix';

const meta = {
  title: 'Primitives/StatusDot',
  component: StatusDot,
} satisfies Meta<typeof StatusDot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Accent: Story = { args: { tone: 'accent', label: 'needs you' } };
export const Text: Story = { args: { tone: 'text', label: 'working' } };
export const Line: Story = { args: { tone: 'line', label: 'idle' } };
export const Hollow: Story = { args: { tone: 'hollow' } };
export const HollowStrong: Story = { args: { tone: 'hollowStrong', label: 'locked' } };
export const HollowArmed: Story = { args: { tone: 'hollow', on: true, label: 'needs you' } };
export const Small: Story = { args: { tone: 'accent', size: 7 } };

const tones: DotTone[] = ['accent', 'text', 'line', 'hollow', 'hollowStrong'];
export const Matrix: Story = {
  render: () =>
    renderMatrix<DotTone, { size: DotSize; on: boolean }>(
      tones,
      [
        { label: '8', value: { size: 8 as const, on: false } },
        { label: '7', value: { size: 7 as const, on: false } },
        { label: '8 · on', value: { size: 8 as const, on: true } },
      ],
      (tone, { size, on }) => <StatusDot tone={tone} size={size} on={on} />,
      { rowTitle: 'tone', colTitle: 'size' },
    ),
};
