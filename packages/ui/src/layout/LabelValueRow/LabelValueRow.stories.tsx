import type { Meta, StoryObj } from '@storybook/react-vite';
import { LabelValueRow } from './LabelValueRow';
import { Select } from '../../primitives/Select';
import { Checkbox } from '../../primitives/Checkbox';

const themes = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const meta = {
  title: 'Layout/LabelValueRow',
  component: LabelValueRow,
  args: { label: 'Theme', control: <Select aria-label="Theme" options={themes} defaultValue="dark" /> },
  decorators: [(Story) => <div style={{ width: 640 }}><Story /></div>],
} satisfies Meta<typeof LabelValueRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Overridden: Story = { args: { overridden: true, onReset: () => {} } };
export const WithCheckbox: Story = {
  args: { label: 'Confirm before closing a session with pending hunks', control: <Checkbox checked aria-label="Confirm" /> },
};

export const Matrix: Story = {
  render: (a) => (
    <div>
      <LabelValueRow {...a} />
      <LabelValueRow {...a} label="Default shell" overridden onReset={() => {}} />
      <LabelValueRow {...a} label="Inverted row" inv />
    </div>
  ),
};
