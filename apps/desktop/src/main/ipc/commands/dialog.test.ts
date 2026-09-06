import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test-support';
import { CommandBus } from '../bus';
import { registerDialogCommands } from './dialog';

const busFor = (env: NodeJS.ProcessEnv, dialogs?: { folder?: string | null; file?: string | null }) => {
  const t = makeTestApp({ fixture: null });
  const app = {
    ...t.app,
    dialogs: {
      pickFolder: async () => dialogs?.folder ?? null,
      pickFile: async () => dialogs?.file ?? null,
    },
  };
  const bus = new CommandBus({ isRegistered: () => true, allowedOrigins: ['file://'] });
  registerDialogCommands(bus, app, env);
  return { bus, sender: t.sender };
};

describe('dialog.* commands', () => {
  it('under STYX_E2E the answer is STYX_E2E_PICK (unset = dismissed) and no OS dialog is consulted', async () => {
    const { bus, sender } = busFor(
      { STYX_E2E: '1', STYX_E2E_PICK: '/tmp/picked' },
      { folder: '/os/folder', file: '/os/file' },
    );
    expect(await bus.dispatch(sender, 'dialog.pickFolder', {})).toEqual({
      ok: true,
      value: { path: '/tmp/picked' },
    });
    expect(await bus.dispatch(sender, 'dialog.pickFile', { title: 'Key' })).toEqual({
      ok: true,
      value: { path: '/tmp/picked' },
    });
    const dismissed = busFor({ STYX_E2E: '1' }, { folder: '/os/folder' });
    expect(await dismissed.bus.dispatch(sender, 'dialog.pickFolder', {})).toEqual({
      ok: true,
      value: { path: null },
    });
  });

  it('outside e2e the DialogsPort answers; a cancelled picker yields null', async () => {
    const { bus, sender } = busFor(
      {},
      { folder: '/Users/me/AmrodOrders', file: '/Users/me/.ssh/id_ed25519' },
    );
    expect(await bus.dispatch(sender, 'dialog.pickFolder', { defaultPath: '~/code' })).toEqual({
      ok: true,
      value: { path: '/Users/me/AmrodOrders' },
    });
    expect(
      await bus.dispatch(sender, 'dialog.pickFile', {
        filters: [{ name: 'Keys', extensions: ['pem', '*'] }],
      }),
    ).toEqual({ ok: true, value: { path: '/Users/me/.ssh/id_ed25519' } });
    const cancelled = busFor({});
    expect(await cancelled.bus.dispatch(sender, 'dialog.pickFile', {})).toEqual({
      ok: true,
      value: { path: null },
    });
    // Invalid input is rejected before any picker opens.
    const bad = await bus.dispatch(sender, 'dialog.pickFolder', { title: '' } as never);
    expect(bad.ok).toBe(false);
  });
});
