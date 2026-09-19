import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from './Card';
import { Button } from '../../primitives/Button';

const meta = {
  title: 'Layout/Card',
  component: Card,
  args: {
    agent: 'Claude',
    age: '14m',
    project: 'acme-shop',
    branch: 'fix/checkout',
    note: 'Added validation, 42 tests pass. Asking to open a PR.',
    actions: <Button>Open</Button>,
  },
  decorators: [(Story) => <div style={{ width: 340, borderRight: '1px solid var(--ln)' }}><Story /></div>],
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = { args: { tone: 'working' } };
export const NeedsYou: Story = {
  args: {
    tone: 'needs',
    agent: 'Codex',
    age: '3m',
    branch: 'test/flaky',
    note: 'Requesting Supabase prod · read + write',
    actions: (
      <>
        <Button>Review grant</Button>
        <Button variant="ghost">Deny</Button>
      </>
    ),
  },
};
export const Done: Story = {
  args: { tone: 'done', agent: 'Cursor', age: '1d', branch: 'feat/promo', note: 'PR #212 opened, merged yesterday', actions: <><Button>Reopen</Button><Button variant="ghost">Archive</Button></> },
};
export const Idle: Story = { args: { agent: 'Gemini', age: '—', branch: 'docs', note: 'Idle' } };

export const Matrix: Story = {
  render: (a) => (
    <div>
      <Card {...a} tone="needs" agent="Codex" note="Requesting Supabase prod · read + write" actions={<><Button>Review grant</Button><Button variant="ghost">Deny</Button></>} />
      <Card {...a} tone="working" />
      <Card {...a} tone="done" agent="Cursor" note="PR #212 opened, merged yesterday" actions={<><Button>Reopen</Button><Button variant="ghost">Archive</Button></>} />
      <Card {...a} tone="working" inv />
    </div>
  ),
};
