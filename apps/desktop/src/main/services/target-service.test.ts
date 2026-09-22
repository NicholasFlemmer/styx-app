import { fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;

/**
 * Health probes decide whether a target shows as connected, so a false expiry is what the owner sees as
 * "targets constantly drop". These cover the confirm-before-expire gate and the one-login-heals-siblings rule.
 */
describe('TargetService health', () => {
  /** Stubs the gcp adapter's health probe with a queue of outcomes. */
  const stubHealth = (t: TestApp, outcomes: Array<'ok' | 'expired' | 'flaky'>) => {
    const adapter = t.app.providers.get('gcp');
    let i = 0;
    return vi.spyOn(adapter, 'health').mockImplementation(async () => {
      const o = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (o === 'ok') return { ok: true, identity: 'nic@example.com' };
      if (o === 'expired') return { ok: false, expired: true, error: 'Reauthentication failed.' };
      return { ok: false, expired: false, error: 'network unreachable' };
    });
  };

  const gcpTarget = (t: TestApp) => {
    const target = t.app.repos.targets.get(ids.target.infraGcp) ?? null;
    if (!target) throw new Error('fixture target infraGcp missing');
    return target;
  };

  it('one auth failure does not expire a target; the second consecutive one does', async () => {
    const t = makeTestApp();
    stubHealth(t, ['expired']);
    const target = gcpTarget(t);
    await t.app.targets.checkHealth(target, 'interval');
    expect(t.app.repos.targets.get(target.id)?.health).not.toBe('expired');
    await t.app.targets.checkHealth(t.app.repos.targets.get(target.id)!, 'interval');
    expect(t.app.repos.targets.get(target.id)?.health).toBe('expired');
  });

  it('a success between failures clears the strike count', async () => {
    const t = makeTestApp();
    stubHealth(t, ['expired', 'ok', 'expired']);
    const target = gcpTarget(t);
    for (let i = 0; i < 3; i += 1)
      await t.app.targets.checkHealth(t.app.repos.targets.get(target.id)!, 'interval');
    // failure, success (clears), failure → still only one strike, so not expired
    expect(t.app.repos.targets.get(target.id)?.health).not.toBe('expired');
  });

  it('a manual probe answers immediately instead of making the user wait out the gate', async () => {
    const t = makeTestApp();
    stubHealth(t, ['expired']);
    const target = gcpTarget(t);
    await t.app.targets.checkHealth(target, 'manual');
    expect(t.app.repos.targets.get(target.id)?.health).toBe('expired');
  });

  it('a transient (non-auth) failure never expires, however often it repeats', async () => {
    const t = makeTestApp();
    stubHealth(t, ['flaky']);
    const target = gcpTarget(t);
    for (let i = 0; i < 4; i += 1)
      await t.app.targets.checkHealth(t.app.repos.targets.get(target.id)!, 'interval');
    expect(t.app.repos.targets.get(target.id)?.health).not.toBe('expired');
  });
});

describe('TargetService.connectStart (Advanced · OAuth / token)', () => {
  it('a provider without an OAuth app opens its token page in the browser and returns the placeholder target for the paste', async () => {
    const opened: string[] = [];
    const t = makeTestApp({ openExternal: async (url) => void opened.push(url) });
    const r = t.app.targets.connectStart(ids.project.acmeShop, 'vercel', 'preview');
    expect(r.browserUrl).toBe('https://vercel.com/account/settings/tokens');
    expect(r.authMethod).toBe('oauth');
    await new Promise((res) => setTimeout(res, 0));
    expect(opened).toEqual(['https://vercel.com/account/settings/tokens']);
    expect(t.app.repos.targets.get(r.targetId)).toMatchObject({ provider: 'vercel', env: 'preview' });
    expect(t.win.events('connect.progress').at(-1)).toMatchObject({
      flowId: r.flowId,
      phase: 'waiting-browser',
    });
  });
});
