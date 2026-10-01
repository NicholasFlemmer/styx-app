// @vitest-environment jsdom
import { copy, fixtures, type ProjectId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { NewTask } from './NewTask';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const commands: { name: string; input: unknown }[] = [];

describe('NewTask (ADR-0027 §1)', () => {
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'session.spawn') return { ok: true, value: { sessionId: 'sess_new' } };
          return { ok: true, value: {} };
        }),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
      newTask: { projectId: acme, text: '' },
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  const spawned = () =>
    commands
      .filter((c) => c.name === 'session.spawn')
      .map((c) => c.input as { firstMessage: string; agent: string });

  it('one box and Start: the box takes focus, Start waits for words, then spawns with the defaults and opens the lane', async () => {
    render(<NewTask projectId={acme} />);
    const box = screen.getByRole('textbox', { name: copy.newTask.label });
    expect(document.activeElement).toBe(box);
    const startButton = document.querySelector('[data-new-task-start]') as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Add a recently viewed row' } });
    expect(startButton.disabled).toBe(false);
    fireEvent.click(startButton);
    await waitFor(() => expect(spawned()).toHaveLength(1));
    expect(spawned()[0]?.firstMessage).toBe('Add a recently viewed row');
    await waitFor(() => expect(useUiStore.getState().newTask).toBeNull());
    expect(useUiStore.getState().projectSession[acme]).toBe('sess_new');
  });

  it('Mod+⏎ starts; Escape goes back to the work without starting', async () => {
    render(<NewTask projectId={acme} initialText="from the palette" />);
    const box = screen.getByRole('textbox', { name: copy.newTask.label }) as HTMLTextAreaElement;
    expect(box.value).toBe('from the palette');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(useUiStore.getState().newTask).toBeNull();
    expect(spawned()).toHaveLength(0);
    act(() => useUiStore.setState({ newTask: { projectId: acme, text: '' } }));
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(spawned()).toHaveLength(1));
  });

  it('a starter starts in one click with its own words; picking a tile changes the agent', async () => {
    render(<NewTask projectId={acme} />);
    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    expect(screen.getByRole('radio', { name: /Codex/ }).getAttribute('aria-checked')).toBe('true');
    const first = copy.newTask.starters[0];
    if (first === undefined) throw new Error('copy');
    fireEvent.click(screen.getAllByRole('button', { name: copy.newTask.startThis })[0] as HTMLElement);
    await waitFor(() => expect(spawned()).toHaveLength(1));
    expect(spawned()[0]).toMatchObject({ firstMessage: first.prompt, agent: 'codex' });
  });

  it('lists what is already running in the project, and opens a lane from it', () => {
    render(<NewTask projectId={acme} />);
    const aside = screen.getByRole('complementary', { name: `Already running in acme-shop` });
    const lane = aside.querySelector('button') as HTMLButtonElement;
    expect(lane).not.toBeNull();
    fireEvent.click(lane);
    expect(useUiStore.getState().newTask).toBeNull();
    expect(useUiStore.getState().screen).toBe('workspace');
  });
});
