import { commandResultSchema } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { CommandBus, CommandError } from './bus';

const bus = () => {
  const b = new CommandBus({
    isRegistered: (id) => id === 1,
    allowedOrigins: ['file://', 'http://localhost:5173'],
  });
  b.register('settings.get', () => ({
    app: {
      theme: 'dark',
      notify: 'badge',
      launchAtLogin: false,
      openFilesIn: 'styx',
      fallbackIde: null,
      autoWorktreePerAgent: true,
      injectAs: 'env',
      screenReader: false,
      dnd: false,
      onboardingDone: true,
      trackAgentEdits: false,
      usageReports: true,
      tourDone: true,
      tourVersion: 2,
    },
  }));
  b.register('project.select', ({ projectId }) => {
    if (projectId === 'boom') throw new CommandError('not-found', 'no such project');
    if (projectId === 'crash') throw new Error('kaboom');
    return {};
  });
  return b;
};
const ok = { senderId: 1, frameUrl: 'file:///Users/x/out/renderer/index.html' };

describe('CommandBus', () => {
  it('rejects unregistered senders and foreign origins before looking at the command', async () => {
    const b = bus();
    expect(await b.dispatch({ senderId: 2, frameUrl: ok.frameUrl }, 'settings.get', {})).toEqual({
      ok: false,
      error: { code: 'forbidden', message: expect.any(String) },
    });
    expect(
      await b.dispatch({ senderId: 1, frameUrl: 'https://evil.example' }, 'settings.get', {}),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await b.dispatch({ senderId: 1, frameUrl: null }, 'settings.get', {})).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(
      await b.dispatch({ senderId: 1, frameUrl: 'http://localhost:5173/' }, 'settings.get', {}),
    ).toMatchObject({ ok: true });
  });

  it('rejects unknown command names before parsing', async () => {
    const b = bus();
    const r = await b.dispatch(ok, 'nope.command', { anything: 1 });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'invalid-input', message: expect.stringContaining('unknown command') },
    });
    expect(await b.dispatch(ok, 42, {})).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  });

  it('parses input with the contract schema', async () => {
    const b = bus();
    const r = await b.dispatch(ok, 'project.select', { projectId: '' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(await b.dispatch(ok, 'project.select', { projectId: 'p1' })).toEqual({ ok: true, value: {} });
  });

  it('never throws: typed CommandError codes and internal errors become results matching commandResultSchema', async () => {
    const b = bus();
    const notFound = await b.dispatch(ok, 'project.select', { projectId: 'boom' });
    expect(notFound).toEqual({ ok: false, error: { code: 'not-found', message: 'no such project' } });
    const crash = await b.dispatch(ok, 'project.select', { projectId: 'crash' });
    expect(crash).toEqual({ ok: false, error: { code: 'internal', message: 'kaboom' } });
    expect(commandResultSchema('project.select').safeParse(crash).success).toBe(true);
    expect(
      commandResultSchema('settings.get').safeParse(await b.dispatch(ok, 'settings.get', {})).success,
    ).toBe(true);
    expect(await b.dispatch(ok, 'session.stop', { sessionId: 's' })).toMatchObject({
      ok: false,
      error: { code: 'internal', message: expect.stringContaining('no handler') },
    });
  });
});

describe('CommandBus.dispatchInternal', () => {
  it('serves main-process callers without a sender frame but still validates name and input', async () => {
    const b = bus();
    expect(await b.dispatchInternal('settings.get', {})).toMatchObject({
      ok: true,
      value: { app: { theme: 'dark' } },
    });
    expect(await b.dispatchInternal('nope.command' as never, {} as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(await b.dispatchInternal('project.select', { projectId: 42 } as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(await b.dispatchInternal('project.select', { projectId: 'boom' } as never)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    // The renderer path is unchanged: a fake sender is still refused.
    expect(await b.dispatch({ senderId: -1, frameUrl: 'file://internal' }, 'settings.get', {})).toMatchObject(
      { ok: false, error: { code: 'forbidden' } },
    );
  });
});
