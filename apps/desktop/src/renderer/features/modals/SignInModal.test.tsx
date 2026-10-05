// @vitest-environment jsdom
import { copy, fixtures, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { SignInModal } from './SignInModal';

const commands: { name: string; input: unknown }[] = [];

const signedOut = (over: Partial<ReadModel> = {}): ReadModel => ({
  ...fixtures.demoReadModel(),
  account: { kind: 'signed-out', error: null },
  ...over,
});

describe('SignInModal (discrepancy #113)', () => {
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
    useReadModel.getState().replaceModel(signedOut(), 'connected');
    useUiStore.setState({ overlays: [], platform: 'darwin' });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  const open = (reason?: 'welcome' | 'plain') => {
    const id = useUiStore
      .getState()
      .pushOverlay({ kind: 'modal', modal: 'sign-in', ...(reason === undefined ? {} : { reason }) });
    render(<SignInModal id={id} {...(reason === undefined ? {} : { reason })} />);
    return id;
  };

  it('is a dialog with both providers and nothing else to decide', () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(copy.account.modal.title);
    expect(dialog.textContent).toContain(copy.account.modal.plain);
    expect(dialog.textContent).toContain(copy.account.modal.note);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
    expect(commands).toEqual([{ name: 'account.signIn', input: { provider: 'github' } }]);
  });

  it.each([
    ['welcome', copy.account.modal.welcome],
    ['plain', copy.account.modal.plain],
  ] as const)('%s opens with its own one line of lead', (reason, lead) => {
    open(reason);
    expect(screen.getByText(lead)).toBeTruthy();
  });

  it('shows the code in the same dialog once a provider is picked', () => {
    const id = open();
    act(() =>
      useReadModel.getState().replaceModel(
        signedOut({
          account: {
            kind: 'signing-in',
            provider: 'github',
            userCode: 'WXYZ-1234',
            verificationUri: 'https://api/activate',
            expiresAt: fixtures.DEMO_NOW + 900_000,
          },
        }),
        'connected',
      ),
    );
    cleanup();
    render(<SignInModal id={id} />);
    expect(screen.getByText('WXYZ-1234')).toBeTruthy();
    expect(screen.getByText(copy.account.waiting)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull();
    // Going back to the provider list means abandoning the code, so it cancels the flow.
    fireEvent.click(screen.getByRole('button', { name: copy.account.modal.switchProvider }));
    expect(commands.at(-1)).toEqual({ name: 'account.cancelSignIn', input: {} });
  });

  it('closes itself the moment the browser side finishes', () => {
    const id = open();
    act(() => useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected'));
    cleanup();
    render(<SignInModal id={id} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState().overlays).toEqual([]);
  });

  it('"Not now" closes it and abandons a flow in progress', () => {
    const id = open('welcome');
    fireEvent.click(screen.getByRole('button', { name: copy.account.modal.later }));
    expect(useUiStore.getState().overlays).toEqual([]);
    // Nothing was running, so nothing was cancelled.
    expect(commands).toEqual([]);
    cleanup();

    useReadModel.getState().replaceModel(
      signedOut({
        account: {
          kind: 'signing-in',
          provider: 'google',
          userCode: 'AAAA-2222',
          verificationUri: 'https://api/activate',
          expiresAt: fixtures.DEMO_NOW + 900_000,
        },
      }),
      'connected',
    );
    const second = useUiStore.getState().pushOverlay({ kind: 'modal', modal: 'sign-in' });
    render(<SignInModal id={second} />);
    fireEvent.click(screen.getByRole('button', { name: copy.account.modal.later }));
    expect(commands.at(-1)).toEqual({ name: 'account.cancelSignIn', input: {} });
    expect(useUiStore.getState().overlays).toEqual([]);
    void id;
  });

  it('surfaces a failed attempt without hiding the providers', () => {
    useReadModel
      .getState()
      .replaceModel(signedOut({ account: { kind: 'signed-out', error: copy.account.failed } }), 'connected');
    open();
    expect(screen.getByText(copy.account.failed)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeTruthy();
  });
});

describe('first launch (discrepancy #113)', () => {
  afterEach(cleanup);

  /** The demo model with onboarding not yet done and nobody signed in. */
  const freshInstall = (): ReadModel => {
    const model = fixtures.demoReadModel();
    return {
      ...model,
      account: { kind: 'signed-out', error: null },
      settings: { ...model.settings, app: { ...model.settings.app, onboardingDone: false } },
    };
  };

  it('puts the sign-in dialog on screen before anything else', () => {
    useUiStore.setState({ overlays: [], screenResolved: false, screen: 'home' });
    useUiStore.getState().resolveInitialScreen(freshInstall());
    expect(useUiStore.getState().screen).toBe('onboarding');
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'sign-in', reason: 'welcome' },
    ]);
  });

  it('does not ask again once onboarding is done, or of someone already signed in', () => {
    const model = freshInstall();
    useUiStore.setState({ overlays: [], screenResolved: false });
    useUiStore.getState().resolveInitialScreen({
      ...model,
      settings: { ...model.settings, app: { ...model.settings.app, onboardingDone: true } },
    });
    expect(useUiStore.getState().overlays).toEqual([]);

    useUiStore.setState({ overlays: [], screenResolved: false });
    // Signed in on a fresh install (a second machine): nothing to ask.
    useUiStore.getState().resolveInitialScreen({ ...fixtures.demoReadModel(), settings: model.settings });
    expect(useUiStore.getState().overlays).toEqual([]);
  });
});
