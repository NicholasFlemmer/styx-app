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

  it('tiles every running lane but the one in the chat, each a small chat under its task', () => {
    render(<TasksBoard projectId={acme} activeSessionId={claude} />);
    const running = navLanes(fixtures.demoReadModel(), acme, fixtures.DEMO_NOW).filter(
      (l) => l.status !== 'landed' && l.status !== 'finished' && l.sessionId !== claude,
    );
    expect(running.length).toBeGreaterThan(0);
    const tiles = document.querySelectorAll('[data-tasks-tile]');
    expect([...tiles].map((t) => t.getAttribute('data-tasks-tile'))).toEqual(running.map((l) => l.sessionId));
    expect(document.querySelector(`[data-tasks-tile="${claude}"]`)).toBeNull();
    const first = running[0];
    if (first === undefined) throw new Error('fixture');
    const tile = tiles[0] as HTMLElement;
    expect(within(tile).getByRole('heading', { name: first.task })).toBeTruthy();
    expect(tile.querySelector(`[data-chat-tile="${first.sessionId}"]`)).not.toBeNull();
    // A tile is not the lane's chat: e2e and keyboard code that look for the chat pane find only the real one.
    expect(document.querySelector('[data-chat-pane]')).toBeNull();
  });

  it('Open in chat brings that lane into the chat', () => {
    render(<TasksBoard projectId={acme} activeSessionId={claude} />);
    const open = document.querySelector('[data-tasks-open]') as HTMLButtonElement;
    const id = open.getAttribute('data-tasks-open');
    fireEvent.click(open);
    expect(useUiStore.getState().projectSession[acme]).toBe(id);
  });

  it('starts another lane alongside without taking the chat', async () => {
    render(<TasksBoard projectId={acme} activeSessionId={claude} />);
    const add = screen.getByRole('region', { name: copy.chat.tasks.label });
    expect(within(add).getByRole('heading', { name: copy.chat.tasks.alongside.title })).toBeTruthy();
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
