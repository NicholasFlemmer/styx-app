import type { Meta, StoryObj } from '@storybook/react-vite';
import { AgentDot, type AgentKind } from './AgentDot';

const meta = {
  title: 'Primitives/AgentDot',
  component: AgentDot,
  args: { agent: 'claude' },
} satisfies Meta<typeof AgentDot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Claude: Story = {};
export const Codex: Story = { args: { agent: 'codex' } };
export const Gemini: Story = { args: { agent: 'gemini' } };
export const Cursor: Story = { args: { agent: 'cursor' } };
export const OpenCode: Story = { args: { agent: 'opencode' } };
export const Shell: Story = { args: { agent: 'shell' } };

const ALL: AgentKind[] = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'shell'];
const NAME: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  shell: 'Shell',
};

/** Each agent beside its name, the only way the square is used. */
export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
      {ALL.map((a) => (
        <span key={a} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AgentDot agent={a} />
          {NAME[a]}
        </span>
      ))}
    </div>
  ),
};
