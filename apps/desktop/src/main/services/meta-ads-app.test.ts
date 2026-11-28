import { randomBytes } from 'node:crypto';
import { BrokerClient, ErrorCode } from '@styx/broker';
import { copy, fixtures } from '@styx/core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { appSecretRef } from './connected-apps-service';
import { MetaAdsConnection, metaAccountId, metaMinorUnits } from './meta-ads-app';
import { sha256 } from './session-service';

const { ids } = fixtures;
const TOKEN = `EAAB${'x'.repeat(40)}`;
const ACCOUNT = 'act_1057914153825374';

/** A fake Graph API: one ad account, one campaign in it, one object in another account. */
function graph() {
  const posts: { path: string; body: Record<string, string> }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v23.0/', '');
    const params = init?.body instanceof URLSearchParams ? init.body : url.searchParams;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (params.get('access_token') !== TOKEN)
      return json(400, { error: { message: 'Invalid OAuth access token.' } });
    if (init?.method === 'POST') {
      posts.push({ path, body: Object.fromEntries((params as URLSearchParams).entries()) });
      return json(200, { id: path.includes('campaigns') ? '999' : path, success: true });
    }
    if (path === ACCOUNT) return json(200, { name: 'Good Shou 2', currency: 'ZAR' });
    if (path === '120252806657100592') return json(200, { account_id: '1057914153825374' });
    if (path === '120000000000000222') return json(200, { account_id: '42424242' });
    if (path.endsWith('/campaigns'))
      return json(200, { data: [{ id: '120252806657100592', name: 'Reel', status: 'PAUSED' }] });
    return json(200, { data: [] });
  }) as typeof fetch;
  return { fetchFn, posts };
}

describe('MetaAdsConnection', () => {
  it.each([
    ['act_1057914153825374', 'act_1057914153825374'],
    ['1057914153825374', 'act_1057914153825374'],
    ['act_12', null],
    ['act_123abc456', null],
  ])('metaAccountId(%s) → %s', (raw, want) => expect(metaAccountId(raw)).toBe(want));

  it.each([
    [150.5, 'ZAR', 15050],
    [150, 'USD', 15000],
    [1500, 'JPY', 1500],
    [1500, 'KRW', 1500],
    [10, '', null],
    [10, 'zar', null],
  ])('metaMinorUnits(%s, %s) → %s', (amount, currency, want) =>
    expect(metaMinorUnits(amount, currency)).toBe(want),
  );

  it('makes every campaign paused, and refuses ids outside the account', async () => {
    const g = graph();
    const c = new MetaAdsConnection(TOKEN, ACCOUNT, g.fetchFn);
    await c.callTool('create_campaign', {
      name: 'Black Friday',
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
    });
    expect(g.posts[0]?.body).toMatchObject({
      name: 'Black Friday',
      objective: 'OUTCOME_SALES',
      status: 'PAUSED',
    });
    expect(await c.callTool('activate', { id: '120000000000000222' })).toEqual({
      text: 'That id is not in the connected ad account.',
      isError: true,
    });
    expect(await c.callTool('set_daily_budget', { id: '120252806657100592', amount: 150.5 })).toMatchObject({
      isError: false,
    });
    expect(g.posts.at(-1)).toEqual({
      path: '120252806657100592',
      body: { daily_budget: '15050', access_token: TOKEN },
    });
    expect(await c.callTool('set_daily_budget', { id: '120252806657100592', amount: -1 })).toMatchObject({
      isError: true,
    });
    expect(await c.callTool('create_campaign', { name: 'x', objective: 'MONEY' })).toMatchObject({
      isError: true,
    });
    expect(await c.callTool('drop', {})).toMatchObject({ isError: true });
  });
});

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.broker.close();
  t = null;
});

describe('Meta Ads as a connected app', () => {
  it('a bad token is refused before anything is kept', async () => {
    t = makeTestApp({ fetch: graph().fetchFn });
    const r = await t.app.bus.dispatch(t.sender, 'connectedApps.addMetaAds', {
      token: `EAAB${'y'.repeat(40)}`,
      adAccount: ACCOUNT,
      projectId: null,
    });
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining('Invalid OAuth') } });
    expect(t.app.connectedApps.current()).toEqual([]);
  });

  it('keeps the token in the keychain only; reads run, spending asks first', async () => {
    const g = graph();
    t = makeTestApp({ fetch: g.fetchFn });
    const r = await t.app.bus.dispatch(t.sender, 'connectedApps.addMetaAds', {
      token: TOKEN,
      adAccount: ACCOUNT,
      projectId: ids.project.acmeShop,
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(t.app.connectedApps.current()[0]).toMatchObject({
      kind: 'meta-ads',
      account: ACCOUNT,
      name: 'Meta Ads · Good Shou 2 (ZAR)',
      status: 'connected',
    });
    expect(await t.vault.get(appSecretRef(r.value.appId))).toContain(TOKEN);
    expect(JSON.stringify(t.app.publisher.snapshot())).not.toContain(TOKEN);
    expect(JSON.stringify(t.app.repos.settings.kv.get('connectedApps'))).not.toContain(TOKEN);

    const token = randomBytes(32).toString('hex');
    t.app.repos.sessions.setBrokerTokenHash(ids.session.gemini, sha256(token));
    await t.app.broker.listen();
    const client = new BrokerClient({
      endpoint: t.app.runtime.brokerEndpoint,
      sessionId: ids.session.gemini,
      token,
      client: 'shim',
    });
    await client.connect();
    const listed = await client.call('use_app', {
      app: r.value.appId,
      tool: 'list_campaigns',
      arguments: {},
    });
    expect(listed.text).toContain('Reel');
    expect(listed.text).not.toContain(TOKEN);

    const spending = client.call('use_app', {
      app: r.value.appId,
      tool: 'activate',
      arguments: { id: '120252806657100592' },
    });
    await new Promise((res) => setTimeout(res, 30));
    expect(g.posts).toEqual([]);
    const ask = t.app.repos.pendingAsks.openBySession(ids.session.gemini).find((a) => a.kind === 'decision');
    expect(ask?.payload).toMatchObject({ prompt: expect.stringContaining('Start it: starts spending') });
    await t.app.bus.dispatch(t.sender, 'ask.respond', {
      askId: ask?.id,
      resolution: { kind: 'decision', chosen: copy.one.apps.dontAllow },
    });
    await expect(spending).rejects.toMatchObject({ code: ErrorCode.notAllowed });
    expect(g.posts).toEqual([]);
    client.close();
  });
});
