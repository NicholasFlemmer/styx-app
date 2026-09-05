import type { Meta, StoryObj } from '@storybook/react-vite';
import { Message, type MessageProps } from './Message';

const meta: Meta<MessageProps> = {
  title: 'Message/Message',
  component: Message,
  decorators: [
    (Story) => (
      <div
        style={{
          width: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 14,
          background: 'var(--s1)',
        }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<MessageProps>;

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 };

export const User: Story = {
  args: { kind: 'user', text: 'Add input validation to checkout and cover it with tests.' },
};
export const Agent: Story = {
  args: {
    kind: 'agent',
    children: (
      <>
        Read <span style={mono}>checkout.ts</span> and <span style={mono}>pay.ts</span>. Plan: new{' '}
        <span style={mono}>validate.ts</span>, call it before summing, add 4 tests.
      </>
    ),
  },
};
export const FileList: Story = {
  args: {
    kind: 'fileList',
    files: [
      { path: 'validate.ts', added: 31 },
      { path: 'checkout.ts', added: 2, removed: 0 },
      { path: 'checkout.test.ts', added: 44 },
    ],
  },
};
export const Decision: Story = {
  args: {
    kind: 'decision',
    children: 'Ran vitest, 42 passed. Open a PR against main?',
    options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Edit plan' }],
    onChoose: () => {},
  },
};
export const AccessRequest: Story = {
  args: {
    kind: 'accessRequest',
    header: 'Access request · Supabase prod',
    body: 'Scope: read schema, write. No grant on file for this target.',
    reviewLabel: 'Review request',
    denyLabel: 'Deny',
    onReview: () => {},
    onDeny: () => {},
  },
};
export const System: Story = {
  args: { kind: 'system', text: 'grant: supabase-prod · read+write · expires in 59m' },
};
export const Compact: Story = {
  args: { kind: 'user', text: 'Add input validation to checkout and cover it with tests.', compact: true },
};

export const Matrix: Story = {
  args: { kind: 'user', text: '' },
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      {[false, true].map((compact) => (
        <div key={String(compact)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Message
            kind="user"
            text="Fix the flaky order test and make sure the schema matches prod."
            compact={compact}
          />
          <Message kind="agent" compact={compact}>
            The test fails because migration 0042 was never applied to prod.
          </Message>
          <Message
            kind="fileList"
            files={[
              { path: 'validate.ts', added: 31 },
              { path: 'checkout.ts', added: 2, removed: 0 },
            ]}
            compact={compact}
          />
          <Message
            kind="decision"
            options={[{ label: 'Yes' }, { label: 'No' }]}
            onChoose={() => {}}
            compact={compact}
          >
            Open a PR against main?
          </Message>
          <Message
            kind="accessRequest"
            header="Access request · Supabase prod"
            body="Scope: read schema, write. No grant on file for this target."
            reviewLabel="Review request"
            denyLabel="Deny"
            onReview={() => {}}
            onDeny={() => {}}
            compact={compact}
          />
          <Message
            kind="system"
            text="grant: supabase-prod · read+write · expires in 59m"
            compact={compact}
          />
        </div>
      ))}
    </div>
  ),
};
