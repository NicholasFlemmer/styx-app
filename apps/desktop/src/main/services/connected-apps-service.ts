import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  AGENT_LABEL,
  connectedAppSchema,
  connectedAppUrlOk,
  type Agent,
  type ConnectedApp,
  type ConnectedAppTool,
} from '@styx/core';
import { ulid } from 'ulid';
import { z } from 'zod';
import { redact } from './logger';
import type { AuditInput } from './audit-service';
import type { CredentialVault } from './credential-vault';
import type { CampaignLive } from '@styx/core';
import { META_GRAPH, META_TOOLS, MetaAdsConnection, metaAccountId } from './meta-ads-app';

/**
 * Apps with their own connection for AI (ADR-0033 tier 2): Styx is the MCP client, the agent never is. The person
 * signs in on the app's own page (OAuth with dynamic client registration and PKCE, done by the MCP SDK); the
 * sign-in lives only in the OS keychain. Agents reach an app's tools only through Styx's broker (`list_apps`,
 * `use_app`), bound to their session: a tool the app marks read-only runs at once, anything else waits for the
 * person's OK, and every use, OK and refusal goes on the record.
 */

/** One live connection to an app. */
export interface AppConnection {
  listTools(): Promise<ConnectedAppTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** How Styx reaches an app; the SDK in the app, a fake in tests. */
export interface AppConnector {
  /** Connects with the stored sign-in. Throws `UnauthorizedError` when the app wants the person to sign in. */
  connect(url: URL, provider: OAuthClientProvider): Promise<AppConnection>;
  /** Trades the code the app's page sent back for tokens (saved through the provider). */
  finishAuth(url: URL, provider: OAuthClientProvider, code: string): Promise<void>;
}

/** The loopback page the app's sign-in returns to (RFC 8252 §7.3). */
export interface Loopback {
  redirectUrl: string;
  /** The code, once the browser comes back with the right state. */
  code(state: string): Promise<string>;
  close(): void;
}

export interface ConnectedAppsDeps {
  vault: CredentialVault;
  /** The stored list (never a secret): read on start, written on every change. */
  load(): unknown;
  save(apps: ConnectedApp[]): void;
  publish(apps: ConnectedApp[]): void;
  audit(input: AuditInput): void;
  openExternal(url: string): Promise<void>;
  now(): number;
  connector?: AppConnector;
  loopback?: () => Promise<Loopback>;
  /** Built-in apps' HTTP (Meta's Graph API); a fake in tests. */
  fetch?: typeof fetch;
  /** How long the person has to finish signing in (5 minutes). */
  signInMs?: number;
}

/** A session asking to use an app: who it is, for the record. */
export interface AppCaller {
  sessionId: string;
  projectId: string;
  worktreeId: string | null;
  agent: Agent;
}

const storedSchema = z.array(connectedAppSchema);
const secretSchema = z.object({
  url: z.string().optional(),
  client: z.record(z.string(), z.unknown()).optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
});
type Secret = { url?: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens };

/** What a tool sends back, capped so one answer cannot flood an agent's context. */
const RESULT_MAX = 100_000;
const SIGN_IN_MS = 5 * 60_000;
/** What `list_apps` may return in all (characters), and the longest arguments a person is shown to approve. */
const LIST_MAX = 32_000;
const ARGS_SHOWN_MAX = 1_500;

/** Text from an app for an agent or a person: no control or direction-changing characters. */
const plain = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');

export const appSecretRef = (appId: string): string => `styx:v1:mcp:${appId}:oauth`;

/** Thrown for anything an agent asked that it may not have; its message is for the agent. */
export class AppRefusal extends Error {}

/**
 * The SDK's view of one app's sign-in. Interactive only while the person is signing in: a call that finds the
 * sign-in gone never opens a browser on its own, it says the app needs signing in again.
 */
class VaultAuth implements OAuthClientProvider {
  private verifier = '';
  readonly stateValue = randomBytes(24).toString('base64url');
  private cache: Secret | null = null;

  constructor(
    private readonly vault: CredentialVault,
    private readonly ref: string,
    readonly redirectUrl: string,
    private readonly open: ((url: URL) => Promise<void>) | null,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Styx',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.stateValue;
  }

  private async secret(): Promise<Secret> {
    if (this.cache !== null) return this.cache;
    const raw = await this.vault.get(this.ref);
    let parsed: Secret = {};
    if (raw !== null) {
      try {
        const s = secretSchema.safeParse(JSON.parse(raw));
        if (s.success) parsed = s.data as Secret;
      } catch {
        parsed = {};
      }
    }
    this.cache = parsed;
    return parsed;
  }

  private async write(next: Secret): Promise<void> {
    this.cache = next;
    await this.vault.set(this.ref, JSON.stringify(next));
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.secret()).client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.write({ ...(await this.secret()), client });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.secret()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ ...(await this.secret()), tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.open === null) throw new UnauthorizedError('sign in again');
    await this.open(url);
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  /** A fresh sign-in registers again: the loopback port differs each time. */
  async forgetClient(): Promise<void> {
    const { url, tokens } = await this.secret();
    await this.write({ ...(url === undefined ? {} : { url }), ...(tokens === undefined ? {} : { tokens }) });
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') this.verifier = '';
    else if (scope === 'all' || scope === 'tokens' || scope === 'client') {
      const cur = this.cache ?? {};
      const keep: Secret = cur.url === undefined ? {} : { url: cur.url };
      const next: Secret =
        scope === 'all'
          ? keep
          : scope === 'tokens'
            ? cur.client === undefined
              ? keep
              : { ...keep, client: cur.client }
            : cur.tokens === undefined
              ? keep
              : { ...keep, tokens: cur.tokens };
      this.write(next).catch(() => undefined);
    }
  }
}

/** The real connector: the MCP SDK's streamable HTTP client. */
/** Loopback, private and link-local literals: never reached unless the app itself runs on this machine. */
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

/** Whether an app on `appUrl` may send Styx to `to` (its OAuth metadata, token and authorisation endpoints). */
export const appMayReach = (appUrl: URL, to: URL): boolean => {
  const local = appUrl.protocol === 'http:';
  if (to.username !== '' || to.password !== '') return false;
  if (to.protocol === 'https:') return local || !PRIVATE_HOST.test(to.hostname);
  return local && to.protocol === 'http:' && PRIVATE_HOST.test(to.hostname);
};

/**
 * fetch that refuses what `appMayReach` refuses: the server picks these URLs, Styx does not follow them blindly. No
 * redirects (one could lead past the check). shortcut: the check reads the literal host, so a public name that
 * resolves to a private address still passes; resolve and pin the address if that ever matters.
 */
const guardedFetch =
  (appUrl: URL): typeof fetch =>
  async (input, init) => {
    const to = new URL(input instanceof Request ? input.url : String(input));
    if (!appMayReach(appUrl, to)) throw new Error(`Styx will not connect to ${to.host} for this app.`);
    return fetch(input, { ...init, redirect: 'error' });
  };

export const sdkConnector: AppConnector = {
  async connect(url, provider) {
    const client = new Client({ name: 'styx', version: '1' });
    // The SDK's own class misses its own interface under exactOptionalPropertyTypes (`sessionId?: string`).
    const transport: unknown = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
      fetch: guardedFetch(url),
    });
    await client.connect(transport as Transport);
    return {
      async listTools() {
        const out: ConnectedAppTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? {} : { cursor });
          for (const t of page.tools)
            out.push({
              name: t.name.slice(0, 200),
              title: (t.title ?? t.annotations?.title ?? null)?.slice(0, 200) ?? null,
              description: (t.description ?? '').slice(0, 2000),
              readOnly: t.annotations?.readOnlyHint === true,
            });
          cursor = page.nextCursor;
        } while (cursor !== undefined && out.length < 500);
        return out.slice(0, 500);
      },
      async callTool(name, args) {
        const r = await client.callTool({ name, arguments: args });
        const parts = Array.isArray(r.content) ? (r.content as { type: string; text?: string }[]) : [];
        const text = parts.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
        return {
          text: text === '' ? JSON.stringify(r.structuredContent ?? {}) : text,
          isError: r.isError === true,
        };
      },
      close: () => client.close(),
    };
  },
  async finishAuth(url, provider, code) {
    const r = await auth(provider, { serverUrl: url, authorizationCode: code, fetchFn: guardedFetch(url) });
    if (r !== 'AUTHORIZED') throw new UnauthorizedError('sign-in did not finish');
  },
};

const page = (title: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:48px">` +
  `<p>${title}</p><p>You can close this tab and go back to Styx.</p></body>`;

/** A one-shot listener on 127.0.0.1 for the sign-in's return, checked against the state Styx sent. */
export const loopback = async (): Promise<Loopback> => {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (e: Error) => void = () => undefined;
  let expected = '';
  const got = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  got.catch(() => undefined);
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const state = u.searchParams.get('state');
    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    if (state !== expected || expected === '') {
      res
        .writeHead(400, { 'content-type': 'text/html' })
        .end(page('That sign-in link is not the one Styx opened.'));
      return;
    }
    if (code === null) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('Sign-in was not finished.'));
      rejectCode(new Error(error === null ? 'sign-in was not finished' : redact(error).slice(0, 120)));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(page('Signed in.'));
    resolveCode(code);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    code: (state) => {
      expected = state;
      return got;
    },
    close: () => server.close(),
  };
};

export class ConnectedAppsService {
  private apps: ConnectedApp[] = [];
  private readonly live = new Map<string, AppConnection>();
  private readonly signingIn = new Map<string, () => void>();

  constructor(private readonly deps: ConnectedAppsDeps) {}

  private get connector(): AppConnector {
    return this.deps.connector ?? sdkConnector;
  }

  load(): void {
    const parsed = storedSchema.safeParse(this.deps.load() ?? []);
    // A sign-in under way when Styx quit did not finish.
    this.apps = parsed.success
      ? parsed.data.map((a) => (a.status === 'signing-in' ? { ...a, status: 'signed-out' as const } : a))
      : [];
  }

  current(): ConnectedApp[] {
    return this.apps;
  }

  private set(next: ConnectedApp[]): void {
    this.apps = next;
    this.deps.save(next);
    this.deps.publish(next);
  }

  private patch(id: string, p: Partial<ConnectedApp>): void {
    this.set(this.apps.map((a) => (a.id === id ? { ...a, ...p } : a)));
  }

  private get(id: string): ConnectedApp {
    const app = this.apps.find((a) => a.id === id);
    if (app === undefined) throw new Error('That app is not connected.');
    return app;
  }

  /**
   * Adds the app and starts its sign-in; the list shows its progress. The full address goes to the keychain (many
   * apps put a secret in it); the list keeps only its origin.
   */
  async add(name: string, url: string, projectId: string | null = null): Promise<string> {
    if (!connectedAppUrlOk(url))
      throw new Error('Use the app’s https address (http only for an app on this computer).');
    const id = ulid();
    await this.deps.vault.set(appSecretRef(id), JSON.stringify({ url }));
    this.set([
      ...this.apps,
      {
        id,
        kind: 'mcp',
        account: null,
        currency: null,
        name: name.trim().slice(0, 80),
        url: new URL(url).origin,
        status: 'signed-out',
        error: null,
        tools: [],
        projects: projectId === null ? [] : [projectId],
        addedAt: this.deps.now(),
        checkedAt: null,
      },
    ]);
    void this.signIn(id).catch(() => undefined);
    return id;
  }

  /** Which projects' tasks may use the app; on the record as a rule change. */
  setProjects(id: string, projectIds: string[]): void {
    const app = this.get(id);
    const projects = [...new Set(projectIds)];
    this.patch(id, { projects });
    this.deps.audit({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'policy-changed',
      targetLabel: app.name,
      triggeredBy: 'connected apps',
      detail: { app: app.url, projects: projects.length },
    });
  }

  /** The full address from the keychain (the list holds only the origin). */
  private async fullUrl(app: ConnectedApp): Promise<URL> {
    const raw = await this.deps.vault.get(appSecretRef(app.id));
    try {
      const u = (JSON.parse(raw ?? '{}') as { url?: unknown }).url;
      if (typeof u === 'string' && connectedAppUrlOk(u)) return new URL(u);
    } catch {
      // fall through to the origin
    }
    return new URL(app.url);
  }

  /**
   * Meta Ads (tier 1): checks the token reaches the ad account before anything is kept, then keeps the token in the
   * keychain. Pasting a new token for the same account replaces the old one.
   */
  async addMetaAds(token: string, adAccount: string, projectId: string | null = null): Promise<string> {
    const account = metaAccountId(adAccount);
    if (account === null) throw new Error('Use the ad account id, like act_1234567890.');
    let checked: { name: string; currency: string };
    try {
      checked = await new MetaAdsConnection(token, account, this.deps.fetch ?? fetch).check();
    } catch (e) {
      throw new Error(
        redact(e instanceof Error ? e.message : 'Meta did not accept that token.').slice(0, 300),
      );
    }
    const existing = this.apps.find((a) => a.kind === 'meta-ads' && a.account === account);
    const id = existing?.id ?? ulid();
    await this.drop(id);
    await this.deps.vault.set(
      appSecretRef(id),
      JSON.stringify({ tokens: { access_token: token, token_type: 'bearer' } }),
    );
    const app: ConnectedApp = {
      id,
      kind: 'meta-ads',
      account,
      currency: /^[A-Z]{3}$/.test(checked.currency) ? checked.currency : null,
      // The currency is in the name, so every question about a budget shows what the amount is in.
      name: `Meta Ads · ${checked.name}${checked.currency === '' ? '' : ` (${checked.currency})`}`.slice(
        0,
        80,
      ),
      url: META_GRAPH,
      status: 'connected',
      error: null,
      tools: META_TOOLS,
      projects: [...new Set([...(existing?.projects ?? []), ...(projectId === null ? [] : [projectId])])],
      addedAt: existing?.addedAt ?? this.deps.now(),
      checkedAt: this.deps.now(),
    };
    this.set(existing === undefined ? [...this.apps, app] : this.apps.map((a) => (a.id === id ? app : a)));
    this.deps.audit({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'connected',
      targetLabel: app.name,
      triggeredBy: 'connected apps',
      detail: { app: 'meta-ads', account },
    });
    return id;
  }

  /** Signs in on the app's own page (when it asks for one), then reads what the app can do. */
  async signIn(id: string): Promise<void> {
    const app = this.get(id);
    // A built-in app signs in by pasting a new token (addMetaAds), not through a browser.
    if (app.kind !== 'mcp') return;
    this.signingIn.get(id)?.();
    await this.drop(id);
    this.patch(id, { status: 'signing-in', error: null });
    const lb = await (this.deps.loopback ?? loopback)();
    let cancelled = false;
    this.signingIn.set(id, () => {
      cancelled = true;
      lb.close();
    });
    const url = await this.fullUrl(app);
    let interactive = true;
    const provider = new VaultAuth(this.deps.vault, appSecretRef(id), lb.redirectUrl, async (to) => {
      // Only while the person is signing in, and only to a web page this app may send them to.
      if (!interactive) throw new UnauthorizedError('sign in again');
      if (!appMayReach(url, to)) throw new Error('The app sent an unsafe sign-in address.');
      await this.deps.openExternal(to.toString());
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_r, rej) => {
      timer = setTimeout(
        () => rej(new Error('Sign-in took too long. Try again.')),
        this.deps.signInMs ?? SIGN_IN_MS,
      );
      timer.unref?.();
    });
    deadline.catch(() => undefined);
    try {
      const tools = await Promise.race([
        (async () => {
          await provider.forgetClient();
          let conn: AppConnection;
          try {
            conn = await this.connector.connect(url, provider);
          } catch (e) {
            if (!(e instanceof UnauthorizedError)) throw e;
            const code = await lb.code(provider.stateValue);
            await this.connector.finishAuth(url, provider, code);
            conn = await this.connector.connect(url, provider);
          }
          // The sign-in connection is never kept: later calls open one that cannot start a browser.
          try {
            return await conn.listTools();
          } finally {
            await conn.close().catch(() => undefined);
          }
        })(),
        deadline,
      ]);
      this.patch(id, { status: 'connected', error: null, tools, checkedAt: this.deps.now() });
      this.deps.audit({
        actorKind: 'you',
        actorLabel: 'you',
        action: 'connected',
        targetLabel: app.name,
        triggeredBy: 'connected apps',
        detail: { app: app.url, tools: tools.length },
      });
    } catch (e) {
      if (cancelled) return;
      const msg = e instanceof Error ? redact(e.message).slice(0, 300) : 'Sign-in failed.';
      this.patch(id, { status: 'error', error: msg });
    } finally {
      interactive = false;
      clearTimeout(timer);
      lb.close();
      this.signingIn.delete(id);
    }
  }

  /** Forgets the app and its sign-in. */
  async remove(id: string): Promise<void> {
    const app = this.get(id);
    this.signingIn.get(id)?.();
    await this.drop(id);
    await this.deps.vault.delete(appSecretRef(id));
    this.set(this.apps.filter((a) => a.id !== id));
    this.deps.audit({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'disconnected',
      targetLabel: app.name,
      triggeredBy: 'connected apps',
      detail: { app: app.url },
    });
  }

  private async drop(id: string): Promise<void> {
    const c = this.live.get(id);
    this.live.delete(id);
    await c?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const stop of this.signingIn.values()) stop();
    await Promise.all([...this.live.keys()].map((id) => this.drop(id)));
  }

  /**
   * The Meta Ads app turned on for a project, for what the person does themselves (Pause everything, the live
   * view); null when there is none or it is signed out.
   */
  metaFor(
    projectId: string,
    now: () => number,
  ): { pause(id: string): Promise<void>; live(campaignId: string): Promise<CampaignLive> } | null {
    const app = this.apps.find(
      (a) => a.kind === 'meta-ads' && a.status === 'connected' && a.projects.includes(projectId),
    );
    if (app === undefined || app.account === null) return null;
    const account = app.account;
    const open = async () => {
      const raw = await this.deps.vault.get(appSecretRef(app.id));
      let t: unknown;
      try {
        t = (JSON.parse(raw ?? '{}') as { tokens?: { access_token?: unknown } }).tokens?.access_token;
      } catch {
        t = undefined;
      }
      if (typeof t !== 'string') throw new Error('Meta Ads needs signing in again.');
      return new MetaAdsConnection(t, account, this.deps.fetch ?? fetch);
    };
    return {
      pause: async (id) => (await open()).pauseCampaign(id),
      live: async (id) => (await open()).live(id, now()),
    };
  }

  /**
   * What an agent in `projectId` may see: the apps turned on for its project and their tools (never an address or a
   * sign-in). Tool text comes from the app, so it is cleaned and the whole answer capped.
   */
  listForAgents(projectId: string): {
    app: string;
    name: string;
    tools: { name: string; description: string; readOnly: boolean }[];
  }[] {
    let budget = LIST_MAX;
    const out: {
      app: string;
      name: string;
      tools: { name: string; description: string; readOnly: boolean }[];
    }[] = [];
    for (const a of this.apps) {
      if (a.status !== 'connected' || !a.projects.includes(projectId)) continue;
      const tools: { name: string; description: string; readOnly: boolean }[] = [];
      for (const t of a.tools) {
        const tool = { name: t.name, description: plain(t.description).slice(0, 500), readOnly: t.readOnly };
        budget -= tool.name.length + tool.description.length + 40;
        if (budget < 0) break;
        tools.push(tool);
      }
      out.push({ app: a.id, name: a.name, tools });
      if (budget < 0) break;
    }
    return out;
  }

  /** The app and tool an agent in `projectId` named, or a refusal it can read. By id or by its exact name. */
  resolve(
    projectId: string,
    appRef: string,
    toolName: string,
  ): { app: ConnectedApp; tool: ConnectedAppTool } {
    const mine = this.apps.filter((a) => a.projects.includes(projectId));
    const app = mine.find((a) => a.id === appRef) ?? mine.find((a) => a.name === appRef);
    if (app === undefined)
      throw new AppRefusal(`No connected app "${appRef}" for this project. Call list_apps.`);
    if (app.status !== 'connected')
      throw new AppRefusal(
        `${app.name} needs signing in again; ask the person to sign in under Connected apps.`,
      );
    const tool = app.tools.find((t) => t.name === toolName);
    if (tool === undefined) throw new AppRefusal(`${app.name} has no tool "${toolName}". Call list_apps.`);
    return { app, tool };
  }

  /** The one line the person reads before saying yes. */
  askPrompt(
    caller: AppCaller,
    app: ConnectedApp,
    tool: ConnectedAppTool,
    args: Record<string, unknown>,
  ): string {
    // The person approves what they can read: arguments too long to show in full are refused, never cut.
    const shown = redact(JSON.stringify(args));
    if (shown.length > ARGS_SHOWN_MAX)
      throw new AppRefusal(
        `Those arguments are too long to show the person (${shown.length} characters, ${ARGS_SHOWN_MAX} at most). Split the change into smaller steps.`,
      );
    const what = tool.title === null ? tool.name : `${plain(tool.title)} (${tool.name})`;
    return `${AGENT_LABEL[caller.agent]} wants to use ${app.name}: ${what}. It can change things there. ${shown}`;
  }

  /** Runs the tool for the caller and puts it on the record; `approvedBy` says why it was allowed to run. */
  async call(
    caller: AppCaller,
    app: ConnectedApp,
    tool: ConnectedAppTool,
    args: Record<string, unknown>,
    approvedBy: 'reads only' | 'you' | 'launch plan',
  ): Promise<{ text: string; isError: boolean }> {
    // A change is never sent twice: only a read is retried on a fresh connection.
    const result = await this.withConnection(app, (c) => c.callTool(tool.name, args), tool.readOnly);
    this.record(caller, app, tool, args, 'used', { approvedBy, error: result.isError });
    return { text: result.text.slice(0, RESULT_MAX), isError: result.isError };
  }

  /** Asked the person: on the record when the question opens. */
  requested(
    caller: AppCaller,
    app: ConnectedApp,
    tool: ConnectedAppTool,
    args: Record<string, unknown>,
  ): void {
    this.record(caller, app, tool, args, 'requested', {});
  }

  /** Did not run: the person said no, nobody answered in time, or the task ended first. */
  refused(
    caller: AppCaller,
    app: ConnectedApp,
    tool: ConnectedAppTool,
    args: Record<string, unknown>,
    reason: 'you' | 'timeout' | 'cancelled',
  ): void {
    this.record(caller, app, tool, args, 'denied', { reason });
  }

  private record(
    caller: AppCaller,
    app: ConnectedApp,
    tool: ConnectedAppTool,
    args: Record<string, unknown>,
    action: 'used' | 'denied' | 'requested',
    extra: Record<string, unknown>,
  ): void {
    const byYou = action === 'denied' && extra['reason'] === 'you';
    const bySystem = action === 'denied' && !byYou;
    this.deps.audit({
      actorKind: byYou ? 'you' : bySystem ? 'system' : 'agent',
      actorLabel: byYou ? 'you' : bySystem ? 'system' : AGENT_LABEL[caller.agent],
      action,
      projectId: caller.projectId,
      sessionId: caller.sessionId,
      worktreeId: caller.worktreeId,
      agent: caller.agent,
      targetLabel: `${app.name} · ${tool.name}`,
      triggeredBy: 'use_app',
      detail: {
        tool: tool.name,
        readOnly: tool.readOnly,
        args: redact(JSON.stringify(args)).slice(0, 400),
        ...extra,
      },
    });
  }

  private async withConnection<T>(
    app: ConnectedApp,
    run: (c: AppConnection) => Promise<T>,
    retry: boolean,
  ): Promise<T> {
    const open = async (): Promise<AppConnection> => {
      const existing = this.live.get(app.id);
      if (existing !== undefined) return existing;
      if (app.kind === 'meta-ads') {
        const raw = await this.deps.vault.get(appSecretRef(app.id));
        const token = (() => {
          try {
            const t = (JSON.parse(raw ?? '{}') as { tokens?: { access_token?: unknown } }).tokens
              ?.access_token;
            return typeof t === 'string' ? t : null;
          } catch {
            return null;
          }
        })();
        if (token === null || app.account === null) throw new UnauthorizedError('sign in again');
        const c = new MetaAdsConnection(token, app.account, this.deps.fetch ?? fetch);
        this.live.set(app.id, c);
        return c;
      }
      // Not interactive: a lost sign-in turns into "sign in again", never a browser opening by itself.
      const provider = new VaultAuth(
        this.deps.vault,
        appSecretRef(app.id),
        'http://127.0.0.1/callback',
        null,
      );
      const c = await this.connector.connect(await this.fullUrl(app), provider);
      this.live.set(app.id, c);
      return c;
    };
    try {
      return await run(await open());
    } catch (e) {
      await this.drop(app.id);
      if (e instanceof UnauthorizedError) {
        this.patch(app.id, { status: 'signed-out', error: 'Sign in again.' });
        throw new AppRefusal(
          `${app.name} needs signing in again; ask the person to sign in under Connected apps.`,
        );
      }
      if (!retry)
        throw new AppRefusal(
          `${app.name} did not answer: ${redact(String((e as Error).message ?? e)).slice(0, 200)}`,
        );
      // One retry on a fresh connection: a server restart or an idle timeout drops the session.
      try {
        return await run(await open());
      } catch (again) {
        await this.drop(app.id);
        throw new AppRefusal(
          `${app.name} did not answer: ${redact(String((again as Error).message ?? again)).slice(0, 200)}`,
        );
      }
    }
  }
}
