import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaletteList, type PaletteGroup } from './PaletteList';

afterEach(cleanup);

const groups: PaletteGroup[] = [
  {
    id: 'actions',
    label: 'Actions',
    items: [{ id: 'spawn', glyph: '▲', label: 'Spawn agent…', meta: '⌘N' }],
  },
  {
    id: 'agents',
    label: 'Agents',
    items: [
      { id: 'claude', glyph: '●', label: 'Claude', meta: 'working' },
      { id: 'codex', glyph: '●', label: 'Codex', meta: 'needs you' },
    ],
  },
];

function Live(props: {
  onRun?: (id: string) => void;
  onScopeCycle?: (d: 1 | -1) => void;
  onClose?: () => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState<string | undefined>('spawn');
  return (
    <PaletteList
      query={q}
      onQuery={setQ}
      groups={groups}
      activeId={active}
      onActive={setActive}
      placeholder="switch, spawn, deploy, grant, diff…"
      footerHints={['⏎ run', '⇥ scope', 'esc']}
      ariaLabel="Command palette"
      resultsLabel="Results"
      onRun={props.onRun ?? (() => {})}
      {...(props.onScopeCycle ? { onScopeCycle: props.onScopeCycle } : {})}
      {...(props.onClose ? { onClose: props.onClose } : {})}
    />
  );
}

describe('PaletteList', () => {
  it('autofocuses a combobox wired to a grouped listbox', () => {
    render(<Live />);
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(screen.getAllByRole('group')).toHaveLength(2);
    expect(screen.getByRole('group', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('marks the active row inverted and selected via aria-activedescendant', () => {
    render(<Live />);
    const active = screen.getByRole('option', { name: /Spawn agent/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(active).toHaveAttribute('data-inv', 'true');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', active.id);
    expect(screen.getByRole('option', { name: /Claude/ })).not.toHaveAttribute('data-inv');
  });

  it('↑↓ move the active row without moving DOM focus; wraps at the ends', async () => {
    const user = userEvent.setup();
    render(<Live />);
    const input = screen.getByRole('combobox');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Claude/ })).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option', { name: /Spawn/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: /Codex/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('⏎ runs the active item; click runs a row', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Live onRun={onRun} />);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onRun).toHaveBeenLastCalledWith('claude');
    await user.click(screen.getByRole('option', { name: /Codex/ }));
    expect(onRun).toHaveBeenLastCalledWith('codex');
  });

  it('Tab cycles scope instead of moving focus; Shift+Tab goes back', async () => {
    const user = userEvent.setup();
    const onScopeCycle = vi.fn();
    render(<Live onScopeCycle={onScopeCycle} />);
    await user.keyboard('{Tab}');
    expect(onScopeCycle).toHaveBeenLastCalledWith(1);
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(onScopeCycle).toHaveBeenLastCalledWith(-1);
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('hover selects a row only once the pointer really moves (a stationary pointer keeps the keyboard row)', () => {
    render(<Live />);
    const codex = screen.getByRole('option', { name: /Codex/ });
    // Chromium re-dispatches mousemove under a stationary pointer after layout: same coordinates, no selection.
    fireEvent.mouseMove(codex, { clientX: 400, clientY: 300 });
    fireEvent.mouseMove(codex, { clientX: 400, clientY: 300 });
    expect(codex).not.toHaveAttribute('data-inv');
    fireEvent.mouseMove(codex, { clientX: 401, clientY: 300 });
    expect(codex).toHaveAttribute('data-inv', 'true');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('typing updates the query; Esc calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Live onClose={onClose} />);
    await user.keyboard('dep');
    expect(screen.getByRole('combobox')).toHaveValue('dep');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
