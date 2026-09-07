import { z } from 'zod';
import {
  agentSchema,
  askIdSchema,
  grantIdSchema,
  messageIdSchema,
  projectIdSchema,
  runnerSchema,
  scopeSchema,
  sessionIdSchema,
  targetIdSchema,
  timestampSchema,
  worktreeIdSchema,
} from './common';

export const sessionStateSchema = z.enum(['idle', 'working', 'needs-you', 'done', 'paused']);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const pausedReasonSchema = z.enum(['cli-missing', 'conflict', 'auth-expired']);
export type PausedReason = z.infer<typeof pausedReasonSchema>;

/**
 * Claude Code permission modes (`claude --permission-mode`, switchable live over the stream with
 * `set_permission_mode`). `default` = ask each time (the CLI's own default; no flag passed).
 */
export const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const PERMISSION_MODES: readonly PermissionMode[] = permissionModeSchema.options;

/** Claude Code `--effort` levels. */
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;
export const EFFORTS: readonly Effort[] = effortSchema.options;

/** Model aliases the Claude CLI accepts (`--model`); `null` = the CLI's configured default. */
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

export const sessionTogglesSchema = z.object({
  autoApproveEdits: z.boolean(),
  mayRequestTargets: z.boolean(),
  notifyWhenNeedsMe: z.boolean(),
});
export type SessionToggles = z.infer<typeof sessionTogglesSchema>;

export const sessionSchema = z
  .object({
    id: sessionIdSchema,
    projectId: projectIdSchema,
    worktreeId: worktreeIdSchema,
    agent: agentSchema,
    runner: runnerSchema,
    model: z.string().nullable(),
    /** Claude Code only; other agents keep `default`. */
    permissionMode: permissionModeSchema,
    effort: effortSchema.nullable(),
    /** The CLI's own session id (stream `system/init`), used for `--resume` when the process is relaunched. */
    cliSessionId: z.string().nullable(),
    /** Running totals from stream `result` events. */
    costUsd: z.number().nonnegative(),
    numTurns: z.number().int().nonnegative(),
    state: sessionStateSchema,
    pausedReason: pausedReasonSchema.nullable(),
    /** One-line status shown on board cards ("Requesting Supabase prod · read + write"). */
    note: z.string().nullable(),
    firstMessage: z.string().nullable(),
    toggles: sessionTogglesSchema,
    pid: z.number().int().nullable(),
    exitCode: z.number().int().nullable(),
    startedAt: timestampSchema,
    lastActivityAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
    archivedAt: timestampSchema.nullable(),
  })
  .refine((s) => (s.state === 'paused') === (s.pausedReason !== null), {
    message: 'pausedReason is set iff state is paused',
    path: ['pausedReason'],
  })
  .refine((s) => (s.state === 'done') === (s.endedAt !== null), {
    message: 'endedAt is set iff state is done',
    path: ['endedAt'],
  });
export type Session = z.infer<typeof sessionSchema>;

// --- Transcript -----------------------------------------------------------

export const messageKindSchema = z.enum([
  'user',
  'agent',
  'file-list',
  'decision',
  'access-request',
  'system',
  'tool',
  'thinking',
]);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const fileListEntrySchema = z.object({
  path: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type FileListEntry = z.infer<typeof fileListEntrySchema>;

export const messagePayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  /** `streaming`: the body is still being patched from partial stream events (renders a cursor). */
  z.object({ kind: z.literal('agent'), streaming: z.boolean().optional() }),
  z.object({ kind: z.literal('file-list'), files: z.array(fileListEntrySchema) }),
  z.object({
    kind: z.literal('decision'),
    options: z.array(z.string().min(1)).min(1),
    chosen: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('access-request'),
    targetId: targetIdSchema,
    targetLabel: z.string(),
    scope: z.array(scopeSchema).min(1),
    reason: z.string(),
    grantId: grantIdSchema,
  }),
  z.object({ kind: z.literal('system') }),
  /** A thinking block from the stream: streamed live, then collapsed to "Thought for Ns" (body = the thinking text). */
  z.object({
    kind: z.literal('thinking'),
    status: z.enum(['streaming', 'done']),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  /** One tool call from the stream (Bash / Read / Edit / …): a compact mono line, patched when its result lands. */
  z.object({
    kind: z.literal('tool'),
    tool: z.string().min(1),
    hint: z.string(),
    toolUseId: z.string().nullable(),
    status: z.enum(['running', 'ok', 'error']),
    detail: z.string().nullable(),
  }),
]);
export type MessagePayload = z.infer<typeof messagePayloadSchema>;

export const transcriptMessageSchema = z.object({
  id: messageIdSchema,
  sessionId: sessionIdSchema,
  seq: z.number().int().nonnegative(),
  body: z.string(),
  payload: messagePayloadSchema,
  askId: askIdSchema.nullable(),
  createdAt: timestampSchema,
});
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

// --- Pending asks ---------------------------------------------------------

export const askKindSchema = z.enum(['grant', 'plan', 'decision', 'question']);
export type AskKind = z.infer<typeof askKindSchema>;

export const askStateSchema = z.enum(['open', 'resolved', 'cancelled']);
export type AskState = z.infer<typeof askStateSchema>;

export const askPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grant'), grantId: grantIdSchema }),
  z.object({ kind: z.literal('plan'), summary: z.string(), files: z.array(z.string()) }),
  z.object({ kind: z.literal('decision'), prompt: z.string(), options: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('question'), prompt: z.string() }),
]);
export type AskPayload = z.infer<typeof askPayloadSchema>;

export const askResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grant'), outcome: z.enum(['granted', 'denied']) }),
  z.object({
    kind: z.literal('plan'),
    outcome: z.enum(['approved', 'rejected']),
    note: z.string().nullable(),
  }),
  z.object({ kind: z.literal('decision'), chosen: z.string() }),
  z.object({ kind: z.literal('question'), answer: z.string() }),
]);
export type AskResolution = z.infer<typeof askResolutionSchema>;

export const pendingAskSchema = z
  .object({
    id: askIdSchema,
    sessionId: sessionIdSchema,
    kind: askKindSchema,
    grantId: grantIdSchema.nullable(),
    payload: askPayloadSchema,
    state: askStateSchema,
    resolution: askResolutionSchema.nullable(),
    /** Queue position within the session; the head (lowest) is the only one surfaced. */
    position: z.number().int().nonnegative(),
    brokerRequestId: z.string().nullable(),
    createdAt: timestampSchema,
    resolvedAt: timestampSchema.nullable(),
  })
  .refine((a) => (a.kind === 'grant') === (a.grantId !== null), {
    message: 'grantId is set iff kind is grant',
    path: ['grantId'],
  });
export type PendingAsk = z.infer<typeof pendingAskSchema>;
