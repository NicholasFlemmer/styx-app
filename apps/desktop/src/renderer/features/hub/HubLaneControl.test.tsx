// @vitest-environment jsdom
import { copy, fixtures, HUB_OFF, type HubState, type ProjectId, type SessionId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { HubLaneControl } from './HubLaneControl';

const commands: { name: string; input: unknown }[] = [];
const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;

const SIGNED_IN: HubState['connection'] = {
  kind: 'signed-in',
  account: { id: 'usr_nic', email: 'nic@launchsite.co.za', name: 'Nic' },
  teams: [{ id: 'team_ls', name: 'Launchsite', domain: 'launchsite.co.za', role: 'admin' }],
  spaces: [
    { id: 'spc_acme', teamId: 'team_ls', name: 'Acme', role: 'owner', agentProposals: 'review' },
    { id: 'spc_view', teamId: 'team_ls', name: 'Read only', role: 'viewer', agentProposals: 'review' },
  ],
  staleSince: null,
};

const withHub = (hub: Partial<HubState>) =>
  useReadModel
    .getState()
    .replaceModel({ ...fixtures.demoReadModel(), hub: { ...HUB_OFF, ...hub } }, 'connected');

const show = () => render(<HubLaneControl projectId={acme} projectName="acme-shop" sessionId={claude} />);

describe('HubLaneControl (ADR-0032: connecting is not hidden in Settings)', () => {
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return { ok: true, value: name === 'hub.createSpace' ? { spaceId: 'spc_new' } : {} };
        }),
      },
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('signed out: Connect opens a panel that signs in right here', () => {
    withHub({});
    show();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.button }));
    expect(screen.getByText(copy.hub.connect.signInLead)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.signIn }));
    expect(commands).toEqual([{ name: 'hub.signIn', input: {} }]);
  });

  it('signing in: the panel shows the code to type', () => {
    withHub({
      connection: {
        kind: 'signing-in',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://h/activate',
        expiresAt: 0,
      },
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.button }));
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
  });

  it('signed in, not connected: one click on a space connects the project; viewers are not offered', async () => {
    withHub({ connection: SIGNED_IN });
    show();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.button }));
    expect(screen.getByText('Where should acme-shop be shared?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Read only' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Acme' }));
    });
    expect(commands).toEqual([{ name: 'hub.linkProject', input: { projectId: acme, spaceId: 'spc_acme' } }]);
  });

  it('can make a space named after the project and connect to it', async () => {
    withHub({ connection: SIGNED_IN });
    show();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.button }));
    expect((screen.getByLabelText(copy.hub.connect.newSpaceLabel) as HTMLInputElement).value).toBe(
      'acme-shop',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.create }));
    });
    expect(commands).toEqual([
      { name: 'hub.createSpace', input: { name: 'acme-shop' } },
      { name: 'hub.linkProject', input: { projectId: acme, spaceId: 'spc_new' } },
    ]);
  });

  it('closes on Escape and offers the full settings', () => {
    withHub({ connection: SIGNED_IN });
    show();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.button }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.button }));
    fireEvent.click(screen.getByRole('button', { name: copy.hub.connect.settings }));
    expect(useUiStore.getState().screen).toBe('settings');
  });

  it('connected: the lane share switch takes its place', () => {
    withHub({ connection: SIGNED_IN, links: [{ projectId: acme, spaceId: 'spc_acme', hubProjectId: 'p' }] });
    show();
    expect(screen.queryByRole('button', { name: copy.hub.connect.button })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.lane.onlyYou }));
    expect(commands).toEqual([{ name: 'hub.shareLane', input: { sessionId: claude, shared: true } }]);
  });
});
