import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const Scope = z.enum(['read', 'write', 'deploy', 'delete']);
export type Scope = z.infer<typeof Scope>;
export const Duration = z.enum(['once', '1h', 'session', 'always']);
export type Duration = z.infer<typeof Duration>;

export const SessionBrief = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'shell']),
});
export type SessionBrief = z.infer<typeof SessionBrief>;

export const GrantOutcome = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('active'),
    grantId: z.string(),
    scope: z.array(Scope),
    expiresAt: z.number().nullable(),
    decidedBy: z.enum(['user', 'policy', 'target-policy', 'persistent-grant']),
  }),
  z.object({ status: z.literal('denied'), grantId: z.string() }),
  z.object({ status: z.literal('pending'), grantId: z.string(), queuePosition: z.number() }),
]);
export type GrantOutcome = z.infer<typeof GrantOutcome>;

export const AskResolution = z.union([
  z.object({ kind: z.literal('plan'), answer: z.enum(['approve', 'reject', 'edit']), note: z.string().optional() }),
  z.object({ kind: z.literal('decision'), answer: z.string() }),
  z.object({ kind: z.literal('question'), answer: z.string() }),
]);
export type AskResolution = z.infer<typeof AskResolution>;

export const Credential = z.object({
  kind: z.enum(['env', 'ssh-agent']),
  env: z.record(z.string(), z.string()).optional(),
  socketPath: z.string().optional(),
  expiresAt: z.number().nullable(),
  scoped: z.boolean(),
});
export type Credential = z.infer<typeof Credential>;

const waitMs = z.number().int().min(0).max(600_000).default(300_000);

/** Method table: params and result schemas. The server validates params, the client validates results. */
export const methods = {
  hello: {
    params: z.object({
      v: z.literal(PROTOCOL_VERSION),
      sessionId: z.string(),
      token: z.string().min(16),
      client: z.enum(['mcp', 'shim', 'cli', 'hook']),
      pid: z.number().int(),
    }),
    result: z.object({ ok: z.literal(true), session: SessionBrief }),
  },
  request_access: {
    params: z.object({
      target: z.string().min(1),
      scope: z.array(Scope).min(1),
      reason: z.string().min(1).max(500),
      triggeredBy: z.string().max(1000).optional(),
      waitMs,
    }),
    result: GrantOutcome,
  },
  check_grant: { params: z.object({ grantId: z.string(), waitMs }), result: GrantOutcome },
  get_credential: { params: z.object({ grantId: z.string() }), result: Credential },
  exec_authorize: {
    params: z.object({ tool: z.string(), argv: z.array(z.string()), cwd: z.string() }),
    result: z.object({ grantId: z.string(), useId: z.string(), env: z.record(z.string(), z.string()) }),
  },
  exec_report: { params: z.object({ useId: z.string(), exitCode: z.number().int() }), result: z.object({ ok: z.literal(true) }) },
  ask_user: {
    params: z.object({ kind: z.enum(['plan', 'decision', 'question']), payload: z.unknown(), waitMs }),
    result: z.object({ resolution: AskResolution }),
  },
  report_status: {
    params: z.object({ note: z.string().max(200), state: z.enum(['working', 'idle', 'done']).optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  hook: {
    params: z.object({ agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'shell']), event: z.string(), payload: z.unknown() }),
    result: z.object({ ok: z.literal(true) }),
  },
  list_targets: {
    params: z.object({}),
    result: z.array(
      z.object({
        name: z.string(),
        provider: z.string(),
        env: z.string(),
        lockState: z.enum(['unconnected', 'locked', 'open', 'persistent', 'expired']),
        scopes: z.array(Scope),
      }),
    ),
  },
} as const;

export type MethodName = keyof typeof methods;
export type Params<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type ParamsIn<M extends MethodName> = z.input<(typeof methods)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof methods)[M]['result']>;

export const notifications = {
  'grant.revoked': z.object({ grantId: z.string(), reason: z.string() }),
  'session.stopping': z.object({}),
} as const;
export type NotificationName = keyof typeof notifications;

export const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthenticated: -32000,
  targetNotFound: -32001,
  notAllowed: -32002,
  rateLimited: -32003,
  revoked: -32004,
} as const;

export const RpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export const RpcNotification = z.object({ jsonrpc: z.literal('2.0'), method: z.string(), params: z.unknown().optional() });
export const RpcError = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
export const RpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: RpcError.optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;
export type RpcResponse = z.infer<typeof RpcResponse>;
export type RpcError = z.infer<typeof RpcError>;
