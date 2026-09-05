import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../../primitives';
import { Modal } from './Modal';

const meta = {
  title: 'Overlay/Modal',
  component: Modal,
  parameters: { layout: 'fullscreen' },
  args: { onClose: () => {} },
  decorators: [
    (Story) => (
      <div
        style={{
          position: 'relative',
          width: 1100,
          height: 620,
          background: 'var(--bg)',
          overflow: 'hidden',
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Modal>;
export default meta;
type Story = StoryObj<typeof meta>;

const label: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: 'var(--mu)',
};
const field = (name: string, value: string) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={label}>{name}</span>
    <div
      style={{
        border: '1px solid var(--ln)',
        background: 'var(--bg)',
        padding: '8px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5,
      }}
    >
      {value}
    </div>
  </div>
);

export const Connect: Story = {
  args: {
    width: 560,
    title: 'Connect target · API key',
    bodyPad: '20px 16px',
    children: (
      <>
        <div style={{ fontSize: 20, fontWeight: 600 }}>AWS</div>
        <div style={{ color: 'var(--mu)', lineHeight: 1.5, fontSize: 12.5 }}>
          Paste credentials for a role scoped to this project. Styx recommends a dedicated IAM role with no
          delete permissions; the key is stored in the macOS Keychain and never shown again.
        </div>
        {field('Name', 'acme-prod')}
        {field('Access key / service account', 'AKIA••••••••••••')}
      </>
    ),
    footer: (
      <>
        <Button size="footer" variant="ghost">
          Back
        </Button>
        <Button size="footer">Test connection</Button>
        <Button size="footer" variant="primary">
          Save to Keychain
        </Button>
      </>
    ),
  },
};

export const Spawn: Story = {
  args: {
    width: 600,
    title: 'Spawn agent · acme-shop',
    bodyPad: '16px',
    children: (
      <>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {field('Worktree', 'New from main')}
          {field('Branch', 'feat/checkout-validation')}
        </div>
        {field('First message', 'What should Claude do? Reference files with @.')}
      </>
    ),
    footer: (
      <>
        <Button size="footer" variant="ghost">
          Cancel
        </Button>
        <Button size="footer" variant="primary">
          Spawn · ⌘⏎
        </Button>
      </>
    ),
  },
};

export const NewProject: Story = {
  args: {
    width: 600,
    top: 70,
    title: 'New project',
    children: field('Name', 'orders-service'),
    footer: (
      <>
        <Button size="footer" variant="ghost">
          Cancel
        </Button>
        <Button size="footer" variant="primary">
          Create
        </Button>
      </>
    ),
  },
};

export const NoFooter: Story = {
  args: {
    width: 560,
    title: 'Connect target · Pick a provider',
    children: <div>Provider grid goes here.</div>,
  },
};

export const Matrix: Story = {
  args: { title: 'Matrix' },
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
      {([560, 600] as const).map((w) => (
        <div
          key={w}
          style={{ position: 'relative', height: 360, border: '1px solid var(--ln)', overflow: 'hidden' }}
        >
          <Modal
            width={w}
            title={`Modal · ${w}`}
            onClose={() => {}}
            footer={
              <Button size="footer" variant="primary">
                OK
              </Button>
            }
          >
            {field('Name', 'orders-service')}
          </Modal>
        </div>
      ))}
    </div>
  ),
};
