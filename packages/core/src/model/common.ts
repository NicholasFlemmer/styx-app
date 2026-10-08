import { z } from 'zod';
import type {
  AskId,
  AuditId,
  GrantId,
  HunkId,
  MessageId,
  PolicyId,
  ProjectId,
  RepoId,
  SessionId,
  TargetId,
  WorktreeId,
} from '../ids';

const isId = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

export const projectIdSchema = z.custom<ProjectId>(isId, 'expected id');
export const repoIdSchema = z.custom<RepoId>(isId, 'expected id');
export const worktreeIdSchema = z.custom<WorktreeId>(isId, 'expected id');
export const sessionIdSchema = z.custom<SessionId>(isId, 'expected id');
export const targetIdSchema = z.custom<TargetId>(isId, 'expected id');
export const grantIdSchema = z.custom<GrantId>(isId, 'expected id');
export const auditIdSchema = z.custom<AuditId>(isId, 'expected id');
export const policyIdSchema = z.custom<PolicyId>(isId, 'expected id');
export const askIdSchema = z.custom<AskId>(isId, 'expected id');
export const hunkIdSchema = z.custom<HunkId>(isId, 'expected id');
export const messageIdSchema = z.custom<MessageId>(isId, 'expected id');

/** Epoch milliseconds. */
export const timestampSchema = z.number().int().nonnegative();

export const agentSchema = z.enum(['claude', 'codex', 'gemini', 'cursor', 'opencode', 'shell']);
export type Agent = z.infer<typeof agentSchema>;

export const runnerSchema = z.enum(['pty', 'stream']);
export type Runner = z.infer<typeof runnerSchema>;

export const providerSchema = z.enum(['vercel', 'aws', 'gcp', 'supabase', 'github', 'ssh']);
export type Provider = z.infer<typeof providerSchema>;

export const envSchema = z.enum(['prod', 'staging', 'preview', 'scm']);
export type Env = z.infer<typeof envSchema>;

/** `cli` = Styx reuses the login the provider's own CLI already holds (`gcloud`/`aws`/`gh`/`vercel`/`supabase`); no secret in the vault. */
export const authMethodSchema = z.enum(['oauth', 'key', 'ssh', 'cli']);
export type AuthMethod = z.infer<typeof authMethodSchema>;

export const targetPolicySchema = z.enum(['ask-mfa', 'ask', 'always']);
export type TargetPolicy = z.infer<typeof targetPolicySchema>;

export const scopeSchema = z.enum(['read', 'write', 'deploy', 'delete']);
export type Scope = z.infer<typeof scopeSchema>;

export const durationSchema = z.enum(['once', '1h', 'session', 'always']);
export type Duration = z.infer<typeof durationSchema>;

export const platformSchema = z.enum(['darwin', 'win32']);
export type Platform = z.infer<typeof platformSchema>;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = Record<string, JsonValue>;

/** Display names by product (spec §10 tone: agents are named by product). */
export const AGENT_LABEL: Record<Agent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  shell: 'shell',
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  vercel: 'Vercel',
  aws: 'AWS',
  gcp: 'GCP',
  supabase: 'Supabase',
  github: 'GitHub',
  ssh: 'SSH host',
};
