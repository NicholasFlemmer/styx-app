import {
  SIGNED_OUT,
  accountSchema,
  copy,
  storedAccountSchema,
  type Account,
  type AccountProvider,
  type AccountState,
} from '@styx/core';
import { logger } from './logger';
import { fail } from '../ipc/bus';
import type { CredentialVault } from './credential-vault';

/**
 * The Styx account (ADR-0026): device authorisation flow against Styx's own API, which federates to GitHub and
 * Google. The app never sees a password or a provider secret, and never talks to GitHub or Google itself.
 *
 * Invariants this file exists to keep:
 * - tokens live only in the OS keychain (`styx:v1:styx:account:oauth` / `:refresh`), never in SQLite, a log, a
 *   delta or the renderer;
 * - the account is additive — nothing here can stop the rest of the app working, so every network failure ends
 *   in a state the app carries on from;
 * - only a 401 from the API signs a person out. Offline is a note on a live session, not an ending.
 */

/**
 * Where the desktop app talks to: the Styx accounts API on Cloud Run (ADR-0026). `STYX_API` overrides it for
 * development and tests, so nothing in CI leaves the machine.
 */
export const DEFAULT_API = 'https://styx-api-994871833762.us-central1.run.app';

const ACCESS_REF = 'styx:v1:styx:account:oauth';
const REFRESH_REF = 'styx:v1:styx:account:refresh';
/** The `ui_state` key the (non-secret) account row is persisted under. */
const STORE_KEY = 'account';

/** Access tokens are refreshed this long before they expire, so a request never races the clock. */
const REFRESH_SKEW_MS = 60_000;
/** A device code the API gives no interval for is polled this often. */
const DEFAULT_POLL_MS = 5_000;

export interface AccountServiceDeps {
  fetch: typeof globalThis.fetch;
  vault: CredentialVault;
  /** `ui_state`; holds the account row, never a token. */
  store: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
  publish: (state: AccountState) => void;
  openExternal: (url: string) => void;
  now: () => number;
  apiBase?: string;
  /** App version, sent so the API can refuse a build too old to trust. */
  version: string;
}

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  account: Account;
}

/** A device-flow poll that has not resolved yet; anything else is thrown. */
const PENDING = new Set(['authorization_pending', 'slow_down']);

export class AccountService {
  private state: AccountState = SIGNED_OUT;
  /** Cancels the flow in progress. */
  private abort: AbortController | null = null;
  /** Epoch ms the cached access token stops being usable. */
  private accessExpiresAt = 0;
  private verificationUri: string | null = null;

  constructor(private readonly deps: AccountServiceDeps) {}

  /** Reads the persisted account at start-up. No network: the app must open the same speed signed in or out. */
  load(): void {
    const raw = this.deps.store.get<unknown>(STORE_KEY);
    if (raw === undefined) return;
    const parsed = storedAccountSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('account: stored row did not parse; signing out');
      this.deps.store.delete(STORE_KEY);
      return;
    }
    // Trusted until the API says otherwise. `staleSince` stays null: nothing has failed yet.
    this.accessExpiresAt = parsed.data.accessExpiresAt;
    this.set({
      kind: 'signed-in',
      account: parsed.data.account,
      signedInAt: parsed.data.signedInAt,
      staleSince: null,
    });
  }

  current(): AccountState {
    return this.state;
  }

  private set(state: AccountState): void {
    this.state = state;
    this.deps.publish(state);
  }

  private url(path: string): string {
    return `${(this.deps.apiBase ?? DEFAULT_API).replace(/\/+$/, '')}${path}`;
  }

  private async post(path: string, body: unknown, token?: string): Promise<Response> {
    return this.deps.fetch(this.url(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
      ...(this.abort === null ? {} : { signal: this.abort.signal }),
    });
  }

  // --- sign in -------------------------------------------------------------

  /**
   * Device flow: ask for a code, show it, open the browser, poll. Runs to completion in the background — the
   * command returns as soon as the code is on screen, so the renderer is never blocked on a person.
   */
  async signIn(provider: AccountProvider): Promise<void> {
    if (this.state.kind === 'signing-in') fail('invalid-transition', 'a sign-in is already running');
    this.abort?.abort();
    this.abort = new AbortController();
    let start: DeviceStart;
    try {
      const r = await this.post('/v1/device/code', {
        provider,
        client: 'styx-desktop',
        version: this.deps.version,
      });
      if (!r.ok) throw new Error(`the Styx API answered ${r.status}`);
      start = (await r.json()) as DeviceStart;
    } catch (e) {
      logger.warn('account: device code failed', { error: (e as Error).message });
      this.set({ kind: 'signed-out', error: copy.account.failed });
      return;
    }
    const expiresAt = this.deps.now() + (start.expiresIn ?? 900) * 1000;
    this.verificationUri = start.verificationUri;
    this.set({
      kind: 'signing-in',
      provider,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      expiresAt,
    });
    this.deps.openExternal(start.verificationUri);
    void this.poll(start, expiresAt);
  }

  /** Read through a call so narrowing cannot fold it to the value it had when the controller was made. */
  private static aborted(controller: AbortController | null): boolean {
    return controller === null || controller.signal.aborted;
  }

  /** Polls until the person finishes in the browser, the code expires, or the flow is cancelled. */
  private async poll(start: DeviceStart, expiresAt: number): Promise<void> {
    const controller = this.abort;
    let interval = Math.max(1, start.interval ?? DEFAULT_POLL_MS / 1000) * 1000;
    while (this.deps.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, interval).unref?.());
      if (AccountService.aborted(controller) || this.state.kind !== 'signing-in') return;
      let body: { error?: string } & Partial<TokenGrant>;
      try {
        const r = await this.post('/v1/device/token', { deviceCode: start.deviceCode });
        body = (await r.json()) as typeof body;
      } catch (e) {
        if (AccountService.aborted(controller)) return;
        // A blip mid-flow is not a failure: the code is good until it expires, so keep polling.
        logger.debug('account: poll failed, retrying', { error: (e as Error).message });
        continue;
      }
      if (body.accessToken !== undefined && body.refreshToken !== undefined && body.account !== undefined) {
        await this.accept(body as TokenGrant);
        return;
      }
      if (body.error !== undefined && !PENDING.has(body.error)) {
        this.set({ kind: 'signed-out', error: this.reason(body.error) });
        return;
      }
      if (body.error === 'slow_down') interval += 5_000;
    }
    if (this.state.kind === 'signing-in') this.set({ kind: 'signed-out', error: copy.account.expired });
  }

  /** The API's OAuth error codes, in the app's own words; anything unexpected reads as a failure to reach it. */
  private reason(error: string): string {
    if (error === 'expired_token') return copy.account.expired;
    if (error === 'access_denied') return copy.account.denied;
    return copy.account.failed;
  }

  /** Stores the grant: tokens to the keychain, the account row to `ui_state`, the state to every window. */
  private async accept(grant: TokenGrant): Promise<void> {
    const account = accountSchema.parse(grant.account);
    await this.deps.vault.set(ACCESS_REF, grant.accessToken);
    await this.deps.vault.set(REFRESH_REF, grant.refreshToken);
    this.accessExpiresAt = this.deps.now() + grant.expiresIn * 1000;
    // A refresh is not a new sign-in: "signed in since" is when the person actually signed in.
    const signedInAt = this.state.kind === 'signed-in' ? this.state.signedInAt : this.deps.now();
    this.deps.store.set(STORE_KEY, { account, signedInAt, accessExpiresAt: this.accessExpiresAt });
    this.abort = null;
    this.set({ kind: 'signed-in', account, signedInAt, staleSince: null });
    logger.info('account: signed in', { provider: account.provider });
  }

  cancelSignIn(): void {
    if (this.state.kind !== 'signing-in') return;
    this.abort?.abort();
    this.abort = null;
    this.verificationUri = null;
    this.set(SIGNED_OUT);
  }

  /** The browser never opened, or the person closed the tab: send them back to the same page. */
  openVerification(): void {
    if (this.state.kind !== 'signing-in' || this.verificationUri === null) return;
    this.deps.openExternal(this.verificationUri);
  }

  // --- session -------------------------------------------------------------

  /** Clears the account here whatever the API says; a sign-out that needs the network is not a sign-out. */
  async signOut(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    const token = await this.deps.vault.get(ACCESS_REF).catch(() => null);
    if (token !== null) {
      // Best effort: let the server drop the refresh token too, but never wait on it to finish.
      void this.post('/v1/signout', {}, token).catch(() => undefined);
    }
    await this.deps.vault.delete(ACCESS_REF).catch(() => undefined);
    await this.deps.vault.delete(REFRESH_REF).catch(() => undefined);
    this.deps.store.delete(STORE_KEY);
    this.accessExpiresAt = 0;
    this.set(SIGNED_OUT);
  }

  /**
   * An access token good for the next minute, refreshing when it is not. `null` when signed out or when the
   * refresh could not be done — callers treat that as "no account right now", never as an error to show.
   */
  async accessToken(): Promise<string | null> {
    if (this.state.kind !== 'signed-in') return null;
    const cached = await this.deps.vault.get(ACCESS_REF).catch(() => null);
    if (cached !== null && this.deps.now() < this.accessExpiresAt - REFRESH_SKEW_MS) return cached;
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string | null> {
    const refresh = await this.deps.vault.get(REFRESH_REF).catch(() => null);
    if (refresh === null) return null;
    let r: Response;
    try {
      r = await this.post('/v1/token/refresh', { refreshToken: refresh });
    } catch (e) {
      this.markStale(e as Error);
      return null;
    }
    // The one response that ends a session: the refresh token is no longer good.
    if (r.status === 401) {
      logger.info('account: refresh rejected; signing out');
      await this.signOut();
      return null;
    }
    if (!r.ok) {
      this.markStale(new Error(`the Styx API answered ${r.status}`));
      return null;
    }
    const grant = (await r.json()) as TokenGrant;
    await this.accept(grant);
    return grant.accessToken;
  }

  /** Re-reads the profile and plan. Never throws: an unreachable API leaves the session standing and stale. */
  async refresh(): Promise<void> {
    if (this.state.kind !== 'signed-in') return;
    const token = await this.accessToken();
    // No usable token: the keychain entry is gone, or the refresh could not be done. Either way the account
    // cannot be confirmed right now, which is what stale means — never a silent no-op, and never a sign-out
    // (a locked keychain is temporary; only a 401 is the API actually saying no).
    if (token === null) {
      this.markStale(new Error('no usable token'));
      return;
    }
    try {
      const r = await this.deps.fetch(this.url('/v1/me'), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      if (r.status === 401) {
        await this.signOut();
        return;
      }
      if (!r.ok) {
        this.markStale(new Error(`the Styx API answered ${r.status}`));
        return;
      }
      const body = (await r.json()) as { account: Account };
      const account = accountSchema.parse(body.account);
      const signedInAt = this.state.kind === 'signed-in' ? this.state.signedInAt : this.deps.now();
      this.deps.store.set(STORE_KEY, { account, signedInAt, accessExpiresAt: this.accessExpiresAt });
      this.set({ kind: 'signed-in', account, signedInAt, staleSince: null });
    } catch (e) {
      this.markStale(e as Error);
    }
  }

  /** The API could not be reached. The session stands; the pane says since when. */
  private markStale(error: Error): void {
    if (this.state.kind !== 'signed-in') return;
    logger.debug('account: API unreachable', { error: error.message });
    if (this.state.staleSince !== null) return;
    this.set({ ...this.state, staleSince: this.deps.now() });
  }

  /**
   * The identity Styx commits as when git has no `user.name` / `user.email` of its own (ADR-0026 §6); `null`
   * signed out, and then the old `Styx <styx@localhost>` fallback stands.
   */
  gitIdentity(): { name: string; email: string } | null {
    if (this.state.kind !== 'signed-in') return null;
    const { name, email } = this.state.account;
    return { name: name !== null && name.trim() !== '' ? name.trim() : email, email };
  }

  shutdown(): void {
    this.abort?.abort();
    this.abort = null;
  }
}
