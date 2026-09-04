import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../../primitives';
import { Drawer, DrawerRow } from './Drawer';

const meta = {
  title: 'Overlay/Drawer',
  component: Drawer,
  parameters: { layout: 'fullscreen' },
  args: { onClose: () => {} },
  decorators: [
    (Story) => (
      <div
        style={{ position: 'relative', width: 900, height: 620, background: 'var(--s1)', overflow: 'hidden' }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Drawer>;
export default meta;
type Story = StoryObj<typeof meta>;

const rows = (
  <>
    <DrawerRow label="Actor">codex · pid 48122</DrawerRow>
    <DrawerRow label="Session">acme-shop · test/flaky</DrawerRow>
    <DrawerRow label="Target">supabase-prod</DrawerRow>
    <DrawerRow label="Scope">read schema, write</DrawerRow>
    <DrawerRow label="Duration">1h · expires 15:02</DrawerRow>
    <DrawerRow label="Command">psql -c "ALTER TABLE orders …"</DrawerRow>
  </>
);

export const Audit: Story = {
  args: {
    heading: 'Audit entry',
    title: 'Granted Codex write on Supabase prod',
    meta: '14:02 · you → supabase-prod',
    children: rows,
    footer: (
      <>
        <Button size="footer">Copy JSON</Button>
        <Button size="footer">Revoke now</Button>
      </>
    ),
  },
};

export const NoFooter: Story = {
  args: { heading: 'Audit entry', title: 'Denied Gemini deploy on Vercel prod', children: rows },
};

export const Matrix: Story = {
  args: { heading: 'Matrix' },
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
      <div style={{ position: 'relative', height: 420, border: '1px solid var(--ln)', overflow: 'hidden' }}>
        <Drawer
          onClose={() => {}}
          heading="Audit entry"
          title="Granted Codex write on Supabase prod"
          meta="14:02 · you → supabase-prod"
          footer={
            <>
              <Button size="footer">Copy JSON</Button>
              <Button size="footer">Revoke now</Button>
            </>
          }
        >
          {rows}
        </Drawer>
      </div>
      <div style={{ position: 'relative', height: 420, border: '1px solid var(--ln)', overflow: 'hidden' }}>
        <Drawer onClose={() => {}} heading="Audit entry" title="Denied Gemini deploy">
          {rows}
        </Drawer>
      </div>
    </div>
  ),
};
