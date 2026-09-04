import type { Meta, StoryObj } from '@storybook/react-vite';
import { TitlebarCounter } from './TitlebarCounter';

const meta = {
  title: 'Chrome/TitlebarCounter',
  component: TitlebarCounter,
  args: { count: 2, label: 'needs you', tone: 'accent', live: true },
} satisfies Meta<typeof TitlebarCounter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsYou: Story = {};
export const Locked: Story = { args: { count: 1, label: 'locked', tone: 'hollowStrong', live: false } };
export const Zero: Story = { args: { count: 0 } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', background: 'var(--s1)', padding: 12 }}>
      <TitlebarCounter count={2} label="needs you" tone="accent" live />
      <TitlebarCounter count={0} label="needs you" tone="accent" />
      <TitlebarCounter count={1} label="locked" tone="hollowStrong" />
      <TitlebarCounter count={12} label="locked" tone="hollowStrong" inv />
    </div>
  ),
};
