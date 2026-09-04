import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tag, type TagTone, type TagSize } from './Tag';
import { renderMatrix } from '../../storybook/matrix';

const meta = {
  title: 'Primitives/Tag',
  component: Tag,
  args: { children: 'prod' },
} satisfies Meta<typeof Tag>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = { args: { tone: 'neutral', children: 'read' } };
export const Accent: Story = { args: { tone: 'accent', children: 'prod' } };
export const Agent: Story = { args: { tone: 'agent', children: 'CLAUDE' } };
export const Strong: Story = { args: { tone: 'strong', size: 'md', children: 'PROD' } };
export const MediumNeutral: Story = { args: { tone: 'neutral', size: 'md', children: 'POSTGRES' } };
export const Inverted: Story = { args: { tone: 'neutral', inv: true, children: 'fallback' } };

const tones: TagTone[] = ['neutral', 'accent', 'agent', 'strong'];
const sizes: TagSize[] = ['sm', 'md'];
export const Matrix: Story = {
  render: () =>
    renderMatrix<{ size: TagSize; tone: TagTone }, string>(
      sizes.flatMap((size) => tones.map((tone) => ({ label: `${size} · ${tone}`, value: { size, tone } }))),
      ['default', 'inv', 'on'],
      ({ size, tone }, state) => (
        <Tag tone={tone} size={size} inv={state === 'inv'} on={state === 'on'}>
          prod
        </Tag>
      ),
      { rowTitle: 'size · tone', colTitle: 'state' },
    ),
};
