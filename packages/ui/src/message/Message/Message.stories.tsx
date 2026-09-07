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
/** Agent reply still streaming from the CLI: blinking `▌` after the text (discrepancy #55). */
export const AgentStreaming: Story = {
  args: {
    kind: 'agent',
    streaming: true,
    children: 'Reading checkout.ts and pay.ts. The validation should live in',
  },
};
const thinkingText =
  'The failing test asserts the total before tax, but checkout.ts sums after applying the discount. I should check whether pay.ts expects the pre-tax figure before changing the order of operations.';
/** Thinking block mid-stream: muted quote-like body, always open, cursor at the end. */
export const ThinkingStreaming: Story = {
  args: {
    kind: 'thinking',
    status: 'streaming',
    text: thinkingText,
    label: 'Thinking…',
    showLabel: 'Show',
    hideLabel: 'Hide',
  },
};
/** Finished thinking block: collapsed to its header with a Show toggle. */
export const ThinkingDone: Story = {
  args: {
    kind: 'thinking',
    status: 'done',
    text: thinkingText,
    label: 'Thought for 4s',
    showLabel: 'Show',
    hideLabel: 'Hide',
  },
};
/** Finished thinking block expanded (`defaultOpen`): header reads Hide, body shows without a cursor. */
export const ThinkingDoneOpen: Story = {
  args: {
    kind: 'thinking',
    status: 'done',
    text: thinkingText,
    label: 'Thought for 4s',
    showLabel: 'Show',
    hideLabel: 'Hide',
    defaultOpen: true,
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
/** Answered ask: options disabled, the taken one inverted (fixes stale Allow/Deny after the CLI moved on). */
export const DecisionSettled: Story = {
  args: {
    kind: 'decision',
    children: 'Ran vitest, 42 passed. Open a PR against main?',
    options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Edit plan' }],
    onChoose: () => {},
    chosen: 'Yes',
  },
};
/** Ask closed elsewhere (cancelled / answered in the CLI) with no recorded choice. */
export const DecisionClosed: Story = {
  args: {
    kind: 'decision',
    children: 'Ran vitest, 42 passed. Open a PR against main?',
    options: [{ label: 'Yes' }, { label: 'No' }],
    onChoose: () => {},
    disabled: true,
  },
};
export const ToolRunning: Story = {
  args: { kind: 'tool', tool: 'Bash', hint: 'pnpm test -F @styx/core', status: 'running', statusGlyph: '…' },
};
export const ToolOk: Story = {
  args: {
    kind: 'tool',
    tool: 'Edit',
    hint: 'apps/desktop/src/renderer/features/chat/ChatPane.tsx',
    status: 'ok',
    statusGlyph: '✓',
  },
};
export const ToolError: Story = {
  args: {
    kind: 'tool',
    tool: 'Bash',
    hint: 'pnpm typecheck',
    status: 'error',
    statusGlyph: '×',
    detail: "error TS2322: Type 'string' is not assignable to type 'number'.",
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
          <Message kind="agent" streaming compact={compact}>
            Reading checkout.ts and pay.ts. The validation should live in
          </Message>
          <Message
            kind="thinking"
            status="streaming"
            text={thinkingText}
            label="Thinking…"
            showLabel="Show"
            hideLabel="Hide"
            compact={compact}
          />
          <Message
            kind="thinking"
            status="done"
            text={thinkingText}
            label="Thought for 4s"
            showLabel="Show"
            hideLabel="Hide"
            compact={compact}
          />
          <Message
            kind="thinking"
            status="done"
            text={thinkingText}
            label="Thought for 4s"
            showLabel="Show"
            hideLabel="Hide"
            defaultOpen
            compact={compact}
          />
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
            kind="decision"
            options={[{ label: 'Yes' }, { label: 'No' }]}
            onChoose={() => {}}
            chosen="Yes"
            compact={compact}
          >
            Open a PR against main?
          </Message>
          <Message
            kind="tool"
            tool="Bash"
            hint="pnpm test -F @styx/core"
            status="running"
            statusGlyph="…"
            compact={compact}
          />
          <Message
            kind="tool"
            tool="Read"
            hint="packages/core/src/copy.ts"
            status="ok"
            statusGlyph="✓"
            compact={compact}
          />
          <Message
            kind="tool"
            tool="Bash"
            hint="pnpm typecheck"
            status="error"
            statusGlyph="×"
            detail="error TS2322: Type 'string' is not assignable to type 'number'."
            compact={compact}
          />
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
