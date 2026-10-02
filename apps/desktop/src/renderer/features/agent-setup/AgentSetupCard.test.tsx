// @vitest-environment jsdom
import { copy, fixtures, type AgentSetup, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { AgentSetupCard } from './AgentSetupCard';

// xterm needs a real layout engine; the card only mounts the terminal behind "Show details".
vi.mock('../modals/LoginTerminal', () => ({
  LoginTerminal: ({ terminalId }: { terminalId: string }) => <div data-terminal={terminalId} />,
}));

const commandMock = vi.fn(async (_name: string, _input?: unknown) => ({ ok: true as const, value: {} }));
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);

const run = (over: Partial<AgentSetup>): AgentSetup => ({
  agent: 'codex',
  status: 'running',
  step: 'install',
  preparing: null,
  installedVersion: null,
  installMs: null,
  testedMs: null,
  url: null,
  wantsCode: false,
  problem: null,
  message: null,
  terminalId: null,
  startedAt: fixtures.DEMO_NOW,
  updatedAt: fixtures.DEMO_NOW,
  ...over,
});

const seed = (setup?: AgentSetup) => {
  const m: ReadModel = fixtures.errorReadModel();
  act(() =>
    useReadModel
      .getState()
      .replaceModel(setup === undefined ? m : { ...m, agentSetup: { [setup.agent]: setup } }, 'connected'),
  );
};

describe('AgentSetupCard', () => {
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
  });
  afterEach(cleanup);

  it('not set up: one button starts the whole run; a ready card has no button', async () => {
    seed();
    render(
      <>
        <AgentSetupCard agent="codex" />
        <AgentSetupCard agent="claude" />
      </>,
    );
    expect(screen.getByText('Not on this computer yet. Takes about a minute.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up ChatGPT' }));
    await waitFor(() => expect(calls('agent.setUp')).toEqual([{ agent: 'codex', update: false }]));
    const claude = document.querySelector('[data-agent-setup="claude"]') as HTMLElement;
    expect(claude.getAttribute('data-state')).toBe('ready');
    expect(claude.querySelector('[data-agent-action]')).toBeNull();
  });

  it('signing in: says where to go, copies the link, takes a code, cancels; details show the hidden terminal', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    seed(
      run({
        step: 'signin',
        status: 'waiting',
        url: 'https://auth.openai.com/x',
        wantsCode: true,
        terminalId: 'term-9',
      }),
    );
    render(<AgentSetupCard agent="codex" wide />);
    const card = document.querySelector('[data-agent-setup="codex"]') as HTMLElement;
    expect(card.getAttribute('data-wide')).toBe('true');
    expect(screen.getByText('chatgpt.com opened in your browser.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.agentSetup.browser.copyLink }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://auth.openai.com/x'));
    expect(await screen.findByRole('button', { name: copy.agentSetup.browser.copied })).toBeTruthy();
    fireEvent.change(document.querySelector('[data-agent-code]') as HTMLInputElement, {
      target: { value: ' ABC ' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy.agentSetup.browser.codeSend }));
    await waitFor(() => expect(calls('agent.setUpCode')).toEqual([{ agent: 'codex', code: 'ABC' }]));
    expect(document.querySelector('[data-terminal]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.agentSetup.actions.details }));
    expect(document.querySelector('[data-terminal="term-9"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.agentSetup.actions.cancel }));
    await waitFor(() => expect(calls('agent.setUpCancel')).toEqual([{ agent: 'codex' }]));
  });

  it('a problem offers its one fix: See plans opens the vendor page, Update reinstalls', async () => {
    seed(run({ agent: 'claude', status: 'failed', problem: 'needs-plan', message: 'Needs Pro.' }));
    render(<AgentSetupCard agent="claude" />);
    expect(screen.getByText('Needs Pro.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'See plans' }));
    await waitFor(() => expect(calls('agent.setUpPlans')).toEqual([{ agent: 'claude' }]));
    cleanup();
    seed(run({ status: 'failed', problem: 'out-of-date', message: 'Too old.' }));
    render(<AgentSetupCard agent="codex" />);
    fireEvent.click(screen.getByRole('button', { name: 'Update Codex' }));
    await waitFor(() => expect(calls('agent.setUp').at(-1)).toEqual({ agent: 'codex', update: true }));
  });
});
