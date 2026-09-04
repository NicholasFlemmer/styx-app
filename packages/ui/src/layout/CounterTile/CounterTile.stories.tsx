import type { Meta, StoryObj } from '@storybook/react-vite';
import { CounterTile, CounterStrip } from './CounterTile';

const meta = {
  title: 'Layout/CounterTile',
  component: CounterTile,
  args: { value: 2, label: 'Needs you' },
  decorators: [(Story) => <div style={{ width: 240 }}><Story /></div>],
} satisfies Meta<typeof CounterTile>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Live: Story = { args: { live: true } };
export const Zero: Story = { args: { value: 0, label: 'Locked' } };
export const Inverted: Story = { args: { inv: true } };

export const Strip: Story = {
  decorators: [(Story) => <div style={{ width: 980 }}><Story /></div>],
  render: () => (
    <CounterStrip>
      <CounterTile value={2} label="Needs you" live />
      <CounterTile value={4} label="Working" />
      <CounterTile value={1} label="Locked" />
      <CounterTile value={5} label="Projects" />
    </CounterStrip>
  ),
};

export const Matrix: Story = {
  decorators: [(Story) => <div style={{ width: 980 }}><Story /></div>],
  render: () => (
    <CounterStrip>
      <CounterTile value={2} label="default" />
      <CounterTile value={12} label="two digits" />
      <CounterTile value={0} label="inverted" inv />
      <CounterTile value={3} label="armed" on />
    </CounterStrip>
  ),
};
