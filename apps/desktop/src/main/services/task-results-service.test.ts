import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerClient, ErrorCode } from '@styx/broker';
import { fixtures, type ConnectedApp } from '@styx/core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { sha256 } from './session-service';

const { ids } = fixtures;

const campaign = {
  kind: 'campaign',
  title: 'Black Friday',
  lookedAt: ['Read sales'],
  ads: [
    { product: 'Hoodie', headline: 'Still thinking?', body: 'Thirty off.', picked: true },
    { product: 'Cap', headline: 'Back', body: `Use ghp_${'a'.repeat(36)}`, picked: false },
  ],
  launch: { platform: 'meta', perDay: 500, days: 7, currency: 'ZAR', audience: 'Viewers' },
};

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.broker.close();
  t = null;
});

async function agent(): Promise<{ t: TestApp; client: BrokerClient }> {
  t = makeTestApp();
  // Approving a plan tells the agent, which starts it: never in the fixture's literal ~/code path (CLAUDE.md).
  const wt = t.app.repos.worktrees.get(ids.worktree.acmeMain);
  if (wt === null) throw new Error('fixture');
  t.app.repos.worktrees.upsert({ ...wt, path: mkdtempSync(join(tmpdir(), 'styx-results-')) });
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
  return { t, client };
}

describe('show_result and launch plans (ADR-0033)', () => {
  it('keeps a result redacted, and tells the agent what does not fit', async () => {
    const { t: test, client } = await agent();
    await expect(client.call('show_result', { result: campaign })).resolves.toMatchObject({ shown: true });
    const kept = test.app.repos.taskResults.get(ids.session.gemini);
    expect(kept?.body).toMatchObject({ kind: 'campaign', title: 'Black Friday' });
    expect(JSON.stringify(kept)).not.toContain('ghp_');
    expect(test.app.publisher.snapshot().taskResults).toHaveLength(1);
    await expect(
      client.call('show_result', { result: { kind: 'campaign', title: 'x', ads: [] } }),
    ).rejects.toMatchObject({
      code: ErrorCode.invalidParams,
      message: expect.stringContaining('ads'),
    });
    client.close();
  });

  it('a plan lets through only what it covers, once, in its own account and currency', async () => {
    const { t: test, client } = await agent();
    await client.call('show_result', {
      result: { ...campaign, launch: { ...campaign.launch, countries: ['ZA'] } },
    });
    const results = test.app.taskResults;
    const sid = ids.session.gemini;
    const meta: ConnectedApp = {
      id: 'm',
      kind: 'meta-ads',
      account: 'act_1',
      currency: 'ZAR',
      name: 'Meta',
      url: 'https://graph.facebook.com',
      status: 'connected',
      error: null,
      tools: [],
      projects: [],
      addedAt: 0,
      checkedAt: null,
    };
    const tool = (name: string) => ({ name, title: null, description: '', readOnly: false });
    const reserve = (name: string, args: Record<string, unknown>, app = meta) =>
      results.planReserve(sid, app, tool(name), args);
    expect(reserve('create_campaign', { spend_cap: 3500 })).toBeNull();
    const seenAt = test.app.repos.taskResults.get(sid)?.updatedAt ?? 0;
    // A stale view of the plan is refused.
    const stale = await test.app.bus.dispatch(test.sender, 'taskResults.approveLaunch', {
      sessionId: sid,
      seenAt: seenAt - 1,
      ads: [{ index: 0, headline: 'Still thinking?', body: 'Thirty off.' }],
      perDay: 500,
      days: 7,
      countries: ['ZA'],
    });
    expect(stale.ok).toBe(false);
    const r = await test.app.bus.dispatch(test.sender, 'taskResults.approveLaunch', {
      sessionId: sid,
      seenAt,
      ads: [{ index: 0, headline: 'Still thinking?', body: 'Thirty off.' }],
      perDay: 500,
      days: 7,
      countries: ['ZA'],
    });
    expect(r).toEqual({ ok: true, value: {} });
    expect(test.app.repos.taskResults.get(sid)).toMatchObject({
      launchPicked: [0],
      approved: { ads: [{ headline: 'Still thinking?' }], plan: { perDay: 500, days: 7, countries: ['ZA'] } },
    });
    expect(
      test.app.repos.audit.recent(5).some((a) => a.action === 'granted' && a.triggeredBy === 'launch plan'),
    ).toBe(true);

    // Another currency or another kind of app is never covered.
    expect(reserve('create_campaign', { spend_cap: 100 }, { ...meta, currency: 'USD' })).toBeNull();
    expect(reserve('create_campaign', { spend_cap: 100 }, { ...meta, kind: 'mcp' })).toBeNull();
    // One campaign, capped at the plan's total.
    expect(reserve('create_campaign', { spend_cap: 3501 })).toBeNull();
    const camp = reserve('create_campaign', { spend_cap: 3500 });
    expect(camp).not.toBeNull();
    expect(reserve('create_campaign', { spend_cap: 1 })).toBeNull();
    if (camp === null) throw new Error('reserve');
    results.planSettle(sid, camp, true, '{"id":"120000000000001"}');
    // Bound to the account of its first step.
    expect(reserve('activate', { id: '120000000000001' }, { ...meta, id: 'other' })).toBeNull();

    // The test clock is the fixture's, not today's.
    const end = new Date(fixtures.DEMO_NOW + 86_400_000).toISOString();
    const adset = (b: number, extra: Record<string, unknown> = {}) => ({
      campaign_id: '120000000000001',
      daily_budget: b,
      countries: ['ZA'],
      end_time: end,
      ...extra,
    });
    // Ad sets: inside the countries, ending in time, and calls made together share the daily amount.
    expect(reserve('create_ad_set', adset(100, { countries: ['US'] }))).toBeNull();
    expect(reserve('create_ad_set', adset(100, { end_time: undefined }))).toBeNull();
    const a1 = reserve('create_ad_set', adset(300));
    const a2 = reserve('create_ad_set', adset(300));
    expect(a1).not.toBeNull();
    expect(a2).toBeNull();
    if (a1 === null) throw new Error('reserve');
    results.planSettle(sid, a1, true, '{"id":"120000000000002"}');
    // A refused step gives its share back.
    const a3 = reserve('create_ad_set', adset(200));
    if (a3 === null) throw new Error('reserve');
    results.planSettle(sid, a3, false, '');
    expect(reserve('create_ad_set', adset(200))).not.toBeNull();

    // Ads: only the picked one, word for word.
    expect(reserve('create_ad', { adset_id: '120000000000002', headline: 'Back', message: 'x' })).toBeNull();
    expect(
      reserve('create_ad', {
        adset_id: '120000000000002',
        headline: 'Still thinking?',
        message: 'Thirty off.',
      }),
    ).not.toBeNull();
    expect(reserve('activate', { id: '120000000000002' })).not.toBeNull();
    expect(reserve('activate', { id: '999999999999' })).toBeNull();
    expect(reserve('set_daily_budget', { id: '120000000000002', amount: 600 })).toBeNull();

    // A new result withdraws the approval.
    await client.call('show_result', { result: campaign });
    expect(reserve('activate', { id: '120000000000002' })).toBeNull();
    client.close();
  });

  it('a report has no plan to approve', async () => {
    const { t: test, client } = await agent();
    await client.call('show_result', {
      result: { kind: 'report', title: 'Weekly', headline: 'A good week.', sources: ['Analytics'] },
    });
    const r = await test.app.bus.dispatch(test.sender, 'taskResults.approveLaunch', {
      sessionId: ids.session.gemini,
      seenAt: test.app.repos.taskResults.get(ids.session.gemini)?.updatedAt ?? 0,
      ads: [{ index: 0, headline: 'Still thinking?', body: 'Thirty off.' }],
      perDay: 500,
      days: 7,
      countries: ['ZA'],
    });
    expect(r.ok).toBe(false);
    client.close();
  });

  it('approves the person’s edits and numbers, only after OS authentication', async () => {
    const { t: test, client } = await agent();
    await client.call('show_result', { result: campaign });
    const sid = ids.session.gemini;
    const seenAt = test.app.repos.taskResults.get(sid)?.updatedAt ?? 0;
    const approve = () =>
      test.app.bus.dispatch(test.sender, 'taskResults.approveLaunch', {
        sessionId: sid,
        seenAt,
        ads: [{ index: 0, headline: 'Our hoodie', body: 'Edited by the person.' }],
        perDay: 300,
        days: 3,
        countries: null,
      });
    expect(await approve()).toEqual({ ok: true, value: {} });
    const kept = test.app.repos.taskResults.get(sid);
    expect(kept?.approved?.ads[0]).toMatchObject({ headline: 'Our hoodie', body: 'Edited by the person.' });
    expect(kept?.approved?.plan).toMatchObject({ perDay: 300, days: 3 });
    // The plan's money follows what was approved, not what the agent proposed.
    const meta: ConnectedApp = {
      id: 'm',
      kind: 'meta-ads',
      account: 'act_1',
      currency: 'ZAR',
      name: 'Meta',
      url: 'https://graph.facebook.com',
      status: 'connected',
      error: null,
      tools: [],
      projects: [],
      addedAt: 0,
      checkedAt: null,
    };
    const tool = (name: string) => ({ name, title: null, description: '', readOnly: false });
    expect(
      test.app.taskResults.planReserve(sid, meta, tool('create_campaign'), { spend_cap: 901 }),
    ).toBeNull();
    expect(
      test.app.taskResults.planReserve(sid, meta, tool('create_campaign'), { spend_cap: 900 }),
    ).not.toBeNull();
    // Nothing runs yet, so there is nothing to pause or read.
    expect((await test.app.bus.dispatch(test.sender, 'taskResults.pauseAll', { sessionId: sid })).ok).toBe(
      false,
    );
    expect(await test.app.bus.dispatch(test.sender, 'taskResults.live', { sessionId: sid })).toEqual({
      ok: true,
      value: { live: null },
    });
    client.close();
  });

  it('refuses to launch when OS authentication is cancelled', async () => {
    t = makeTestApp({ mfa: 'cancelled' });
    const wt = t.app.repos.worktrees.get(ids.worktree.acmeMain);
    if (wt === null) throw new Error('fixture');
    t.app.repos.worktrees.upsert({ ...wt, path: mkdtempSync(join(tmpdir(), 'styx-results-')) });
    const kept = t.app.taskResults.show(ids.session.gemini, ids.project.acmeShop, campaign);
    const r = await t.app.bus.dispatch(t.sender, 'taskResults.approveLaunch', {
      sessionId: ids.session.gemini,
      seenAt: kept.updatedAt,
      ads: [{ index: 0, headline: 'x', body: 'y' }],
      perDay: 500,
      days: 7,
      countries: null,
    });
    expect(r.ok).toBe(false);
    expect(t.app.repos.taskResults.get(ids.session.gemini)?.launchApprovedAt).toBeNull();
  });

  it('fetches an ad picture only from a public https address, and only an image', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    t = makeTestApp({
      fetch: (async (u: string | URL | Request) =>
        String(u).includes('photo.png')
          ? new Response(png, { headers: { 'content-type': 'image/png' } })
          : new Response('<html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch,
    });
    const show = (image: string) =>
      t?.app.taskResults.show(ids.session.gemini, ids.project.acmeShop, {
        ...campaign,
        ads: [{ ...campaign.ads[0], image }],
      });
    show('https://cdn.example.com/photo.png');
    expect(await t.app.taskResults.adImage(ids.session.gemini, 0)).toMatch(/^data:image\/png;base64,/);
    show('https://cdn.example.com/page.html');
    expect(await t.app.taskResults.adImage(ids.session.gemini, 0)).toBeNull();
    show('https://169.254.169.254/photo.png');
    expect(await t.app.taskResults.adImage(ids.session.gemini, 0)).toBeNull();
  });

  it('binds the approved picture and link, stops in Styx before Meta answers, and runs one campaign at a time', async () => {
    const { t: test, client } = await agent();
    const sid = ids.session.gemini;
    await client.call('show_result', {
      result: {
        ...campaign,
        ads: [
          { ...campaign.ads[0], image: 'https://cdn.example.com/a.png', link: 'https://shop.example.com/a' },
        ],
      },
    });
    const seenAt = test.app.repos.taskResults.get(sid)?.updatedAt ?? 0;
    await test.app.bus.dispatch(test.sender, 'taskResults.approveLaunch', {
      sessionId: sid,
      seenAt,
      ads: [{ index: 0, headline: 'Still thinking?', body: 'Thirty off.' }],
      perDay: 500,
      days: 7,
      countries: null,
    });
    const meta: ConnectedApp = {
      id: 'm',
      kind: 'meta-ads',
      account: 'act_1',
      currency: 'ZAR',
      name: 'Meta',
      url: 'https://graph.facebook.com',
      status: 'connected',
      error: null,
      tools: [],
      projects: [],
      addedAt: 0,
      checkedAt: null,
    };
    const tool = (name: string) => ({ name, title: null, description: '', readOnly: false });
    const res = test.app.taskResults;
    const camp = res.planReserve(sid, meta, tool('create_campaign'), { spend_cap: 3500 });
    if (camp === null) throw new Error('reserve');
    res.planSettle(sid, camp, true, '{"id":"120000000000001"}');
    const adset = res.planReserve(sid, meta, tool('create_ad_set'), {
      campaign_id: '120000000000001',
      daily_budget: 100,
      end_time: new Date(fixtures.DEMO_NOW + 86_400_000).toISOString(),
    });
    if (adset === null) throw new Error('reserve');
    res.planSettle(sid, adset, true, '{"id":"120000000000002"}');
    const ad = (link: string, image: string) => ({
      adset_id: '120000000000002',
      headline: 'Still thinking?',
      message: 'Thirty off.',
      link,
      image_url: image,
    });
    expect(
      res.planReserve(
        sid,
        meta,
        tool('create_ad'),
        ad('https://attacker.example', 'https://cdn.example.com/a.png'),
      ),
    ).toBeNull();
    expect(
      res.planReserve(
        sid,
        meta,
        tool('create_ad'),
        ad('https://shop.example.com/a', 'https://evil.example/x.png'),
      ),
    ).toBeNull();
    expect(
      res.planReserve(
        sid,
        meta,
        tool('create_ad'),
        ad('https://shop.example.com/a', 'https://cdn.example.com/a.png'),
      ),
    ).not.toBeNull();
    // A second plan cannot be approved while this campaign runs.
    await client.call('show_result', { result: campaign });
    const again = await test.app.bus.dispatch(test.sender, 'taskResults.approveLaunch', {
      sessionId: sid,
      seenAt: test.app.repos.taskResults.get(sid)?.updatedAt ?? 0,
      ads: [{ index: 0, headline: 'x', body: 'y' }],
      perDay: 100,
      days: 1,
      countries: null,
    });
    expect(again.ok).toBe(false);
    // Pause everything stops it in Styx even when Meta cannot be reached (no Meta app here).
    const paused = await test.app.bus.dispatch(test.sender, 'taskResults.pauseAll', { sessionId: sid });
    expect(paused.ok).toBe(false);
    expect(test.app.repos.taskResults.get(sid)?.pausedAt).not.toBeNull();
    client.close();
  });
});
