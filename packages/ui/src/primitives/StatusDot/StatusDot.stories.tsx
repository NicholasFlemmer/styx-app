import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusDot, type DotTone } from './StatusDot';

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
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(3, 24px)', gap: 12, alignItems: 'center', justifyContent: 'start' }}>
      {tones.map((tone) => (
        <div key={tone} style={{ display: 'contents' }}>
          <span className="t-label">{tone}</span>
          <StatusDot tone={tone} size={8} />
          <StatusDot tone={tone} size={7} />
          <StatusDot tone={tone} size={8} on />
        </div>
      ))}
    </div>
  ),
};
