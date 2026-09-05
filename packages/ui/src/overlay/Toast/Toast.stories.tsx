import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toast } from './Toast';

const meta = {
  title: 'Overlay/Toast',
  component: Toast,
  parameters: { layout: 'fullscreen' },
  args: {
    heading: 'Needs you',
    meta: 'Styx · now',
    title: 'Codex wants Supabase prod · write',
    detail: 'acme-shop · test/flaky · "migration 0042"',
    actions: [
      { label: 'Review', onClick: () => {}, primary: true },
      { label: 'Later', onClick: () => {} },
    ],
    ttl: null,
  },
  decorators: [
    (Story) => (
      <div style={{ position: 'relative', width: 900, height: 320, background: 'var(--bg)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Toast>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsYou: Story = {};
export const NoActions: Story = { args: { actions: [], detail: undefined } };
export const AutoDismiss: Story = { args: { ttl: 8000, onDismiss: () => {} } };

export const Matrix: Story = {
  render: (args) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
      <div style={{ position: 'relative', height: 200, border: '1px solid var(--ln)' }}>
        <Toast {...args} />
      </div>
      <div style={{ position: 'relative', height: 200, border: '1px solid var(--ln)' }}>
        <Toast
          {...args}
          heading="Done"
          meta="Claude · 2m"
          title="Claude finished fix/checkout"
          detail="42 passed"
          actions={[{ label: 'Open diff', onClick: () => {}, primary: true }]}
        />
      </div>
    </div>
  ),
};
