import type { Meta, StoryObj } from '@storybook/react-vite';
import { Table, TableRow, TableCell, TABLE_COLUMNS } from './Table';
import { StatusDot } from '../../primitives/StatusDot';
import { Tag } from '../../primitives/Tag';
import { Select } from '../../primitives/Select';
import { Checkbox } from '../../primitives/Checkbox';

const meta = {
  title: 'Layout/Table',
  component: Table,
  args: { columns: TABLE_COLUMNS.home },
  decorators: [(Story) => <div style={{ width: 980 }}><Story /></div>],
} satisfies Meta<typeof Table>;
export default meta;
type Story = StoryObj<typeof meta>;

const projects = [
  { name: 'acme-shop', path: '~/code/acme-shop', branch: 'fix/checkout', agents: 'Claude · Codex · Gemini', targets: 'Vercel · Supabase · AWS', last: '3m', needs: true },
  { name: 'blog-v2', path: '~/code/blog-v2', branch: 'feat/mdx', agents: 'Claude', targets: 'Vercel', last: '9m', needs: true },
  { name: 'infra-tools', path: '~/code/infra-tools', branch: 'main', agents: 'Gemini', targets: 'AWS · SSH', last: '31m', needs: false },
];

export const Home: Story = {
  args: { header: ['Project', 'Path', 'Branch', 'Agents', 'Targets', 'Last activity'] },
  render: (a) => (
    <Table {...a}>
      {projects.map((p) => (
        <TableRow key={p.name} onActivate={() => {}}>
          <TableCell strong><StatusDot tone="hollow" on={p.needs} label={p.needs ? 'needs you' : undefined} />{p.name}</TableCell>
          <TableCell mono muted>{p.path}</TableCell>
          <TableCell mono>{p.branch}</TableCell>
          <TableCell>{p.agents}</TableCell>
          <TableCell muted>{p.targets}</TableCell>
          <TableCell mono muted>{p.last}</TableCell>
        </TableRow>
      ))}
    </Table>
  ),
};

export const RepoInverted: Story = {
  args: { columns: TABLE_COLUMNS.repo, header: ['Branch', 'Owner', 'Changes', 'PR', ''] },
  render: (a) => (
    <Table {...a}>
      <TableRow inv onActivate={() => {}}>
        <TableCell mono>fix/checkout</TableCell>
        <TableCell><StatusDot tone="text" size={7} />Claude</TableCell>
        <TableCell mono>+77 −0 · 3 files</TableCell>
        <TableCell mono>—</TableCell>
        <TableCell label align="end">Review</TableCell>
      </TableRow>
      <TableRow onActivate={() => {}}>
        <TableCell mono>test/flaky</TableCell>
        <TableCell><StatusDot tone="accent" size={7} />Codex</TableCell>
        <TableCell mono>+4 −1 · 1 file</TableCell>
        <TableCell mono>—</TableCell>
        <TableCell label align="end">Open</TableCell>
      </TableRow>
    </Table>
  ),
};

export const Targets: Story = {
  args: { columns: TABLE_COLUMNS.targets, header: ['Target', 'Env', 'Policy', 'State', ''], rowPad: '12px 20px' },
  render: (a) => (
    <Table {...a}>
      <TableRow>
        <TableCell strong>Supabase acme</TableCell>
        <TableCell><Tag tone="accent">prod</Tag></TableCell>
        <TableCell><Select aria-label="Policy" width={170} options={[{ value: 'ask', label: 'Ask every time' }]} /></TableCell>
        <TableCell mono muted>connected · 2 grants</TableCell>
        <TableCell label muted align="end">Revoke</TableCell>
      </TableRow>
    </Table>
  ),
};

export const Onboarding: Story = {
  args: { columns: TABLE_COLUMNS.onboardingRepos, rowPad: '10px 14px', gap: '14px' },
  render: (a) => (
    <div style={{ border: '1px solid var(--ln)' }}>
      <Table {...a}>
        <TableRow>
          <TableCell><Checkbox checked aria-label="Select acme-shop" tone="accent" /></TableCell>
          <TableCell mono>~/code/acme-shop</TableCell>
          <TableCell mono muted>VS Code recent · 3 agents</TableCell>
        </TableRow>
      </Table>
    </div>
  ),
};

export const Matrix: Story = {
  render: () => (
    <Table columns={TABLE_COLUMNS.repo} header={['Branch', 'Owner', 'Changes', 'PR', '']}>
      <TableRow><TableCell>static</TableCell><TableCell>row</TableCell><TableCell /><TableCell /><TableCell label align="end">—</TableCell></TableRow>
      <TableRow onActivate={() => {}}><TableCell>interactive</TableCell><TableCell>hover --s2</TableCell><TableCell /><TableCell /><TableCell label align="end">Open</TableCell></TableRow>
      <TableRow inv onActivate={() => {}}><TableCell>inverted</TableCell><TableCell muted>muted cell</TableCell><TableCell /><TableCell /><TableCell label align="end">Review</TableCell></TableRow>
      <TableRow on><TableCell>armed</TableCell><TableCell muted>muted cell</TableCell><TableCell /><TableCell /><TableCell label align="end">!</TableCell></TableRow>
    </Table>
  ),
};
