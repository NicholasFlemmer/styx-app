// @vitest-environment jsdom
import { copy, fixtures, navLanes, type ProjectId, type SessionId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { TasksBoard } from './TasksBoard';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;
const commands: { name: string; input: unknown }[] = [];

describe('TasksBoard (#138)', () => {
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'session.spawn') return { ok: true, value: { sessionId: 'new-lane' } };
          return { ok: true, value: {} };
        }),
      },
    });
    useReadModel.setState({ model: fixtures.demoReadModel() });
    useUiStore.setState({ overlays: [], screen: 'workspace', projectId: acme, projectSession: {} });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('a card per running task, with its task and whose turn; the one in the chat is marked', () => {
    render(<TasksBoard projectId={acme} activeSessionId={claude} />);
    const running = navLanes(fixtures.demoReadModel(), acme, fixtures.DEMO_NOW).filter(
      (l) => l.status !== 'landed' && l.status !== 'finished',
    );
    const cards = [...document.querySelectorAll('[data-tasks-card]')];
    expect(cards.map((c) => c.getAttribute('data-tasks-card'))).toEqual(running.map((l) => l.sessionId));
    const here = document.querySelector(`[data-tasks-card="${claude}"]`) as HTMLElement;
    expect(here.getAttribute('aria-current')).toBe('true');
    expect(within(here).getByText(copy.chat.tasks.inChat)).toBeTruthy();
    for (const lane of running) {
      const card = document.querySelector(`[data-tasks-card="${lane.sessionId}"]`) as HTMLElement;
      expect(card.textContent).toContain(lane.task);
      expect(card.textContent).toContain(lane.statusLabel);
    }
    // Summaries, not chats: no composer on the board.
    expect(document.querySelector('[data-chat-pane]')).toBeNull();
  });

  it('clicking a card opens its lane in the chat', () => {
    render(<TasksBoard projectId={acme} activeSessionId={claude} />);
    const other = [...document.querySelectorAll('[data-tasks-card]')].find(
      (c) => c.getAttribute('data-tasks-card') !== claude,
    ) as HTMLButtonElement;
    fireEvent.click(other);
    expect(useUiStore.getState().projectSession[acme]).toBe(other.getAttribute('data-tasks-card'));
  });

  it('starts another lane alongside without taking the chat', async () => {
    render(<TasksBoard projectId={acme} activeSessionId={claude} />);
    const board = screen.getByRole('region', { name: copy.chat.tasks.label });
    expect(within(board).getByRole('heading', { name: copy.chat.tasks.alongside.title })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(copy.chat.tasks.alongside.label), {
      target: { value: 'Add a sitemap' },
    });
    fireEvent.click(document.querySelector('[data-tasks-add-start]') as HTMLButtonElement);
    await waitFor(() => expect(commands.some((c) => c.name === 'session.spawn')).toBe(true));
    const spawn = commands.find((c) => c.name === 'session.spawn')?.input as { firstMessage: string };
    expect(spawn.firstMessage).toBe('Add a sitemap');
    expect(useUiStore.getState().projectSession[acme]).toBeUndefined();
  });
});
