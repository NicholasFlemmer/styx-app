// @vitest-environment jsdom
import { fixtures, type SkillSummary } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkillsStore } from '../../features/skills/skills-store';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { groupInstalled, matchesHost, matchesQuery, SkillsPane } from './SkillsPane';

const acme = fixtures.ids.project.acmeShop;

const CATALOGUE: SkillSummary[] = [
  {
    name: 'pdf',
    directory: 'pdf',
    description: 'Read, fill and merge PDF files with the pdf toolkit.',
    scope: 'catalogue',
    host: null,
  },
  {
    name: 'xlsx',
    directory: 'xlsx',
    description: 'Create, read and edit spreadsheets.',
    scope: 'catalogue',
    host: null,
  },
  {
    name: 'frontend-design',
    directory: 'frontend-design',
    description: 'Build distinctive interfaces.',
    scope: 'catalogue',
    host: null,
  },
];

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
const deferred = () => {
  let resolve!: (r: Result) => void;
  const promise = new Promise<Result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

let installed: SkillSummary[];
let catalogue: () => Promise<Result>;
const commandMock = vi.fn(async (name: string, _input?: unknown): Promise<Result> => {
  switch (name) {
    case 'skills.list':
      return { ok: true, value: { skills: installed } };
    case 'skills.catalogue':
      return catalogue();
    default:
      return { ok: true, value: {} };
  }
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

const installedTable = () => screen.findByRole('table', { name: 'Installed' });
const catalogueTable = () => screen.findByRole('table', { name: 'Catalogue' });
const skillRows = (table: HTMLElement) => [...table.querySelectorAll<HTMLElement>('[data-skill]')];
const rowNames = (table: HTMLElement) => skillRows(table).map((r) => r.dataset['skill']);
const search = () => screen.getByRole('textbox', { name: 'Search skills' });

describe('SkillsPane helpers', () => {
  it('groups installed rows by scope + directory, one tag per host', () => {
    const rows = groupInstalled([
      ...fixtures.demoSkills(),
      { name: 'pdf', directory: 'pdf', description: 'x', scope: 'global', host: 'codex' },
      { name: 'pdf', directory: 'pdf', description: 'x', scope: 'global', host: 'codex' },
      { name: 'c', directory: 'c', description: 'x', scope: 'catalogue', host: null },
    ]);
    expect(rows.map((r) => [r.key, r.hosts])).toEqual([
      ['global:pdf', ['claude', 'codex']],
      ['project:release-notes', ['claude']],
      ['global:sql-review', ['agents']],
    ]);
  });

  it('matches name or description, case-insensitively; shared rows show under Codex, Gemini and Cursor but not Claude', () => {
    const [pdf, , shared] = groupInstalled(fixtures.demoSkills());
    expect(matchesQuery(pdf!, ' PDF ')).toBe(true);
    expect(matchesQuery(pdf!, 'merge')).toBe(true);
    expect(matchesQuery(pdf!, 'sql')).toBe(false);
    expect(matchesQuery(pdf!, '')).toBe(true);
    expect(matchesHost(shared!, 'all')).toBe(true);
    expect(matchesHost(shared!, 'codex')).toBe(true);
    expect(matchesHost(shared!, 'gemini')).toBe(true);
    expect(matchesHost(shared!, 'cursor')).toBe(true);
    expect(matchesHost(shared!, 'claude')).toBe(false);
    expect(matchesHost(pdf!, 'claude')).toBe(true);
    expect(matchesHost(pdf!, 'codex')).toBe(false);
  });
});

describe('SkillsPane', () => {
  beforeEach(() => {
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'settings', platform: 'darwin', projectId: acme });
    useSkillsStore.setState({ version: 0 });
    installed = fixtures.demoSkills();
    catalogue = async () => ({ ok: true, value: { skills: CATALOGUE } });
    commandMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('lists the installed skills for this project: name + description, a tag per agent, You / Project, Remove', async () => {
    render(<SkillsPane projectId={acme} />);
    const table = await installedTable();
    expect(calls('skills.list')[0]?.[1]).toEqual({ projectId: acme });
    expect(rowNames(table)).toEqual(['pdf', 'release-notes', 'sql-review']);
    const [pdf, notes, sql] = skillRows(table);
    expect(pdf!.textContent).toContain('Read, fill and merge PDF files');
    expect(within(pdf!).getByText('Claude')).toBeTruthy();
    expect(within(pdf!).getByText('You')).toBeTruthy();
    expect(within(notes!).getByText('Project')).toBeTruthy();
    const shared = within(sql!).getByText('Shared');
    expect(shared.getAttribute('title')).toBe('read by Codex, Gemini CLI and Cursor');
    expect(within(sql!).getByRole('button', { name: 'Remove · sql-review' })).toBeTruthy();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Skill', 'For', 'Where', 'Actions']);
  });

  it('search filters both lists by name and description; no match says so', async () => {
    render(<SkillsPane projectId={acme} />);
    await installedTable();
    await catalogueTable();
    fireEvent.change(search(), { target: { value: 'sql' } });
    expect(rowNames(await installedTable())).toEqual(['sql-review']);
    expect(screen.getByText('No skills match "sql".')).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'MERGE' } });
    expect(rowNames(await installedTable())).toEqual(['pdf']);
    expect([...(await catalogueTable()).querySelectorAll('[data-catalogue-skill]')]).toHaveLength(1);
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.getAllByText('No skills match "zzz".')).toHaveLength(2);
  });

  it('the agent filter narrows the installed list; shared skills appear under every CLI that reads them', async () => {
    render(<SkillsPane projectId={acme} />);
    await installedTable();
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(rowNames(await installedTable())).toEqual(['sql-review']);
    fireEvent.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(rowNames(await installedTable())).toEqual(['pdf', 'release-notes']);
    fireEvent.click(screen.getByRole('radio', { name: 'All agents' }));
    expect(rowNames(await installedTable())).toHaveLength(3);
  });

  it('shows the empty state when nothing is installed', async () => {
    installed = [];
    render(<SkillsPane projectId={null} />);
    await screen.findByText('No skills installed.');
    expect(screen.getByText(/Read one from the catalogue/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Installed' })).toBeNull();
  });

  it('loads the catalogue on mount: busy while loading, then rows with Read and an Installed tag per agent', async () => {
    const pending = deferred();
    catalogue = () => pending.promise;
    render(<SkillsPane projectId={acme} />);
    const table = await catalogueTable();
    expect(table.getAttribute('aria-busy')).toBe('true');
    expect(within(table).getByText('Loading catalogue…')).toBeTruthy();
    await act(async () => {
      pending.resolve({ ok: true, value: { skills: CATALOGUE } });
      await pending.promise;
    });
    await waitFor(() => expect(table.getAttribute('aria-busy')).toBeNull());
    const rows = [...table.querySelectorAll<HTMLElement>('[data-catalogue-skill]')];
    expect(rows.map((r) => r.dataset['catalogueSkill'])).toEqual(['pdf', 'xlsx', 'frontend-design']);
    expect(within(rows[0]!).getByText('Installed · Claude')).toBeTruthy();
    expect(within(rows[1]!).queryByText(/Installed/)).toBeNull();
    expect(within(rows[1]!).getByRole('button', { name: 'Read · xlsx' })).toBeTruthy();
  });

  it('a catalogue failure shows an error banner whose Retry fetches again', async () => {
    catalogue = async () => ({
      ok: false,
      error: { code: 'provider-error', message: 'Could not reach the skill catalogue: HTTP 503' },
    });
    render(<SkillsPane projectId={acme} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('HTTP 503');
    expect(screen.queryByRole('table', { name: 'Catalogue' })).toBeNull();
    catalogue = async () => ({ ok: true, value: { skills: CATALOGUE } });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await catalogueTable();
    expect(calls('skills.catalogue')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Read opens the skill drawer for that directory', async () => {
    render(<SkillsPane projectId={acme} />);
    await catalogueTable();
    fireEvent.click(screen.getByRole('button', { name: 'Read · xlsx' }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'drawer', drawer: 'skill', directory: 'xlsx' },
    ]);
  });

  it('Remove removes the skill for each agent it is listed for, refreshes and confirms with a toast', async () => {
    render(<SkillsPane projectId={acme} />);
    await installedTable();
    fireEvent.click(screen.getByRole('button', { name: 'Remove · sql-review' }));
    await waitFor(() => expect(calls('skills.remove')).toHaveLength(1));
    expect(calls('skills.remove')[0]?.[1]).toEqual({
      directory: 'sql-review',
      scope: 'global',
      host: 'agents',
      projectId: null,
    });
    await waitFor(() => expect(calls('skills.list')).toHaveLength(2));
    const toast = useUiStore.getState().overlays.find((o) => o.kind === 'toast');
    expect(toast?.kind === 'toast' && toast.toast).toEqual({
      kind: 'info',
      heading: 'Skills',
      title: 'Removed sql-review',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove · release-notes' }));
    await waitFor(() => expect(calls('skills.remove')).toHaveLength(2));
    expect(calls('skills.remove')[1]?.[1]).toMatchObject({
      scope: 'project',
      host: 'claude',
      projectId: acme,
    });
  });

  it('refetches when the skills store version moves (the drawer installed something)', async () => {
    render(<SkillsPane projectId={acme} />);
    await installedTable();
    installed = [
      ...fixtures.demoSkills(),
      { name: 'xlsx', directory: 'xlsx', description: 'sheets', scope: 'global', host: 'codex' },
    ];
    act(() => useSkillsStore.getState().bump());
    await waitFor(() => expect(rowNames(screen.getByRole('table', { name: 'Installed' }))).toContain('xlsx'));
  });

  it('is axe clean with both tables on screen', async () => {
    const { container } = render(<SkillsPane projectId={acme} />);
    await installedTable();
    await catalogueTable();
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});
