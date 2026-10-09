import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChipGroup, type ChipGroupProps } from './ChipGroup';
import { Label } from '../Label';

const durations = [
  { value: 'once', label: 'once' },
  { value: '1h', label: '1h' },
  { value: 'session', label: 'session' },
  { value: 'always', label: 'always' },
];
const envs = [
  { value: 'dev', label: 'dev' },
  { value: 'preview', label: 'preview' },
  { value: 'prod', label: 'prod' },
];

function Controlled(props: Omit<ChipGroupProps, 'value' | 'onChange'> & { initial?: string | null }) {
  const { initial = null, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return <ChipGroup {...rest} value={value} onChange={setValue} />;
}

const meta = {
  title: 'Primitives/ChipGroup',
  component: ChipGroup,
  args: { options: durations, value: '1h', onChange: () => {}, 'aria-label': 'Duration' },
} satisfies Meta<typeof ChipGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Duration: Story = {
  render: (a) => (
    <div style={{ width: 332 }}>
      <Controlled {...a} initial="1h" />
    </div>
  ),
};
export const DurationNone: Story = {
  render: (a) => (
    <div style={{ width: 332 }}>
      <Controlled {...a} initial={null} />
    </div>
  ),
};
export const Env: Story = {
  args: { options: envs, layout: 'inline', size: 'env', 'aria-label': 'Environment' },
  render: (a) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <Label>Environment</Label>
      <Controlled {...a} initial="prod" />
    </div>
  ),
};
export const WithDisabled: Story = {
  args: { options: [...durations.slice(0, 3), { value: 'always', label: 'always', disabled: true }] },
  render: (a) => (
    <div style={{ width: 332 }}>
      <Controlled {...a} initial="once" />
    </div>
  ),
};

/** The grant sheet's duration chips for a production write on a target whose token can't be narrowed: once only. */
const onceOnly = durations.map((d) => ({ ...d, disabled: d.value !== 'once' }));
export const DurationOnceOnly: Story = {
  args: { options: onceOnly },
  render: (a) => (
    <div style={{ width: 332 }}>
      <Controlled {...a} initial="once" />
    </div>
  ),
};

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, width: 332 }}>
      <ChipGroup aria-label="d1" options={durations} value="1h" onChange={() => {}} />
      <ChipGroup aria-label="d2" options={durations} value={null} onChange={() => {}} />
      <ChipGroup aria-label="d3" options={onceOnly} value="once" onChange={() => {}} />
      <ChipGroup aria-label="e1" options={envs} value="prod" onChange={() => {}} layout="inline" size="env" />
      <ChipGroup aria-label="e2" options={envs} value={null} onChange={() => {}} layout="inline" size="env" />
    </div>
  ),
};
