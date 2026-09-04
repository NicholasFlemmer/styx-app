import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tag, type TagTone, type TagSize } from './Tag';

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
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(3, auto)', gap: 12, alignItems: 'center', justifyContent: 'start' }}>
      {sizes.map((size) =>
        tones.map((tone) => (
          <div key={`${size}-${tone}`} style={{ display: 'contents' }}>
            <span className="t-label">{size} · {tone}</span>
            <Tag tone={tone} size={size}>prod</Tag>
            <Tag tone={tone} size={size} inv>prod</Tag>
            <Tag tone={tone} size={size} on>prod</Tag>
          </div>
        )),
      )}
    </div>
  ),
};
