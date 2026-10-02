// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { InstrumentTabs } from './InstrumentTabs';

const commandMock = vi.fn(async (_name: string, _input: unknown) => ({ ok: true as const, value: {} }));
const order = () =>
  [...document.querySelectorAll('[data-workspace-mode]')].map((t) => t.getAttribute('data-workspace-mode'));

describe('InstrumentTabs (#140)', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    const m = fixtures.demoReadModel();
    useReadModel
      .getState()
      .replaceModel(
        { ...m, settings: { ...m.settings, app: { ...m.settings.app, instrumentOrder: ['code', 'tasks'] } } },
        'connected',
      );
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('draws the tabs in the person’s order, the rest after', () => {
    render(<InstrumentTabs mode="code" onPick={() => undefined} />);
    expect(order()).toEqual(['code', 'tasks', 'canvas', 'design', 'changes', 'terminal']);
  });

  it('right-click offers Move left / right / to front / Reset; a pick saves the new order', () => {
    render(<InstrumentTabs mode="code" onPick={() => undefined} />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: copy.chat.instruments.terminal }));
    const menu = screen.getByRole('menu');
    expect(screen.getByRole('menuitem', { name: copy.chat.order.moveRight })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: copy.chat.order.moveFront }));
    expect(commandMock).toHaveBeenCalledWith('settings.set', {
      patch: { instrumentOrder: ['terminal', 'code', 'tasks', 'canvas', 'design', 'changes'] },
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(menu.isConnected).toBe(false);
    fireEvent.contextMenu(screen.getByRole('tab', { name: copy.chat.instruments.code }));
    fireEvent.click(screen.getByRole('menuitem', { name: copy.chat.order.reset }));
    expect(commandMock).toHaveBeenLastCalledWith('settings.set', { patch: { instrumentOrder: [] } });
  });

  it('Alt+Shift+→ moves the focused tab one place', () => {
    render(<InstrumentTabs mode="code" onPick={() => undefined} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: copy.chat.instruments.code }), {
      key: 'ArrowRight',
      altKey: true,
      shiftKey: true,
    });
    expect(commandMock).toHaveBeenCalledWith('settings.set', {
      patch: { instrumentOrder: ['tasks', 'code', 'canvas', 'design', 'changes', 'terminal'] },
    });
  });
});
