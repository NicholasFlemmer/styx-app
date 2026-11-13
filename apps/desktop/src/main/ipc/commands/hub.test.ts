import { copy, fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test-support';

/** The team hub's commands (ADR-0032) through the bus: contract-valid results and the hub.set delta. */
describe('hub commands', () => {
  it('the snapshot carries the hub, signed out and with nothing linked', async () => {
    const { app, sender } = makeTestApp();
    const r = await app.bus.dispatch(sender, 'store.snapshot', {});
    if (!r.ok) throw new Error('snapshot failed');
    expect(r.value.hub).toMatchObject({ connection: { kind: 'signed-out' }, links: [], shares: [] });
  });

  it('linking a project or sharing a lane while signed out is refused, in words', async () => {
    const { app, sender } = makeTestApp();
    const link = await app.bus.dispatch(sender, 'hub.linkProject', {
      projectId: fixtures.ids.project.acmeShop,
      spaceId: 'spc_x',
    });
    expect(link).toMatchObject({
      ok: false,
      error: { code: 'invalid-transition', message: copy.hub.errors.signedOut },
    });
    const share = await app.bus.dispatch(sender, 'hub.shareLane', {
      sessionId: fixtures.ids.session.claude,
      shared: true,
    });
    expect(share).toMatchObject({ ok: false, error: { code: 'invalid-transition' } });
  });

  it('a hub that cannot be reached leaves the person signed out with the reason, published as hub.set', async () => {
    const fetch = (async () => {
      throw new Error('offline');
    }) as typeof globalThis.fetch;
    const { app, sender, win } = makeTestApp({ fetch });
    expect(await app.bus.dispatch(sender, 'hub.signIn', {})).toEqual({ ok: true, value: {} });
    app.publisher.flush();
    const last = win
      .batches()
      .flatMap((b) => b.deltas)
      .filter((d) => d.op === 'hub.set')
      .at(-1);
    expect(last).toMatchObject({ hub: { connection: { kind: 'signed-out', error: copy.hub.failed } } });
  });

  it('cancel, open-verification, refresh, sign-out and open-web are safe when there is nothing to do', async () => {
    const { app, sender } = makeTestApp();
    for (const name of [
      'hub.cancelSignIn',
      'hub.openVerification',
      'hub.refresh',
      'hub.signOut',
      'hub.openWeb',
    ] as const)
      expect(await app.bus.dispatch(sender, name, {})).toEqual({ ok: true, value: {} });
  });
});
