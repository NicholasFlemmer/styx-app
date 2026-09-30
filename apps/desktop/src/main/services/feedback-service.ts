import { fail } from '../ipc/bus';

/**
 * Feedback (owner request, #123): what the person typed, and their email only if they gave one, sent to the
 * Styx API for the owner's dashboard. Main adds the version, OS and install id — the same three things usage
 * counts carry — and the account's token when signed in, so a reply can find them. Nothing about a project,
 * path or agent is in scope here, and there is no parameter for one.
 */

export interface FeedbackDeps {
  fetch: typeof globalThis.fetch;
  apiBase: () => string;
  /** The account's access token, or null when signed out. */
  token: () => Promise<string | null>;
  installId: () => string;
  version: string;
  os: string;
  /** The end of Styx's log, secrets masked; only read when the person ticked "Include diagnostics" (#125). */
  diagnostics?: () => Promise<string | null>;
}

export class FeedbackService {
  constructor(private readonly deps: FeedbackDeps) {}

  /** Sends one message. Unlike usage counts this is something the person is waiting on, so failures are said. */
  async send(message: string, email: string | null, diagnostics = false): Promise<void> {
    const token = await this.deps.token().catch(() => null);
    const log = diagnostics ? await (this.deps.diagnostics?.() ?? Promise.resolve(null)).catch(() => null) : null;
    let r: Response;
    try {
      r = await this.deps.fetch(`${this.deps.apiBase().replace(/\/+$/, '')}/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          message,
          ...(email === null ? {} : { email }),
          ...(log === null || log === '' ? {} : { diagnostics: log }),
          installId: this.deps.installId(),
          version: this.deps.version,
          os: this.deps.os,
        }),
      });
    } catch {
      fail('provider-error', 'Styx could not reach its server; check your connection');
    }
    if (r.status === 429) fail('provider-error', 'too many messages in a short time; wait a little');
    if (!r.ok) fail('provider-error', `the server answered ${r.status}`);
  }
}
