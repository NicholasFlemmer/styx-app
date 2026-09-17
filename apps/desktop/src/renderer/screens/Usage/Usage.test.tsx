// @vitest-environment jsdom
import { copy, fixtures, usageByAgent, usageByProject, usageCells, type AgentLimits } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { Usage } from './Usage';

const { DEMO_NOW, ids } = fixtures;
const MIN = 60_000;
const HOUR = 60 * MIN;

let resolveRefresh: () => void = () => undefined;
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  if (name === 'usage.refreshLimits')
    await new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
  return { ok: true as const, value: {} };
});

const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent);

const limits: Record<string, AgentLimits> = {
  codex: {
    agent: 'codex',
    plan: 'team',
    windows: [
      { label: '5 h', usedPercent: 42.4, resetsAt: DEMO_NOW + 2 * HOUR + 10 * MIN },
      { label: '7 d', usedPercent: 12, resetsAt: DEMO_NOW + 3 * 24 * HOUR },
    ],
    updatedAt: DEMO_NOW - 2 * MIN,
  },
  claude: {
    agent: 'claude',
    plan: null,
    windows: [{ label: '5 h', usedPercent: 80, resetsAt: null }],
    updatedAt: DEMO_NOW,
  },
};

describe('Usage', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'usage', platform: 'darwin', projectId: null });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the title, lead and both usage tables from the core selectors with a Total row', () => {
    render(<Usage />);
    expect(screen.getByRole('heading', { level: 2, name: copy.usage.title })).toBeTruthy();
    expect(screen.getByText(copy.usage.lead)).toBeTruthy();

    const model = useReadModel.getState().model;
    for (const [id, table, first] of [
      ['agent', usageByAgent(model), copy.usage.columns.agent],
      ['project', usageByProject(model), copy.usage.columns.project],
    ] as const) {
      const el = document.querySelector<HTMLElement>(`[data-usage-table="${id}"]`);
      if (el === null) throw new Error(`no ${id} table`);
      const headers = within(el)
        .getAllByRole('columnheader')
        .map((h) => h.textContent);
      expect(headers).toEqual([
        first,
        copy.usage.columns.sessions,
        copy.usage.columns.turns,
        copy.usage.columns.tokens,
        copy.usage.columns.cost,
      ]);
      const rows = within(el)
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-usage-row'));
      expect(rows.map((r) => r.getAttribute('data-usage-row'))).toEqual(table.rows.map((r) => r.key));
      rows.forEach((row, i) => {
        const e = table.rows[i];
        if (e === undefined) throw new Error('row mismatch');
        const c = usageCells(e);
        expect(cellsOf(row)).toEqual([e.label, c.sessions, c.turns, c.tokens, c.cost]);
      });
      const total = el.querySelector<HTMLElement>(`[data-usage-total="${id}"]`);
      if (total === null) throw new Error('no total row');
      const t = usageCells(table.total);
      expect(cellsOf(total)).toEqual([copy.usage.total, t.sessions, t.turns, t.tokens, t.cost]);
    }
    // The demo fixture reported no usage: tokens and cost read as a dash, never $0.00.
    const claude = document.querySelector<HTMLElement>('[data-usage-row="claude"]');
    if (claude === null) throw new Error('no claude row');
    expect(cellsOf(claude)).toEqual(['Claude Code', '3', '0', copy.general.none, copy.general.none]);
    expect(document.querySelector('[data-usage-row="shell"]')).toBeNull();
    expect(document.querySelector(`[data-usage-row="${ids.project.acmeShop}"]`)).not.toBeNull();
  });

  it('shows the empty texts for the empty fixture and when no CLI has reported limits', () => {
    useReadModel.getState().replaceModel(fixtures.emptyReadModel(), 'connected');
    render(<Usage />);
    expect(screen.getAllByText(copy.usage.empty)).toHaveLength(2);
    expect(document.querySelector('[data-usage-table]')).toBeNull();
    expect(screen.getByText(copy.usage.noLimits)).toBeTruthy();
    expect(screen.getByText(`${copy.usage.limitsLead} ${copy.usage.refreshNote}`)).toBeTruthy();
  });

  it('lists each reporting agent with plan, windows as bars and text, and the report age', () => {
    const model = fixtures.demoReadModel();
    useReadModel.getState().replaceModel({ ...model, limits }, 'connected');
    render(<Usage />);
    const table = document.querySelector<HTMLElement>('[data-usage-table="limits"]');
    if (table === null) throw new Error('no limits table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      copy.usage.columns.agent,
      copy.usage.columns.plan,
      copy.usage.columns.windows,
      copy.usage.columns.reported,
    ]);
    const rows = [...table.querySelectorAll<HTMLElement>('[data-usage-limit]')];
    expect(rows.map((r) => r.getAttribute('data-usage-limit'))).toEqual(['claude', 'codex']);

    const codex = rows[1];
    if (codex === undefined) throw new Error('no codex row');
    const windows = [...codex.querySelectorAll<HTMLElement>('[data-usage-window]')];
    expect(windows.map((w) => w.textContent)).toEqual([
      '5 h · 42% used · resets in 2h 10m',
      '7 d · 12% used · resets in 3d',
    ]);
    expect(windows.map((w) => w.querySelector<HTMLElement>('[data-usage-fill]')?.style.width)).toEqual([
      '42%',
      '12%',
    ]);
    expect(cellsOf(codex)[0]).toBe('Codex');
    expect(cellsOf(codex)[1]).toBe('plan team');
    expect(cellsOf(codex)[3]).toBe('2m');

    const claude = rows[0];
    if (claude === undefined) throw new Error('no claude row');
    expect(cellsOf(claude)[1]).toBe(copy.general.none);
    expect(claude.querySelector('[data-usage-window]')?.textContent).toBe('5 h · 80% used');
    expect(cellsOf(claude)[3]).toBe('now');
    expect(screen.queryByText(copy.usage.noLimits)).toBeNull();
  });

  it('Refresh dispatches usage.refreshLimits, reads as busy meanwhile, and ignores a second click', async () => {
    render(<Usage />);
    const button = screen.getByRole('button', { name: copy.usage.refresh });
    fireEvent.click(button);
    expect(commandMock).toHaveBeenCalledWith('usage.refreshLimits', {});
    await waitFor(() => expect(button.textContent).toBe(copy.usage.refreshing));
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(commandMock).toHaveBeenCalledTimes(1);
    resolveRefresh();
    await waitFor(() => expect(button.textContent).toBe(copy.usage.refresh));
    expect(button.getAttribute('aria-busy')).toBeNull();
  });
});
