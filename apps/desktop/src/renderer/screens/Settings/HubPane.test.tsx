// @vitest-environment jsdom
import { copy, fixtures, HUB_OFF, type HubState, type ReadModel } from '@styx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('signed in: links a project to a space it can write in, and unlinks it', () => {
    useReadModel.getState().replaceModel(withHub(SIGNED_IN), 'connected');
    render(<HubPane />);
    const project = fixtures.demoReadModel().projects.byId[fixtures.ids.project.acmeShop];
    const select = screen.getByLabelText(`Space for ${project?.name}`) as HTMLSelectElement;
    // A viewer cannot share into a space, so it is not offered.
    expect([...select.options].map((o) => o.textContent)).toEqual([copy.hub.notLinked, 'Acme']);
    fireEvent.change(select, { target: { value: 'spc_acme' } });
    expect(commands.at(-1)).toEqual({
      name: 'hub.linkProject',
      input: { projectId: fixtures.ids.project.acmeShop, spaceId: 'spc_acme' },
    });
    fireEvent.change(select, { target: { value: '' } });
    expect(commands.at(-1)?.input).toMatchObject({ spaceId: null });
  });

  it('signed in: opens the hub and signs out', () => {
    useReadModel.getState().replaceModel(withHub(SIGNED_IN), 'connected');
    render(<HubPane />);
    fireEvent.click(screen.getByRole('button', { name: copy.hub.openWeb }));
    fireEvent.click(screen.getByRole('button', { name: copy.hub.signOut }));
    expect(commands.map((c) => c.name)).toEqual(['hub.openWeb', 'hub.signOut']);
  });
});
