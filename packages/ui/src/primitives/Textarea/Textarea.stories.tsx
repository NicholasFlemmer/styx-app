import type { Meta, StoryObj } from '@storybook/react-vite';
import { Textarea } from './Textarea';

const meta = {
  title: 'Primitives/Textarea',
  component: Textarea,
  args: {
    'aria-label': 'Brief for Claude Code',
    defaultValue:
      'A TypeScript service that receives Shopify order webhooks, validates them, and writes to Supabase. Include tests and a Dockerfile.',
  },
  decorators: [(Story) => <div style={{ width: 420, background: 'var(--s1)', padding: 16 }}><Story /></div>],
} satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Placeholder: Story = { args: { defaultValue: '', placeholder: 'Message Claude…' } };
export const Mono: Story = { args: { mono: true, minHeight: 96 } };
export const Disabled: Story = { args: { disabled: true } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <Textarea aria-label="a" defaultValue="default · 64" />
      <Textarea aria-label="b" placeholder="placeholder" />
      <Textarea aria-label="c" mono defaultValue="mono" />
      <Textarea aria-label="d" disabled defaultValue="disabled" />
    </div>
  ),
};
