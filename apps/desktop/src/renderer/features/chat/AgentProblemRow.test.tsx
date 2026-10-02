// @vitest-environment jsdom
import { copy, fixtures, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { AgentProblemRow } from './AgentProblemRow';

const acme = fixtures.ids.project.acmeShop;
const commandMock = vi.fn(async (_name: string, _input?: unknown) => ({ ok: true as const, value: {} }));

/** The error fixture with Gemini signed out (its CLI is installed) and Claude and Cursor ready. */
const seed = (m: ReadModel = fixtures.errorReadModel()) =>
  act(() => useReadModel.getState().replaceModel(m, 'connected'));

describe('AgentProblemRow', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: commandMock,
        onEvent: () => () => {},
      },
    });
    useUiStore.setState({ overlays: [], newTask: null });
  });
  afterEach(cleanup);

  it('signed out: Sign in runs setup and shows its card; another ready agent can take the ask', async () => {
    seed();
    render(
      <AgentProblemRow
        agent="gemini"
        problem="signed-out"
        text="Gemini is signed out."
        projectId={acme}
        retryText="Fix it"
      />,
    );
    expect(screen.getByText(copy.agentSetup.chat.signedOutBody)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Gemini' }));
    await waitFor(() =>
      expect(commandMock.mock.calls.filter((c) => c[0] === 'agent.setUp').map((c) => c[1])).toEqual([
        { agent: 'gemini', update: false },
      ]),
    );
    expect(useUiStore.getState().overlays.at(-1)).toMatchObject({ modal: 'connect-agent', agent: 'gemini' });
    fireEvent.click(screen.getByRole('button', { name: 'Send it to Claude instead' }));
    expect(useUiStore.getState().newTask).toEqual({ projectId: acme, text: 'Fix it' });
  });

  it('once it is signed in again the Sign in button goes; out of usage offers only another agent; none ready, no buttons', () => {
    seed();
    render(
      <AgentProblemRow
        agent="claude"
        problem="signed-out"
        text="Claude is signed out."
        projectId={acme}
        retryText=""
      />,
    );
    expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
    cleanup();
    render(<AgentProblemRow agent="claude" problem="limit" text="Out." projectId={acme} retryText="" />);
    expect(screen.getByText(copy.agentSetup.chat.limitBody)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send it to Cursor instead' })).toBeTruthy();
    cleanup();
    const m = fixtures.errorReadModel();
    seed({ ...m, discovery: { ...m.discovery, clis: [] } });
    render(<AgentProblemRow agent="claude" problem="limit" text="Out." projectId={acme} retryText="" />);
    expect(screen.queryAllByRole('button')).toEqual([]);
    cleanup();
    const { container } = render(
      <AgentProblemRow agent="shell" problem="limit" text="Out." projectId={acme} retryText="" />,
    );
    expect(container.innerHTML).toBe('');
  });
});
