// @vitest-environment jsdom
import { fixtures, type ProjectId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { Approvals } from './Approvals';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const commandMock = vi.fn(async (name: string) =>
  name === 'policy.export' ? { ok: true, value: { json: '{"policies":[]}' } } : { ok: true, value: {} },
);
const writeText = vi.fn(async () => undefined);

describe('Approvals', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'approvals',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
      approvalsTab: 'inbox',
    });
    commandMock.mockClear();
    writeText.mockClear();
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the three tabs with the inbox count and the policies pane', () => {
    render(<Approvals />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Inbox · 3', 'Policies', 'Audit log']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    const pane = screen.getByRole('complementary', { name: 'Policies' });
    const boxes = within(pane).getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    expect(within(pane).getByText('Always ask, require Touch ID for prod write')).toBeTruthy();
    expect(within(pane).getByText('matches 12 today')).toBeTruthy();
    expect(within(pane).getByText('revoked 5 this week')).toBeTruthy();
  });

  it('inbox rows show agent → target, env/scope tags, quoted reason and age; footer counts auto-approvals', () => {
    render(<Approvals />);
    const rows = screen.getByRole('table', { name: 'Inbox' });
    const first = within(rows).getAllByRole('row')[0];
    if (first === undefined) throw new Error('no inbox rows');
    expect(first.textContent).toContain('Codex');
    expect(first.textContent).toContain('Supabase');
    expect(within(first).getByText('prod').getAttribute('data-on')).toBe('true');
    expect(within(first).getByText('write').getAttribute('data-on')).toBeNull();
    expect(within(first).getByText('"migration 0042" · 3m')).toBeTruthy();
    expect(screen.getByText('auto-approved today: 12 (preview deploys, github reads)')).toBeTruthy();
  });

  it('Review opens the session in the workspace with the grant sheet; Deny sends grant.deny', () => {
    render(<Approvals />);
    const rows = within(screen.getByRole('table', { name: 'Inbox' })).getAllByRole('row');
    const first = rows[0];
    if (first === undefined) throw new Error('no inbox rows');
    fireEvent.click(within(first).getByRole('button', { name: 'Review' }));
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectId).toBe(acme);
    expect(ui.projectSession[acme]).toBe(fixtures.ids.session.codex);
    expect(ui.overlays).toEqual([
      expect.objectContaining({
        kind: 'sheet',
        sheet: 'grant',
        sessionId: fixtures.ids.session.codex,
        askId: fixtures.ids.ask.codexGrant,
      }),
    ]);

    fireEvent.click(within(first).getByRole('button', { name: 'Deny' }));
    expect(commandMock).toHaveBeenCalledWith('grant.deny', { grantId: fixtures.ids.grant.supabaseCodex });
  });

  it('policy rows toggle via policy.toggle; Export JSON copies the exported JSON', async () => {
    render(<Approvals />);
    const pane = screen.getByRole('complementary', { name: 'Policies' });
    const [first] = within(pane).getAllByRole('checkbox');
    if (first === undefined) throw new Error('no policy rows');
    fireEvent.click(first);
    expect(commandMock).toHaveBeenCalledWith('policy.toggle', {
      policyId: fixtures.ids.policy['auto-read-staging-preview'],
      enabled: true,
    });
    fireEvent.click(within(pane).getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"policies":[]}'));
    expect(commandMock).toHaveBeenCalledWith('policy.export', {});
  });

  it('Policies tab shows the intro copy; Audit log rows open the drawer and read as inverted', () => {
    render(<Approvals />);
    fireEvent.click(screen.getByRole('tab', { name: 'Policies' }));
    expect(
      screen.getByText(
        'Policies are evaluated top to bottom. Project overrides in Settings win. Export as JSON to share with a team.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Audit log' }));
    expect(useUiStore.getState().approvalsTab).toBe('audit');
    const log = screen.getByRole('table', { name: 'Audit log' });
    const rows = within(log).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toBe('09:41Claudevercel-prodused deploy token (auto: policy #1)');
    const granted = rows.find((r) => r.textContent?.includes('granted deploy to Claude · 1h'));
    if (granted === undefined) throw new Error('granted row missing');
    fireEvent.keyDown(granted, { key: 'Enter' });
    const overlays = useUiStore.getState().overlays;
    expect(overlays).toEqual([
      expect.objectContaining({ kind: 'drawer', drawer: 'audit', auditId: fixtures.ids.audit(3) }),
    ]);
    expect(granted.getAttribute('data-inv')).toBe('true');
  });
});
