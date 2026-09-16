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
/**
 * Why Styx itself started a session: the Run locally / Deploy buttons hand the first attempt to the agent, and only
 * such a session may teach Styx the result (`remember_command`). Exposed on the read model so background tasks stay separate from chats.
 */
export const sessionPurposeSchema = z.enum(['learn-run', 'learn-deploy', 'debt-audit']);
export type SessionPurpose = z.infer<typeof sessionPurposeSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;

/** The first three are faults Styx detected; `user` is the owner holding the agent from the chat. */
export const pausedReasonSchema = z.enum(['cli-missing', 'conflict', 'auth-expired', 'user']);
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
/** Claude Code: low…max. Codex adds `ultra` on some models; the per-model list comes from the CLI (`ModelInfo.efforts`). */
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export type Effort = z.infer<typeof effortSchema>;
export const EFFORTS: readonly Effort[] = effortSchema.options;

/**
 * One model a CLI offers (Codex `model/list`; Claude's aliases are static): the composer's model and effort pickers
 * are built from this list, stored under `CliInstall.capabilities.models` (see `modelCatalogueOf`).
 */
export const modelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().default(null),
  efforts: z.array(effortSchema),
  defaultEffort: effortSchema.nullable(),
  isDefault: z.boolean(),
  /** Hidden by the CLI (still selectable by id). */
  hidden: z.boolean().default(false),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

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
    purpose: sessionPurposeSchema.optional(),
    taskTargetId: targetIdSchema.optional(),
    model: z.string().nullable(),
    /** Claude Code only; other agents keep `default`. */
    permissionMode: permissionModeSchema,
    effort: effortSchema.nullable(),
    /** The CLI's own session id (stream `system/init`), used for `--resume` when the process is relaunched. */
    cliSessionId: z.string().nullable(),
    /** Running totals from stream `result` events. */
    costUsd: z.number().nonnegative(),
    numTurns: z.number().int().nonnegative(),
    /** Token totals for CLIs that report tokens rather than dollars (Codex `thread/tokenUsage/updated`). */
    tokensUsed: z.number().int().nonnegative().optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    /** Slash commands the CLI advertised at init (skills, plugins, built-ins); the composer's `/` popup lists them. */
    slashCommands: z.array(z.string()),
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
  'questions',
  'plan',
  'peer',
]);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const fileListEntrySchema = z.object({
  path: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type FileListEntry = z.infer<typeof fileListEntrySchema>;

/** What a user message carried besides text (shown as chips; the bytes themselves are never stored in the transcript). */
export const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    name: z.string(),
    mediaType: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('file'), path: z.string().min(1), bytes: z.number().int().nonnegative() }),
]);
export type Attachment = z.infer<typeof attachmentSchema>;

/** Image types the Anthropic API accepts as base64 image blocks. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const imageMediaTypeSchema = z.enum(IMAGE_MEDIA_TYPES);
/** Caps: 5 MB per image (API limit), 200 KB per attached text file (inlined into the turn). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_ATTACHMENT_BYTES = 200 * 1024;

/**
 * One question inside an `AskUserQuestion` set. `options` may be empty (a pure free-text ask); `multiSelect`
 * lets several labels be chosen. Every question also accepts free text, so `options` is never a closed list.
 */
export const askQuestionSchema = z.object({
  /** Stable within its set: answers are keyed by this, so order changes never mis-assign an answer. */
  key: z.string().min(1),
  header: z.string().nullable(),
  prompt: z.string().min(1),
  multiSelect: z.boolean(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().nullable() })),
  /** The answer is a secret (Codex `requestUserInput.isSecret`): masked input, never echoed into the transcript. */
  secret: z.boolean().optional(),
});
export type AskQuestion = z.infer<typeof askQuestionSchema>;

/** One question's answer: the labels ticked, plus free text when the reader typed their own. */
export const askAnswerSchema = z.object({
  key: z.string().min(1),
  chosen: z.array(z.string()),
  freeText: z.string().nullable(),
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;

export const messagePayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), attachments: z.array(attachmentSchema).optional() }),
  /** `streaming`: the body is still being patched from partial stream events (renders a cursor). */
  z.object({ kind: z.literal('agent'), streaming: z.boolean().optional() }),
  z.object({ kind: z.literal('file-list'), files: z.array(fileListEntrySchema) }),
  z.object({
    kind: z.literal('decision'),
    options: z.array(z.string().min(1)).min(1),
    chosen: z.string().nullable(),
  }),
  /**
   * A whole `AskUserQuestion` set as one card: the agent sends up to 4 related questions meant to be answered
   * together, so they are never drip-fed one at a time. `answers` is null while the card is still open.
   */
  z.object({
    kind: z.literal('questions'),
    questions: z.array(askQuestionSchema).min(1),
    answers: z.array(askAnswerSchema).nullable(),
  }),
  /** An `ExitPlanMode` plan awaiting approval: the plan markdown is the body; `outcome` null while open. */
  z.object({
    kind: z.literal('plan'),
    files: z.array(z.string()),
    outcome: z.enum(['approved', 'rejected']).nullable(),
  }),
  z.object({
    kind: z.literal('access-request'),
    targetId: targetIdSchema,
    targetLabel: z.string(),
    scope: z.array(scopeSchema).min(1),
    reason: z.string(),
    grantId: grantIdSchema,
  }),
  /**
   * A message from another agent in the same project. It is deliberately NOT a `user` row: rendering a peer's
   * text as if the human typed it would be both a lie and a prompt-injection primitive, since the receiving
   * agent weights its operator's words differently from a peer's.
   */
  z.object({
    kind: z.literal('peer'),
    fromSessionId: sessionIdSchema,
    fromAgent: agentSchema,
    fromBranch: z.string().nullable(),
    /** False on the sender's own copy of the row (its outbox echo). */
    inbound: z.boolean(),
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

export const askKindSchema = z.enum(['grant', 'plan', 'decision', 'question', 'questions']);
export type AskKind = z.infer<typeof askKindSchema>;

export const askStateSchema = z.enum(['open', 'resolved', 'cancelled']);
export type AskState = z.infer<typeof askStateSchema>;

export const askPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grant'), grantId: grantIdSchema }),
  z.object({ kind: z.literal('plan'), summary: z.string(), files: z.array(z.string()) }),
  z.object({ kind: z.literal('decision'), prompt: z.string(), options: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('question'), prompt: z.string() }),
  /** A whole `AskUserQuestion` set held by one ask, so the set resolves in one go. */
  z.object({ kind: z.literal('questions'), questions: z.array(askQuestionSchema).min(1) }),
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
  /** Every question in the set answers at once: one entry per question, keyed to it. */
  z.object({ kind: z.literal('questions'), answers: z.array(askAnswerSchema).min(1) }),
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
