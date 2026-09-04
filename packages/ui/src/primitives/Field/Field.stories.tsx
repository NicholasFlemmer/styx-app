import type { Meta, StoryObj } from '@storybook/react-vite';
import { Field } from './Field';
import { Input } from '../Input';
import { Textarea } from '../Textarea';
import { Select } from '../Select';

const meta = {
  title: 'Primitives/Field',
  component: Field,
  args: { label: 'Name', htmlFor: 'name', children: <Input id="name" mono defaultValue="orders-service" /> },
  decorators: [
    (Story) => (
      <div style={{ width: 360, background: 'var(--s1)', padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Field>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithInput: Story = {};
export const WithHint: Story = {
  args: {
    label: 'Template',
    htmlFor: 'tpl',
    children: (
      <Select
        id="tpl"
        options={[{ value: 'next', label: 'Next.js + Supabase (team template)' }]}
        width="100%"
      />
    ),
    hint: 'Templates are git repos tagged styx-template in your GitHub org, plus built-ins (Node, Python, Go, Rust, static).',
  },
};
export const WithTextarea: Story = {
  args: {
    label: 'Brief for Claude Code',
    htmlFor: 'brief',
    children: (
      <Textarea id="brief" defaultValue="A TypeScript service that receives Shopify order webhooks…" />
    ),
    hint: 'The agent scaffolds in an empty worktree on main, then pauses for your review before the first commit.',
  },
};

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
      <Field label="Name" htmlFor="m1">
        <Input id="m1" mono defaultValue="orders-service" />
      </Field>
      <Field label="Location" htmlFor="m2">
        <Input id="m2" mono defaultValue="~/code/orders-service" trailing="Browse" />
      </Field>
      <Field label="Secret" htmlFor="m3">
        <Input id="m3" masked defaultValue="••••••••" />
      </Field>
      <Field
        label="Host"
        htmlFor="m4"
        hint="Agents get a forwarded agent socket for the grant's duration, never the key file."
      >
        <Input id="m4" mono defaultValue="prod-1.acme.internal" />
      </Field>
    </div>
  ),
};
