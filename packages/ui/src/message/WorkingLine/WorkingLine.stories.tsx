import type { Meta, StoryObj } from '@storybook/react-vite';
import { WorkingLine } from './WorkingLine';

const meta = {
  title: 'Message/WorkingLine',
  component: WorkingLine,
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: 14, background: 'var(--s1)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkingLine>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Thinking: Story = { args: { label: 'Thinking…', elapsedLabel: '4s' } };
export const Working: Story = { args: { label: 'Working…', elapsedLabel: '12s' } };
export const Tool: Story = { args: { label: 'Running Bash…', elapsedLabel: '37s' } };
export const NoElapsed: Story = { args: { label: 'Working…' } };
export const Compact: Story = { args: { label: 'Running Bash…', elapsedLabel: '37s', compact: true } };

export const Matrix: Story = {
  args: { label: 'Working…' },
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      {[false, true].map((compact) => (
        <div key={String(compact)} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <WorkingLine label="Thinking…" elapsedLabel="4s" compact={compact} />
          <WorkingLine label="Working…" elapsedLabel="12s" compact={compact} />
          <WorkingLine label="Running Bash…" elapsedLabel="37s" compact={compact} />
          <WorkingLine label="Working…" compact={compact} />
        </div>
      ))}
    </div>
  ),
};
