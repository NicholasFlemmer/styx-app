// @vitest-environment jsdom
import { copy, fixtures, HUB_OFF, type HubContextEntry, type HubState } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { Team } from './Team';

const t = copy.hub.lean;
const commands: { name: string; input: unknown }[] = [];

const SIGNED_IN: HubState = {
  ...HUB_OFF,
  connection: {
    kind: 'signed-in',
    account: { id: 'usr_nic', email: 'nic@launchsite.co.za', name: 'Nic' },
    teams: [{ id: 'team_ls', name: 'Launchsite', domain: 'launchsite.co.za', role: 'admin' }],
    spaces: [],
    staleSince: null,
  },
};

const VOICE: HubContextEntry = {
  id: 'ctx_voice',
  kind: 'doc',
  title: 'Acme brand voice',
  body: 'Plain, warm, no exclamation marks.\n\nPrices in rand.',
  stale: false,
  by: 'Thandi M.',
  updatedAt: 1,
};
const STRIPE: HubContextEntry = {
  ...VOICE,
  id: 'ctx_stripe',
  kind: 'decision',
  title: 'Payments go through Stripe',
  body: 'Not PayFast.',
};
let items: HubContextEntry[] = [];

const show = (hub: HubState) =>
  useReadModel.getState().replaceModel({ ...fixtures.demoReadModel(), hub }, 'connected');
const settle = () => act(async () => vi.advanceTimersByTimeAsync(250));

describe('Team context (the lean hub)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    commands.length = 0;
    items = [VOICE, STRIPE];
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'hub.teamContext') return { ok: true, value: { items } };
          if (name === 'hub.addContext') return { ok: true, value: { id: 'ctx_new' } };
          return { ok: true, value: {} };
        }),
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.assign(window, { styx: undefined });
  });

  it('signed out: says what it is for and signs in', () => {
    show(HUB_OFF);
    render(<Team />);
    expect(screen.getByText(copy.hub.teamScreen.signedOut)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.signIn }));
    expect(commands).toEqual([{ name: 'hub.signIn', input: {} }]);
  });

  it('while signing in: shows the code the browser page asks for, opens the page again or cancels', () => {
    show({
      ...HUB_OFF,
      connection: {
        kind: 'signing-in',
        userCode: 'BPGA-B65K',
        verificationUri: 'https://hub/activate',
        expiresAt: 1,
      },
    });
    render(<Team />);
    expect(screen.getByText('BPGA-B65K')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.openBrowser }));
    fireEvent.click(screen.getByRole('button', { name: copy.hub.cancel }));
    expect(commands).toEqual([
      { name: 'hub.openVerification', input: {} },
      { name: 'hub.cancelSignIn', input: {} },
    ]);
  });

  it('signed out after a failed sign-in: says why', () => {
    show({ ...HUB_OFF, connection: { kind: 'signed-out', error: 'The code expired.' } });
    render(<Team />);
    expect(screen.getByRole('alert').textContent).toBe('The code expired.');
  });

  it('lists the team context, opens an entry, and searches by a question', async () => {
    show(SIGNED_IN);
    render(<Team />);
    await settle();
    expect(screen.getByText('Acme brand voice')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Acme brand voice/ }));
    expect(screen.getByText('Prices in rand.')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: t.find }), {
      target: { value: 'what is our voice?' },
    });
    await settle();
    expect(commands.at(-1)).toEqual({ name: 'hub.teamContext', input: { q: 'what is our voice?' } });
  });

  it('adds an entry for the whole team', async () => {
    show(SIGNED_IN);
    render(<Team />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: t.addToContext }));
    fireEvent.change(screen.getByLabelText(t.title), { target: { value: 'How we price retainers' } });
    fireEvent.click(screen.getByRole('button', { name: t.decision }));
    fireEvent.change(screen.getByLabelText(t.body), { target: { value: 'Monthly, three months minimum.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.add }));
    });
    expect(commands).toContainEqual({
      name: 'hub.addContext',
      input: { title: 'How we price retainers', body: 'Monthly, three months minimum.', kind: 'decision' },
    });
  });

  it('edits an entry and marks it out of date', async () => {
    show(SIGNED_IN);
    render(<Team />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Payments go through Stripe/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.outOfDate }));
    });
    expect(commands).toContainEqual({ name: 'hub.updateContext', input: { id: 'ctx_stripe', stale: true } });
    fireEvent.click(screen.getByRole('button', { name: t.edit }));
    fireEvent.change(screen.getByLabelText(t.body), { target: { value: 'Not PayFast. Card fees agreed.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.save }));
    });
    expect(commands).toContainEqual({
      name: 'hub.updateContext',
      input: {
        id: 'ctx_stripe',
        title: 'Payments go through Stripe',
        body: 'Not PayFast. Card fees agreed.',
      },
    });
  });

  it('says what to add when there is nothing yet', async () => {
    items = [];
    show(SIGNED_IN);
    render(<Team />);
    await settle();
    expect(screen.getByText(t.empty)).toBeTruthy();
  });
});
