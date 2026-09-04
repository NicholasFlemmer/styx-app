import type { Meta, StoryObj } from '@storybook/react-vite';
import { RailTile } from './RailTile';

const meta = {
  title: 'Layout/RailTile',
  component: RailTile,
  args: { title: 'acme-shop' },
} satisfies Meta<typeof RailTile>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { initials: 'AS' } };
export const Active: Story = { args: { initials: 'AS', active: true } };
export const NeedsYou: Story = { args: { initials: 'BV', title: 'blog-v2', needs: true } };
export const ActiveNeedsYou: Story = { args: { initials: 'AS', active: true, needs: true } };
export const Add: Story = { args: { variant: 'add', title: 'New project' } };

export const Matrix: Story = {
  render: () => (
    <div style={{ width: 56, background: 'var(--s1)', borderRight: '1px solid var(--ln)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', gap: 8 }}>
      <RailTile initials="AS" title="acme-shop" active />
      <RailTile initials="BV" title="blog-v2" needs />
      <RailTile initials="IT" title="infra-tools" />
      <RailTile initials="CX" title="client-x" active needs />
      <RailTile initials="SA" title="side-api" inv />
      <RailTile variant="add" title="New project" />
    </div>
  ),
};
