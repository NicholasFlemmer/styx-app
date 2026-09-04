import type { Meta, StoryObj } from '@storybook/react-vite';
import { Select } from './Select';

const policies = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'auto-read', label: 'Auto-approve reads' },
  { value: 'auto', label: 'Auto-approve' },
];
const themes = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const meta = {
  title: 'Primitives/Select',
  component: Select,
  args: { 'aria-label': 'Theme', options: themes, defaultValue: 'dark' },
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Targets170: Story = {
  args: { 'aria-label': 'Policy', options: policies, defaultValue: 'ask', width: 170 },
};
export const Disabled: Story = { args: { disabled: true } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, justifyContent: 'start' }}>
      <Select aria-label="a" options={themes} defaultValue="dark" />
      <Select aria-label="b" options={policies} defaultValue="ask" width={170} />
      <Select aria-label="c" options={themes} defaultValue="dark" disabled />
    </div>
  ),
};
