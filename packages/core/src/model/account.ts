import { z } from 'zod';

/**
 * The Styx account (ADR-0026). Identity is federated: the app talks only to Styx's API, which signs the person
 * in through GitHub or Google. Nothing here is a secret — the tokens live in the OS keychain and never reach
 * this model, SQLite, a log, an IPC payload or the renderer.
 */

export const accountProviderSchema = z.enum(['github', 'google']);
export type AccountProvider = z.infer<typeof accountProviderSchema>;
export const ACCOUNT_PROVIDERS: readonly AccountProvider[] = accountProviderSchema.options;

/** What Styx charges for. Nothing in the app reads it yet: the licence exists before anything gates on it. */
export const accountPlanSchema = z.enum(['free', 'pro', 'team']);
export type AccountPlan = z.infer<typeof accountPlanSchema>;

export const accountSchema = z.object({
  /** Styx's own user id, stable across providers. */
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().nullable().default(null),
  avatarUrl: z.string().nullable().default(null),
  provider: accountProviderSchema,
  plan: accountPlanSchema.default('free'),
  /** Epoch ms the paid plan runs to; null on `free` or an open-ended plan. */
  planUntil: z.number().nullable().default(null),
});
export type Account = z.infer<typeof accountSchema>;

/**
 * What the renderer sees. A discriminated union rather than `account | null` + flags, so an impossible pairing
 * (signing in *and* signed in) cannot be represented.
 *
 * `signed-in` carries `staleSince` when the API could not be reached: the session stands and the app carries on
 * (ADR-0026 §5), the pane just says so. Only a 401 or Sign out returns to `signed-out`.
 */
export const accountStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signed-out'), error: z.string().nullable().default(null) }),
  z.object({
    kind: z.literal('signing-in'),
    provider: accountProviderSchema,
    /** Shown to the person; they type it into the browser. */
    userCode: z.string(),
    verificationUri: z.string(),
    /** Epoch ms the code stops working. */
    expiresAt: z.number(),
  }),
  z.object({
    kind: z.literal('signed-in'),
    account: accountSchema,
    signedInAt: z.number(),
    /** Epoch ms of the first failed reach since the last good one; null while the API is answering. */
    staleSince: z.number().nullable().default(null),
  }),
]);
export type AccountState = z.infer<typeof accountStateSchema>;

export const SIGNED_OUT: AccountState = { kind: 'signed-out', error: null };

/**
 * The row persisted per machine (`ui_state.account`). Never a token — but it does carry when the access token
 * stops being usable, so a restart can go on using the one in the keychain instead of spending a refresh on
 * every launch. An expiry is not a secret.
 */
export const storedAccountSchema = z.object({
  account: accountSchema,
  signedInAt: z.number(),
  accessExpiresAt: z.number().default(0),
});
export type StoredAccount = z.infer<typeof storedAccountSchema>;

/** "Nic Flemmer" when the account has a name, else the email — what the pane and a commit author read. */
export const accountLabel = (account: Account): string =>
  account.name !== null && account.name.trim() !== '' ? account.name.trim() : account.email;
