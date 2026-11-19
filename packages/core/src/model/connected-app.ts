import { z } from 'zod';

/**
 * Apps with their own connection for AI (ADR-0033 tier 2): a remote MCP server the person signs in to on its own
 * page. Main owns this state (ConnectedAppsService) and re-sends it whole on every change. Nothing here is a secret:
 * the sign-in lives in the OS keychain and never reaches this model, SQLite, a log or the renderer.
 */

export const connectedAppToolSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(200).nullable(),
  description: z.string().max(2000),
  /** The app says the tool only reads (MCP `readOnlyHint`). Anything else asks the person before it runs. */
  readOnly: z.boolean(),
});
export type ConnectedAppTool = z.infer<typeof connectedAppToolSchema>;

export const connectedAppStatusSchema = z.enum(['signed-out', 'signing-in', 'connected', 'error']);
export type ConnectedAppStatus = z.infer<typeof connectedAppStatusSchema>;

/** `mcp`: the app's own MCP server (tier 2). The rest are built into Styx (tier 1). */
export const connectedAppKindSchema = z.enum(['mcp', 'meta-ads']);
export type ConnectedAppKind = z.infer<typeof connectedAppKindSchema>;

export const connectedAppSchema = z.object({
  id: z.string().min(1).max(64),
  kind: connectedAppKindSchema.default('mcp'),
  /** A built-in app's account (Meta: `act_<digits>`); never a secret. */
  account: z.string().max(64).nullable().default(null),
  /** A built-in app's account currency (Meta: `ZAR`), checked against any launch plan. */
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  name: z.string().min(1).max(80),
  /** Where the app is, for showing: its origin only. The full address can carry a secret, so it lives in the keychain. */
  url: z.string().url().max(500),
  status: connectedAppStatusSchema,
  error: z.string().max(400).nullable(),
  tools: z.array(connectedAppToolSchema).max(500),
  /** Projects whose tasks may use the app; none until the person turns it on for one. */
  projects: z.array(z.string().min(1).max(64)).max(500).default([]),
  addedAt: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative().nullable(),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;

/** Only https, or http on this machine (a local server); never a credential in the address. */
export const connectedAppUrlOk = (raw: string): boolean => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return (
    u.protocol === 'http:' &&
    (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  );
};
