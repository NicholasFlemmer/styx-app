// @vitest-environment jsdom
import { copy, fixtures, HUB_OFF, type HubInboxEntry, type HubState, type HubThreadView } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { Team } from './Team';

const commands: { name: string; input: unknown }[] = [];

const SIGNED_IN: HubState = {
  ...HUB_OFF,
  waiting: 2,
  connection: {
    kind: 'signed-in',
    account: { id: 'usr_nic', email: 'nic@launchsite.co.za', name: 'Nic' },
    teams: [],
    spaces: [],
    staleSince: null,
  },
};

const ASK: HubInboxEntry = {
  id: 'ask:ask_1',
  kind: 'ask',
  spaceId: 'spc_acme',
  spaceName: 'Acme',
  threadId: 'thr_1',
  itemId: null,
  title: 'Launch the brand site',
  snippet: 'Ship pricing with annual plans?',
  who: { name: 'Thandi M.', agent: 'Codex' },
  at: 1,
  read: false,
  ask: { id: 'ask_1', options: ['Yes', 'Not yet'] },
};
const MENTION: HubInboxEntry = {
  ...ASK,
  id: 'mention:msg_1',
  kind: 'mention',
  snippet: '@Nic logo in the footer?',
  who: { name: 'Thandi M.', agent: null },
  ask: null,
};
const VIEW: HubThreadView = {
  thread: {
    id: 'thr_1',
    title: 'Launch the brand site',
    status: 'open',
    owner: 'Nic',
    summary: 'Pricing next.',
    spaceName: 'Acme',
  },
  tasks: [
    { id: 'tsk_1', text: 'Home page', done: true, assignee: 'Claude for Nic', mine: true },
    { id: 'tsk_2', text: 'Approve pricing copy', done: false, assignee: 'you', mine: true },
  ],
  asks: [],
  messages: [
    {
      id: 'm1',
      who: 'Nic',
      agent: 'Claude',
      branch: 'agent/claude-1',
      body: '@Thandi can you own pricing?',
      at: 1,
    },
  ],
};

describe('Team screen (ADR-0032 round 1)', () => {
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'hub.inbox') return { ok: true, value: { entries: [ASK, MENTION] } };
          if (name === 'hub.thread') return { ok: true, value: VIEW };
          return { ok: true, value: {} };
        }),
      },
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('signed out: says what it is for and signs in', () => {
    useReadModel.getState().replaceModel({ ...fixtures.demoReadModel(), hub: HUB_OFF }, 'connected');
    render(<Team />);
    expect(screen.getByText(copy.hub.teamScreen.signedOut)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.hub.signIn }));
    expect(commands).toEqual([{ name: 'hub.signIn', input: {} }]);
  });

  it('lists what waits, grouped, and answers an ask in one click', async () => {
    useReadModel.getState().replaceModel({ ...fixtures.demoReadModel(), hub: SIGNED_IN }, 'connected');
    await act(async () => {
      render(<Team />);
    });
    expect(screen.getByRole('region', { name: copy.hub.teamScreen.groups.ask }).textContent).toContain(
      'Ship pricing with annual plans?',
    );
    expect(screen.getByText(copy.hub.teamScreen.empty.task)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    });
    expect(commands).toContainEqual({ name: 'hub.answer', input: { askId: 'ask_1', choice: 'Yes' } });
  });

  it('opens the thread: where it stands, tasks, the conversation; ticks a task and replies', async () => {
    useReadModel.getState().replaceModel({ ...fixtures.demoReadModel(), hub: SIGNED_IN }, 'connected');
    await act(async () => {
      render(<Team />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /logo in the footer/ }));
    });
    expect(commands).toContainEqual({ name: 'hub.markRead', input: { ids: ['mention:msg_1'] } });
    expect(screen.getByText('Pricing next.')).toBeTruthy();
    expect(screen.getByText('@Thandi').className).toContain('mention');
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Approve pricing copy' }));
    });
    expect(commands).toContainEqual({ name: 'hub.setTask', input: { taskId: 'tsk_2', done: true } });
    fireEvent.change(screen.getByRole('textbox', { name: /Reply as Nic/ }), {
      target: { value: 'Done, approved.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.teamScreen.send }));
    });
    expect(commands).toContainEqual({
      name: 'hub.reply',
      input: { threadId: 'thr_1', body: 'Done, approved.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.teamScreen.markDone }));
    });
    expect(commands).toContainEqual({
      name: 'hub.setThreadStatus',
      input: { threadId: 'thr_1', status: 'done' },
    });
  });
});
