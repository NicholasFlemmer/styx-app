import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../../primitives';
import { Sheet, SheetAccentHeader, SheetFooter } from './Sheet';

const meta = {
  title: 'Overlay/Sheet',
  component: Sheet,
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
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

const label: React.CSSProperties = {
  padding: '16px 0 6px',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: 'var(--mu)',
};

const grantBody = (
  <>
    <div style={{ padding: '0 0 14px', display: 'flex', gap: 6 }}>
      <span
        style={{
          padding: '2px 6px',
          border: '1px solid var(--tx)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '.1em',
        }}
      >
        PROD
      </span>
      <span
        style={{
          padding: '2px 6px',
          border: '1px solid var(--ln)',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '.1em',
          color: 'var(--mu)',
        }}
      >
        POSTGRES
      </span>
    </div>
    <div
      style={{
        padding: 10,
        border: '1px solid var(--ln)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
        lineHeight: 1.5,
        color: 'var(--mu)',
      }}
    >
      "to run migration 0042 — read schema, then apply. Test suite depends on the new orders.status column."
    </div>
    <div style={label}>Scope</div>
    <div style={{ border: '1px solid var(--ln)' }}>
      {['Read schema', 'Write'].map((k) => (
        <div
          key={k}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '8px 10px',
            borderBottom: '1px solid var(--ln)',
          }}
        >
          <span>{k}</span>
          <span style={{ width: 14, height: 14, background: 'var(--tx)' }} />
        </div>
      ))}
      <div
        style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', color: 'var(--mu)' }}
      >
        <span>Delete / drop</span>
        <span style={{ width: 14, height: 14, border: '1px solid var(--ln)' }} />
      </div>
    </div>
    <div style={{ padding: '14px 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--mu)' }}>
      Prod write requires Touch ID. Token is scoped to this session and revoked on expiry or when the session
      ends. Logged to audit.
    </div>
  </>
);

export const Grant: Story = {
  args: {
    header: <SheetAccentHeader label="Access request" meta="Codex · test/flaky" />,
    title: (
      <>
        Supabase <span style={{ color: 'var(--mu)' }}>/</span> prod db
      </>
    ),
    children: grantBody,
    footer: (
      <SheetFooter>
        <Button size="footer">Deny</Button>
        <Button size="footer" variant="accent" grow={1.4}>
          Grant 1h · Touch ID
        </Button>
      </SheetFooter>
    ),
  },
};

export const TitleOnly: Story = {
  args: {
    title: 'Plain sheet',
    children: <div style={{ padding: '8px 0', color: 'var(--mu)' }}>No header bar, no footer.</div>,
  },
};

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
      <div style={{ position: 'relative', height: 420, border: '1px solid var(--ln)', overflow: 'hidden' }}>
        <Sheet
          onClose={() => {}}
          header={<SheetAccentHeader label="Access request" meta="Codex · test/flaky" />}
          title="Supabase / prod db"
          footer={
            <SheetFooter>
              <Button size="footer">Deny</Button>
              <Button size="footer" variant="accent" grow={1.4}>
                Grant 1h
              </Button>
            </SheetFooter>
          }
        >
          {grantBody}
        </Sheet>
      </div>
      <div style={{ position: 'relative', height: 420, border: '1px solid var(--ln)', overflow: 'hidden' }}>
        <Sheet onClose={() => {}} title="Plain sheet">
          <div style={{ color: 'var(--mu)' }}>Body</div>
        </Sheet>
      </div>
    </div>
  ),
};
