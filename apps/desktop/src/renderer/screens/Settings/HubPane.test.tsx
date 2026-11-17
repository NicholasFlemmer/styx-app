// @vitest-environment jsdom
import { copy, fixtures, HUB_OFF, type HubState, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { HubPane } from './HubPane';

const commands: { name: string; input: unknown }[] = [];

const withHub = (hub: HubState): ReadModel => ({ ...fixtures.demoReadModel(), hub });

const SIGNED_IN: HubState = {
  ...HUB_OFF,
  webUrl: 'https://hub.test',
  connection: {
    kind: 'signed-in',
    account: { id: 'usr_nic', email: 'nic@launchsite.co.za', name: 'Nic' },
    teams: [{ id: 'team_ls', name: 'Launchsite', domain: 'launchsite.co.za', role: 'admin' }],
    spaces: [
      { id: 'spc_acme', teamId: 'team_ls', name: 'Acme', role: 'owner', agentProposals: 'review' },
      { id: 'spc_view', teamId: 'team_ls', name: 'Read only', role: 'viewer', agentProposals: 'review' },
    ],
    staleSince: null,
  },
};

describe('HubPane (ADR-0032)', () => {
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'hub.teamMembers')
            return {
              ok: true,
              value: {
                team: 'Launchsite',
                admin: true,
                members: [
                  { userId: 'usr_nic', name: 'Nic', email: 'nic@launchsite.co.za', role: 'admin' },
                  { userId: 'usr_d', name: 'Dane', email: 'dane@launchsite.co.za', role: 'member' },
                ],
              },
            };
          if (name === 'hub.invite') return { ok: true, value: { link: 'https://hub/setup?token=x' } };
          return { ok: true, value: {} };
        }),
      },
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('signed out: says what the hub is for and signs in with Google', () => {
    useReadModel.getState().replaceModel(withHub(HUB_OFF), 'connected');
    render(<HubPane />);
    expect(screen.getByText(copy.hub.lead)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.signIn }));
    expect(commands).toEqual([{ name: 'hub.signIn', input: {} }]);
  });

  it('signed out with a reason: shows it as an alert', () => {
    useReadModel
      .getState()
      .replaceModel(
        withHub({ ...HUB_OFF, connection: { kind: 'signed-out', error: copy.hub.notOnTeam } }),
        'connected',
      );
    render(<HubPane />);
    expect(screen.getByRole('alert').textContent).toBe(copy.hub.notOnTeam);
  });

  it('signing in: shows the code to type, and can cancel', () => {
    useReadModel.getState().replaceModel(
      withHub({
        ...HUB_OFF,
        connection: {
          kind: 'signing-in',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://hub.test/activate',
          expiresAt: 0,
        },
      }),
      'connected',
    );
    render(<HubPane />);
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.cancel }));
    expect(commands.at(-1)?.name).toBe('hub.cancelSignIn');
  });

  it('signed in: shows the people on the team; an admin invites and removes', async () => {
    useReadModel.getState().replaceModel(withHub(SIGNED_IN), 'connected');
    await act(async () => {
      render(<HubPane />);
    });
    expect(screen.getByText('Dane')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(copy.hub.lean.inviteEmail), {
      target: { value: 'sam@launchsite.co.za' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.lean.makeInvite }));
    });
    expect(commands).toContainEqual({ name: 'hub.invite', input: { email: 'sam@launchsite.co.za' } });
    expect((screen.getByLabelText(copy.hub.lean.inviteLink) as HTMLInputElement).value).toBe(
      'https://hub/setup?token=x',
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${copy.hub.lean.remove}: Dane` }));
    });
    expect(commands).toContainEqual({ name: 'hub.removeMember', input: { userId: 'usr_d' } });
  });

  it('signed in: no project linking and no web app any more; signs out', async () => {
    useReadModel.getState().replaceModel(withHub(SIGNED_IN), 'connected');
    await act(async () => {
      render(<HubPane />);
    });
    expect(screen.queryByRole('button', { name: copy.hub.openWeb })).toBeNull();
    expect(document.querySelector('[data-hub-project]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.signOut }));
    expect(commands.at(-1)).toEqual({ name: 'hub.signOut', input: {} });
  });
});
