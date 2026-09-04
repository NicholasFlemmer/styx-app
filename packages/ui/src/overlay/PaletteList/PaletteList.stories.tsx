import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Backdrop } from '../Backdrop';
import { PaletteList, type PaletteGroup } from './PaletteList';

const groups: PaletteGroup[] = [
  {
    id: 'actions',
    label: 'Actions',
    items: [
      { id: 'spawn', glyph: '▲', label: 'Spawn agent…', meta: '⌘N' },
      { id: 'deploy', glyph: '◆', label: 'Deploy acme-shop → Vercel prod', meta: 'needs grant' },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    items: [
      { id: 'claude', glyph: '●', label: 'Claude · fix/checkout', meta: 'working' },
      { id: 'codex', glyph: '●', label: 'Codex · test/flaky', meta: 'needs you' },
    ],
  },
  {
    id: 'projects',
    label: 'Projects',
    items: [
      { id: 'acme', glyph: '→', label: 'acme-shop', meta: 'open · 58m' },
      { id: 'orders', glyph: '→', label: 'orders-service', meta: 'main' },
    ],
  },
];

function Live(props: Partial<React.ComponentProps<typeof PaletteList>>) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState<string | undefined>('spawn');
  return (
    <PaletteList
      query={q}
      onQuery={setQ}
      groups={groups}
      activeId={active}
      onActive={setActive}
      onRun={() => {}}
      {...props}
    />
  );
}

const meta = {
  title: 'Overlay/PaletteList',
  component: PaletteList,
  parameters: { layout: 'fullscreen' },
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
} satisfies Meta<typeof PaletteList>;
export default meta;
type Story = StoryObj<typeof PaletteList>;

export const Grouped: Story = {
  render: () => (
    <Backdrop paddingTop={110}>
      <Live footerHints={['⏎ run', '⌘⏎ new window', '⇥ scope', 'esc']} />
    </Backdrop>
  ),
};
export const Empty: Story = { render: () => <Live groups={[]} activeId={undefined} /> };
export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, padding: 12 }}>
      <Live />
      <Live groups={[groups[0] as PaletteGroup]} activeId="deploy" />
    </div>
  ),
};
