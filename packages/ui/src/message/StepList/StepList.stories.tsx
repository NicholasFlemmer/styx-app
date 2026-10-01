import type { Meta, StoryObj } from '@storybook/react-vite';
import { StepList, type Step } from './StepList';

const steps: Step[] = [
  { key: '1', label: 'Read Settings.tsx', status: 'ok' },
  { key: '2', label: 'Searched for “usePref”', status: 'ok' },
  { key: '3', label: 'Edited theme.css', status: 'ok' },
  { key: '4', label: 'Ran pnpm test settings', status: 'running' },
];
const meta = {
  title: 'Message/StepList',
  component: StepList,
  args: {
    steps,
    summary: '4 steps',
    live: true,
    open: false,
    onToggle: () => {},
    showTools: false,
    onToggleTools: () => {},
    labels: { showTools: 'Show the tool calls', hideTools: 'Hide the tool calls' },
    tools: <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>Bash pnpm test settings</div>,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StepList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {};
export const LiveWithTools: Story = { args: { showTools: true } };
export const FinishedFolded: Story = {
  args: { live: false, steps: steps.map((s) => ({ ...s, status: 'ok' as const })) },
};
export const FinishedOpen: Story = { args: { live: false, open: true } };
export const WithFailure: Story = {
  args: {
    live: false,
    open: true,
    summary: '4 steps, 1 failed',
    steps: [...steps.slice(0, 3), { key: '4', label: 'Ran pnpm test settings', status: 'error' }],
  },
};
