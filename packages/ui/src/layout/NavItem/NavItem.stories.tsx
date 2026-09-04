import type { Meta, StoryObj } from '@storybook/react-vite';
import { NavItem } from './NavItem';

const meta = {
  title: 'Layout/NavItem',
  component: NavItem,
  args: { label: 'Workspace', meta: '3' },
  decorators: [(Story) => <div style={{ width: 168, borderRight: '1px solid var(--ln)' }}><Story /></div>],
} satisfies Meta<typeof NavItem>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Current: Story = { args: { inv: true } };
export const WithoutMeta: Story = { args: { meta: undefined, label: 'Approvals' } };
export const Dense: Story = { args: { dense: true, meta: undefined, label: 'Targets' } };
export const DenseCurrent: Story = { args: { dense: true, meta: undefined, label: 'Targets', inv: true } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '168px 220px', gap: 24, alignItems: 'start' }}>
      <div style={{ borderRight: '1px solid var(--ln)' }}>
        <NavItem label="Workspace" meta="3" inv />
        <NavItem label="Agents" meta="2 !" />
        <NavItem label="Repo" meta="fix/checkout" />
        <NavItem label="Approvals" meta="1" on />
        <NavItem label="Settings" />
      </div>
      <div style={{ borderRight: '1px solid var(--ln)' }}>
        <NavItem dense label="General" />
        <NavItem dense label="Targets" inv />
        <NavItem dense label="Agents" />
        <NavItem dense label="Editor" />
      </div>
    </div>
  ),
};
