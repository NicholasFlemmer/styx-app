// @vitest-environment jsdom
import { copy, fixtures, type ReadModel } from '@styx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
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

  it('signed out: the pane says where you stand and hands sign-in to the dialog (discrepancy #113)', () => {
    useReadModel.getState().replaceModel(withAccount({ kind: 'signed-out', error: null }), 'connected');
    useUiStore.setState({ overlays: [] });
    render(<AccountPane />);
    expect(screen.getByText(copy.account.paneSignedOut)).toBeTruthy();
    // No provider buttons here any more: this pane is for managing an account, not getting one.
    expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.account.signIn }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'sign-in', reason: 'plain' },
    ]);
    expect(commands).toEqual([]); // the dialog starts the flow, not the pane
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
