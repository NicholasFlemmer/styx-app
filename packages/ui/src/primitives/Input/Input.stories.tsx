import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input } from './Input';
import { Button } from '../Button';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { defaultValue: 'orders-service', 'aria-label': 'Name' },
  decorators: [
    (Story) => (
      <div style={{ width: 320, background: 'var(--s1)', padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Placeholder: Story = {
  args: { defaultValue: '', placeholder: 'switch, spawn, deploy, grant…' },
};
export const Mono: Story = {
  args: { mono: true, defaultValue: 'prod-1.acme.internal', 'aria-label': 'Host' },
};
export const Masked: Story = {
  args: { masked: true, defaultValue: 'sk-live-000000000000', 'aria-label': 'Secret' },
};
export const Trailing: Story = {
  args: {
    mono: true,
    defaultValue: '~/.ssh/id_ed25519',
    'aria-label': 'Key',
    trailing: <Button variant="ghost">Browse</Button>,
  },
};
export const Disabled: Story = { args: { disabled: true } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <Input aria-label="a" defaultValue="Default 13px" />
      <Input aria-label="b" placeholder="Placeholder --mu" />
      <Input aria-label="c" mono defaultValue="mono 12.5px" />
      <Input aria-label="d" masked defaultValue="secret" />
      <Input
        aria-label="e"
        mono
        defaultValue="~/code/acme-shop"
        trailing={<Button variant="ghost">Browse</Button>}
      />
      <Input aria-label="f" disabled defaultValue="disabled" />
    </div>
  ),
};
