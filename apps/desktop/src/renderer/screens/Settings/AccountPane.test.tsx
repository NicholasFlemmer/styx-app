// @vitest-environment jsdom
import { copy, fixtures, type ReadModel } from '@styx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { AccountPane } from './AccountPane';

const commands: { name: string; input: unknown }[] = [];

const withAccount = (account: ReadModel['account']): ReadModel => ({
  ...fixtures.demoReadModel(),
  account,
});

describe('AccountPane (ADR-0026)', () => {
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

  it('signed out: says what an account is for and offers both providers', () => {
    useReadModel.getState().replaceModel(withAccount({ kind: 'signed-out', error: null }), 'connected');
    render(<AccountPane />);
    expect(screen.getByText(copy.account.signedOutLead)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
    expect(commands).toEqual([{ name: 'account.signIn', input: { provider: 'github' } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(commands.at(-1)).toEqual({ name: 'account.signIn', input: { provider: 'google' } });
  });

  it('shows why a sign-in failed without hiding the buttons', () => {
    useReadModel
      .getState()
      .replaceModel(withAccount({ kind: 'signed-out', error: copy.account.denied }), 'connected');
    render(<AccountPane />);
    expect(screen.getByText(copy.account.denied)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeTruthy();
  });

  it('signing in: the code is the loudest thing on the pane, with a way back out', () => {
    useReadModel.getState().replaceModel(
      withAccount({
        kind: 'signing-in',
        provider: 'github',
        userCode: 'WXYZ-1234',
        verificationUri: 'https://api.styx.dev/activate',
        expiresAt: fixtures.DEMO_NOW + 900_000,
      }),
      'connected',
    );
    render(<AccountPane />);
    expect(screen.getByText('WXYZ-1234')).toBeTruthy();
    expect(screen.getByText(copy.account.waiting)).toBeTruthy();
    // The URI itself is never shown: the browser is already open at it, and it is long.
    expect(screen.queryByText('https://api.styx.dev/activate')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.account.openAgain }));
    expect(commands.at(-1)).toEqual({ name: 'account.openVerification', input: {} });
    fireEvent.click(screen.getByRole('button', { name: copy.account.cancel }));
    expect(commands.at(-1)).toEqual({ name: 'account.cancelSignIn', input: {} });
  });

  it('signed in: name, email, plan, how and since; Refresh and Sign out', () => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    render(<AccountPane />);
    expect(screen.getByText('Nic Flemmer')).toBeTruthy();
    expect(screen.getByText('nic@acme.dev')).toBeTruthy();
    expect(screen.getByText(copy.account.plans.pro)).toBeTruthy();
    expect(screen.getByText(/Signed in with GitHub/)).toBeTruthy();
    expect(screen.getByText(copy.account.usedFor)).toBeTruthy();
    expect(document.querySelector('[data-account-stale]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.account.refresh }));
    expect(commands.at(-1)).toEqual({ name: 'account.refresh', input: {} });
    fireEvent.click(screen.getByRole('button', { name: copy.account.signOut }));
    expect(commands.at(-1)).toEqual({ name: 'account.signOut', input: {} });
  });

  it('offline: the session stands and the pane says since when', () => {
    const demo = fixtures.demoReadModel();
    if (demo.account.kind !== 'signed-in') throw new Error('fixture');
    useReadModel
      .getState()
      .replaceModel(
        withAccount({ ...demo.account, staleSince: fixtures.DEMO_NOW - 3 * 60 * 60_000 }),
        'connected',
      );
    render(<AccountPane />);
    expect(document.querySelector('[data-account-stale]')?.textContent).toContain('Offline since 3h');
    // Still signed in: the account details and Sign out are all still there.
    expect(screen.getByText('Nic Flemmer')).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.account.signOut })).toBeTruthy();
  });

  it('a paid plan with an end date says until when', () => {
    const demo = fixtures.demoReadModel();
    if (demo.account.kind !== 'signed-in') throw new Error('fixture');
    useReadModel.getState().replaceModel(
      withAccount({
        ...demo.account,
        account: { ...demo.account.account, plan: 'team', planUntil: fixtures.DEMO_NOW + 30 * 86_400_000 },
      }),
      'connected',
    );
    render(<AccountPane />);
    expect(screen.getByText(/Team · until/)).toBeTruthy();
  });
});
