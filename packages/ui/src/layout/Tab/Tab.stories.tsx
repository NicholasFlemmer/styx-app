import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tab, TabRow } from './Tab';
import { Tag } from '../../primitives/Tag';

const meta = {
  title: 'Layout/Tab',
  component: Tab,
  args: { label: 'Claude', dot: 'text' },
} satisfies Meta<typeof Tab>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Session: Story = { render: (a) => <TabRow aria-label="Sessions"><Tab {...a} /></TabRow> };
export const SessionCurrent: Story = { render: (a) => <TabRow aria-label="Sessions"><Tab {...a} inv /></TabRow> };
export const SessionBadge: Story = {
  args: { label: 'Codex', dot: 'accent', badge: true },
  render: (a) => <TabRow aria-label="Sessions"><Tab {...a} /></TabRow>,
};
export const SessionOverflow: Story = {
  args: { label: '2 more', dot: undefined, overflow: true },
  render: (a) => <TabRow aria-label="Sessions"><Tab {...a} /></TabRow>,
};
export const File: Story = {
  args: { variant: 'file', label: 'pay.ts', dot: undefined },
  render: (a) => <TabRow variant="file" aria-label="Files"><Tab {...a} /></TabRow>,
};
export const FileCurrent: Story = {
  args: { variant: 'file', label: 'checkout.ts', dot: undefined, inv: true },
  render: (a) => <TabRow variant="file" aria-label="Files"><Tab {...a} /></TabRow>,
};
export const FileWithAgentTag: Story = {
  args: { variant: 'file', label: 'validate.ts', dot: undefined, meta: <Tag tone="agent">CLAUDE</Tag> },
  render: (a) => <TabRow variant="file" aria-label="Files"><Tab {...a} /></TabRow>,
};
export const Approvals: Story = {
  args: { variant: 'approvals', label: 'Inbox', dot: undefined },
  render: (a) => <TabRow variant="approvals" aria-label="Approvals"><Tab {...a} inv /><Tab {...a} label="Active grants" /><Tab {...a} label="Audit" /></TabRow>,
};

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, width: 520 }}>
      <TabRow aria-label="Sessions">
        <Tab label="Claude" dot="text" inv />
        <Tab label="Codex" dot="accent" badge />
        <Tab label="Gemini" dot="line" />
        <Tab label="2 more" overflow />
      </TabRow>
      <TabRow variant="file" aria-label="Files">
        <Tab variant="file" label="checkout.ts" inv />
        <Tab variant="file" label="pay.ts" />
        <Tab variant="file" label="validate.ts" meta={<Tag tone="agent">CLAUDE</Tag>} />
      </TabRow>
      <TabRow variant="approvals" aria-label="Approvals">
        <Tab variant="approvals" label="Inbox" inv />
        <Tab variant="approvals" label="Active grants" />
        <Tab variant="approvals" label="Audit" />
      </TabRow>
    </div>
  ),
};
