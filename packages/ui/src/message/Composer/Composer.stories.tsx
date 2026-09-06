import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from './Composer';

const meta = {
  title: 'Message/Composer',
  component: Composer,
  args: {
    placeholder: 'Message Claude…',
    hints: ['@file', '/command'],
    modelLabel: 'Model',
    sendLabel: '⏎ send',
    onSend: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, background: 'var(--s1)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Composer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Compact: Story = { args: { compact: true } };
export const Disabled: Story = { args: { disabled: true } };
export const NoModel: Story = { args: { modelLabel: undefined, hints: ['@file'] } };
/** `controls` replaces the Model ▾ hint: the app renders its permission / model / effort selects and Stop here. */
export const Controls: Story = {
  args: {
    controls: (
      <>
        <span>Permissions · Ask each time ▾</span>
        <span>Model · Default ▾</span>
        <button
          type="button"
          style={{
            font: 'inherit',
            letterSpacing: 'inherit',
            textTransform: 'inherit',
            color: 'inherit',
            background: 'transparent',
            border: 0,
            padding: 0,
          }}
        >
          Stop · esc
        </button>
      </>
    ),
  },
};

export const Matrix: Story = {
  render: (args) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: 740 }}>
      <Composer {...args} />
      <Composer {...args} compact placeholder="Message Codex…" />
      <Composer {...args} disabled />
      <Composer {...args} modelLabel="Sonnet 4.5" />
    </div>
  ),
};
