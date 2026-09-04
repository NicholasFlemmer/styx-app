import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../../primitives';
import { Message } from '../Message';
import { Transcript } from './Transcript';

const meta = {
  title: 'Message/Transcript',
  component: Transcript,
  decorators: [
    (Story) => (
      <div
        style={{
          width: 360,
          height: 360,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--s1)',
          border: '1px solid var(--ln)',
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Transcript>;
export default meta;
type Story = StoryObj<typeof meta>;

const thread = (
  <>
    <Message kind="user" text="Add input validation to checkout and cover it with tests." />
    <Message kind="agent">
      Read checkout.ts and pay.ts. Plan: new validate.ts, call it before summing, add 4 tests.
    </Message>
    <Message
      kind="fileList"
      files={[
        { path: 'validate.ts', added: 31 },
        { path: 'checkout.ts', added: 2, removed: 0 },
        { path: 'checkout.test.ts', added: 44 },
      ]}
    />
    <Message
      kind="decision"
      options={[{ label: 'Yes' }, { label: 'No' }, { label: 'Edit plan' }]}
      onChoose={() => {}}
    >
      Ran vitest, 42 passed. Open a PR against main?
    </Message>
  </>
);

export const Claude: Story = { args: { children: thread } };
export const Compact: Story = { args: { children: thread, compact: true } };

function Streaming() {
  const [n, setN] = useState(3);
  return (
    <>
      <Transcript>
        {thread}
        {Array.from({ length: n }, (_, i) => (
          <Message key={i} kind="system" text={`line ${i + 1} · streamed`} />
        ))}
      </Transcript>
      <div style={{ padding: 8, borderTop: '1px solid var(--ln)' }}>
        <Button onClick={() => setN((v) => v + 1)}>Append</Button>
      </div>
    </>
  );
}
export const PinToBottom: Story = { render: () => <Streaming /> };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: 740, height: 360 }}>
      <Transcript style={{ border: '1px solid var(--ln)' }}>{thread}</Transcript>
      <Transcript compact style={{ border: '1px solid var(--ln)' }}>
        {thread}
      </Transcript>
    </div>
  ),
};
