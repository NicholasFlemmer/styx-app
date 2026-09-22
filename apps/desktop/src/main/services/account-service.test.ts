import { SIGNED_OUT, copy, type Account, type AccountState } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryVault } from './credential-vault';
import { AccountService } from './account-service';

/**
 * The account service against a fake API (ADR-0026). Nothing here touches the network: every response is
 * scripted, so the tests cover the cases that matter and none of them depends on a server existing.
 */

const API = 'https://api.test';

const ACCOUNT: Account = {
  id: 'acct_1',
  email: 'nic@acme.dev',
  name: 'Nic Flemmer',
  avatarUrl: null,
  provider: 'github',
  plan: 'pro',
  planUntil: null,
};

interface Reply {
  status?: number;
  body?: unknown;
  /** Thrown instead of answering, for the offline cases. */
  throws?: string;
}

/** A scripted API: one queue of replies per path, plus a log of what was asked. */
class FakeApi {
  readonly calls: { path: string; body: unknown; auth: string | null }[] = [];
  private readonly queues = new Map<string, Reply[]>();

  /** Scripts a path, replacing anything scripted before; the last reply repeats for further calls. */
  on(path: string, ...replies: Reply[]): this {
    this.queues.set(path, replies);
    return this;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(API.length);
    const headers = new Headers(init?.headers ?? {});
    this.calls.push({
      path,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      auth: headers.get('Authorization'),
    });
    const queue = this.queues.get(path) ?? [];
    // The last reply for a path repeats, so a poll loop can be scripted with one "pending" entry.
    const reply = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] ?? { status: 404, body: {} });
    if (reply.throws !== undefined) throw new Error(reply.throws);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

const grant = (over: Partial<Account> = {}) => ({
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresIn: 3600,
  account: { ...ACCOUNT, ...over },
});

const setup = () => {
  const api = new FakeApi();
  const vault = new MemoryVault();
  const store = new Map<string, unknown>();
  const published: AccountState[] = [];
  const opened: string[] = [];
  let now = 1_000_000;
  const service = new AccountService({
    fetch: api.fetch,
    vault,
    store: {
      get: <T>(k: string) => store.get(k) as T | undefined,
      set: (k, v) => void store.set(k, v),
      delete: (k) => void store.delete(k),
    },
    publish: (s) => void published.push(s),
    openExternal: (u) => void opened.push(u),
    now: () => now,
    apiBase: API,
    version: '0.1.0',
  });
  return {
    api,
    vault,
    store,
    published,
    opened,
    service,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
};

/** Lets the polling loop run: each tick is a timer plus the awaits around the fetch. */
const tick = async (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(6_000);
  }
};

const deviceCode = {
  deviceCode: 'dc-1',
  userCode: 'WXYZ-1234',
  verificationUri: `${API}/activate`,
  interval: 5,
  expiresIn: 900,
};

describe('AccountService (ADR-0026)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts signed out and stays that way when nothing is stored', () => {
    const t = setup();
    t.service.load();
    expect(t.service.current()).toEqual(SIGNED_OUT);
    expect(t.api.calls).toEqual([]); // start-up never calls the API
  });

  it('signs in through the device flow: code on screen, browser opened, tokens in the keychain only', async () => {
    const t = setup();
    t.api.on('/v1/device/code', { body: deviceCode });
    t.api.on(
      '/v1/device/token',
      { status: 400, body: { error: 'authorization_pending' } },
      { body: grant() },
    );

    await t.service.signIn('github');
    // The code is published before anything is polled, so the person sees it immediately.
    expect(t.service.current()).toMatchObject({
      kind: 'signing-in',
      provider: 'github',
      userCode: 'WXYZ-1234',
      expiresAt: t.at() + 900_000,
    });
    expect(t.opened).toEqual([`${API}/activate`]);
    expect(t.api.calls[0]).toMatchObject({
      path: '/v1/device/code',
      body: { provider: 'github', client: 'styx-desktop', version: '0.1.0' },
    });

    await tick(2);
    expect(t.service.current()).toMatchObject({ kind: 'signed-in', account: ACCOUNT });

    // Tokens: keychain only. The persisted row and every published state are token-free.
    expect(await t.vault.get('styx:v1:styx:account:oauth')).toBe('at-1');
    expect(await t.vault.get('styx:v1:styx:account:refresh')).toBe('rt-1');
    expect(JSON.stringify([...t.store.entries()])).not.toContain('at-1');
    expect(JSON.stringify(t.published)).not.toContain('at-1');
    expect(JSON.stringify(t.published)).not.toContain('rt-1');
    expect(t.store.get('account')).toEqual({
      account: ACCOUNT,
      signedInAt: t.at(),
      accessExpiresAt: t.at() + 3_600_000,
    });
  });

  it.each([
    ['access_denied', copy.account.denied],
    ['expired_token', copy.account.expired],
    ['something_odd', copy.account.failed],
  ])('a flow the API ends with %s returns to signed out, saying so', async (error, message) => {
    const t = setup();
    t.api.on('/v1/device/code', { body: deviceCode });
    t.api.on('/v1/device/token', { status: 400, body: { error } });
    await t.service.signIn('google');
    await tick();
    expect(t.service.current()).toEqual({ kind: 'signed-out', error: message });
  });

  it('keeps polling through a blip, and backs off when told to slow down', async () => {
    const t = setup();
    t.api.on('/v1/device/code', { body: deviceCode });
    t.api.on(
      '/v1/device/token',
      { throws: 'network down' },
      { status: 400, body: { error: 'slow_down' } },
      { body: grant() },
    );
    await t.service.signIn('github');
    // Three polls: the blip, the slow_down (which pushes the interval out by 5s), then the grant.
    await tick(5);
    // The blip did not end the flow; the code stayed good and the sign-in completed.
    expect(t.service.current()).toMatchObject({ kind: 'signed-in' });
  });

  it('a code that is never used expires the flow', async () => {
    const t = setup();
    t.api.on('/v1/device/code', { body: { ...deviceCode, expiresIn: 10 } });
    t.api.on('/v1/device/token', { status: 400, body: { error: 'authorization_pending' } });
    await t.service.signIn('github');
    t.advance(11_000);
    await tick(2);
    expect(t.service.current()).toEqual({ kind: 'signed-out', error: copy.account.expired });
  });

  it('cancel drops the flow and stops the polling', async () => {
    const t = setup();
    t.api.on('/v1/device/code', { body: deviceCode });
    t.api.on('/v1/device/token', { status: 400, body: { error: 'authorization_pending' } });
    await t.service.signIn('github');
    t.service.cancelSignIn();
    expect(t.service.current()).toEqual(SIGNED_OUT);
    const after = t.api.calls.length;
    await tick(3);
    expect(t.api.calls.length).toBe(after);
  });

  it('refuses a second flow while one is running, and re-opens the page on request', async () => {
    const t = setup();
    t.api.on('/v1/device/code', { body: deviceCode });
    t.api.on('/v1/device/token', { status: 400, body: { error: 'authorization_pending' } });
    await t.service.signIn('github');
    await expect(t.service.signIn('google')).rejects.toMatchObject({ code: 'invalid-transition' });
    t.service.openVerification();
    expect(t.opened).toEqual([`${API}/activate`, `${API}/activate`]);
  });

  it('loads a stored account at start-up without touching the API, and drops a row that does not parse', () => {
    const t = setup();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5 });
    t.service.load();
    expect(t.service.current()).toEqual({
      kind: 'signed-in',
      account: ACCOUNT,
      signedInAt: 5,
      staleSince: null,
    });
    expect(t.api.calls).toEqual([]);

    const u = setup();
    u.store.set('account', { account: { email: 'x' }, signedInAt: 5 });
    u.service.load();
    expect(u.service.current()).toEqual(SIGNED_OUT);
    expect(u.store.has('account')).toBe(false);
  });

  it('an unreachable API leaves the session standing and marks it stale once, not every try', async () => {
    const t = setup();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5, accessExpiresAt: t.at() + 3_600_000 });
    t.service.load();
    await t.vault.set('styx:v1:styx:account:oauth', 'at-1');
    t.api.on('/v1/me', { throws: 'offline' });
    await t.service.refresh();
    const stale = t.at();
    expect(t.service.current()).toMatchObject({ kind: 'signed-in', staleSince: stale });
    // A second failure keeps the first timestamp: "offline since" is when it started, not when it last tried.
    t.advance(60_000);
    await t.service.refresh();
    expect(t.service.current()).toMatchObject({ kind: 'signed-in', staleSince: stale });
  });

  it('a refresh with nothing in the keychain marks stale rather than doing nothing quietly', async () => {
    const t = setup();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5, accessExpiresAt: 0 });
    t.service.load();
    // No tokens at all: the entry was removed, or this is a restored machine.
    await t.service.refresh();
    expect(t.service.current()).toMatchObject({ kind: 'signed-in', staleSince: t.at() });
    // Not a sign-out: the person is still signed in and can try again or sign out themselves.
    expect(t.store.has('account')).toBe(true);
  });

  it('a good refresh clears stale and takes the new plan', async () => {
    const t = setup();
    // The stored expiry has passed, so the token is refreshed before `/v1/me` is asked.
    t.store.set('account', { account: ACCOUNT, signedInAt: 5, accessExpiresAt: 0 });
    t.service.load();
    await t.vault.set('styx:v1:styx:account:oauth', 'at-old');
    await t.vault.set('styx:v1:styx:account:refresh', 'rt-1');
    t.api.on('/v1/token/refresh', { body: grant() });
    t.api.on('/v1/me', { body: { account: { ...ACCOUNT, plan: 'team' } } });
    await t.service.refresh();
    expect(t.service.current()).toMatchObject({
      kind: 'signed-in',
      account: { plan: 'team' },
      staleSince: null,
      signedInAt: 5,
    });
    expect(t.api.calls.at(-1)).toMatchObject({ path: '/v1/me', auth: 'Bearer at-1' });
  });

  it('a 401 is the one answer that signs a person out, and it clears the keychain', async () => {
    const t = setup();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5, accessExpiresAt: t.at() + 3_600_000 });
    t.service.load();
    await t.vault.set('styx:v1:styx:account:oauth', 'at-1');
    await t.vault.set('styx:v1:styx:account:refresh', 'rt-1');
    t.api.on('/v1/me', { status: 401, body: {} });
    await t.service.refresh();
    expect(t.service.current()).toEqual(SIGNED_OUT);
    expect(await t.vault.get('styx:v1:styx:account:oauth')).toBeNull();
    expect(await t.vault.get('styx:v1:styx:account:refresh')).toBeNull();
    expect(t.store.has('account')).toBe(false);
  });

  it('a 500 on refresh does not sign anyone out', async () => {
    const t = setup();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5, accessExpiresAt: t.at() + 3_600_000 });
    t.service.load();
    await t.vault.set('styx:v1:styx:account:oauth', 'at-1');
    await t.vault.set('styx:v1:styx:account:refresh', 'rt-1');
    t.api.on('/v1/me', { status: 500, body: {} });
    await t.service.refresh();
    expect(t.service.current()).toMatchObject({ kind: 'signed-in', staleSince: t.at() });
  });

  it('refreshes an expired access token before using it, and a rejected refresh signs out', async () => {
    const t = setup();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5 });
    t.service.load();
    await t.vault.set('styx:v1:styx:account:refresh', 'rt-1');
    t.api.on(
      '/v1/token/refresh',
      { body: { ...grant(), accessToken: 'at-2' } },
      { status: 401, body: {} },
    );
    expect(await t.service.accessToken()).toBe('at-2');
    expect(t.api.calls.at(-1)).toMatchObject({ path: '/v1/token/refresh', body: { refreshToken: 'rt-1' } });
    // Inside its lifetime the cached token is reused: no second call.
    const calls = t.api.calls.length;
    expect(await t.service.accessToken()).toBe('at-2');
    expect(t.api.calls.length).toBe(calls);

    t.advance(3_600_000);
    expect(await t.service.accessToken()).toBeNull();
    expect(t.service.current()).toEqual(SIGNED_OUT);
  });

  it('signs out locally even when the API cannot be told', async () => {
    const t = setup();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5, accessExpiresAt: t.at() + 3_600_000 });
    t.service.load();
    await t.vault.set('styx:v1:styx:account:oauth', 'at-1');
    t.api.on('/v1/signout', { throws: 'offline' });
    await t.service.signOut();
    expect(t.service.current()).toEqual(SIGNED_OUT);
    expect(await t.vault.get('styx:v1:styx:account:oauth')).toBeNull();
    expect(t.store.has('account')).toBe(false);
  });

  it('supplies a git author only while signed in, preferring the name and falling back to the email', () => {
    const t = setup();
    expect(t.service.gitIdentity()).toBeNull();
    t.store.set('account', { account: ACCOUNT, signedInAt: 5 });
    t.service.load();
    expect(t.service.gitIdentity()).toEqual({ name: 'Nic Flemmer', email: 'nic@acme.dev' });

    const u = setup();
    u.store.set('account', { account: { ...ACCOUNT, name: '  ' }, signedInAt: 5 });
    u.service.load();
    expect(u.service.gitIdentity()).toEqual({ name: 'nic@acme.dev', email: 'nic@acme.dev' });
  });

  it('an API that cannot be reached at all leaves sign-in signed out with a plain message', async () => {
    const t = setup();
    t.api.on('/v1/device/code', { throws: 'getaddrinfo ENOTFOUND' });
    await t.service.signIn('github');
    expect(t.service.current()).toEqual({ kind: 'signed-out', error: copy.account.failed });
    expect(t.opened).toEqual([]);
  });
});
