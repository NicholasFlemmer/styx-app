import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox, type CheckboxProps } from './Checkbox';

function Controlled(props: Omit<CheckboxProps, 'checked' | 'onChange'> & { initial?: boolean }) {
  const { initial = false, ...rest } = props;
  const [checked, setChecked] = useState(initial);
  return <Checkbox {...rest} checked={checked} onChange={setChecked} />;
}

const meta = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  args: { checked: false, label: 'Import keybindings' },
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = { render: (a) => <Controlled {...a} initial={false} /> };
export const Checked: Story = { render: (a) => <Controlled {...a} initial /> };
export const Policy16Accent: Story = {
  args: { size: 16, tone: 'accent', label: 'Auto-approve preview deploys' },
  render: (a) => <Controlled {...a} initial />,
};
export const LabelStart: Story = {
  args: { label: 'Read schema', labelSide: 'start' },
  render: (a) => (
    <div style={{ width: 300, border: '1px solid var(--ln)', padding: '8px 10px' }}>
      <Controlled {...a} initial />
    </div>
  ),
};
export const Disabled: Story = {
  args: { disabled: true, label: 'Delete / drop' },
  render: (a) => <Controlled {...a} />,
};
export const NoLabel: Story = {
  args: { label: undefined, 'aria-label': 'Select repo' },
  render: (a) => <Controlled {...a} />,
};

export const Matrix: Story = {
  render: () => (
    <div
      style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto)', gap: 12, justifyContent: 'start' }}
    >
      <Checkbox checked={false} label="14 · off" />
      <Checkbox checked label="14 · on" />
      <Checkbox checked={false} size={16} tone="accent" label="16 accent · off" />
      <Checkbox checked size={16} tone="accent" label="16 accent · on" />
      <Checkbox checked={false} disabled label="disabled" />
      <Checkbox checked disabled label="disabled · on" />
    </div>
  ),
};
