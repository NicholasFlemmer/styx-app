import type { PermissionMode } from '@styx/core';
import { styxBin, type AgentLaunch, type AgentLaunchContext } from './types';

/** Env the styx MCP server needs; Codex forwards only these names from its own environment (never values on argv). */
const MCP_ENV_VARS = [
  'STYX_SESSION_ID',
  'STYX_BROKER',
  'STYX_TOKEN',
  'STYX_PROJECT_ID',
  'STYX_WORKTREE',
  'STYX_SHIM_DIR',
  'STYX_CLI',
  'STYX_EXE',
];

/** A `[projects."<path>"]` key the way Codex itself writes it (`trusted_project_edit`): backslashes and quotes escaped. */
export const codexTrustKey = (path: string): string =>
  `projects."${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}".trust_level`;

// --- Permission modes → Codex approval / sandbox vocabulary ------------------

/** `AskForApproval` (the granular form is not used). */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/** `SandboxPolicy` as `turn/start.sandboxPolicy` takes it (the full object, roots included). */
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/** `SandboxMode`: the string form `thread/start.sandbox` takes. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type CodexApprovalsReviewer = 'user' | 'auto_review';

export interface CodexPolicy {
  approvalPolicy: CodexApprovalPolicy;
  sandboxPolicy: CodexSandboxPolicy;
  sandboxMode: CodexSandboxMode;
  approvalsReviewer: CodexApprovalsReviewer;
}

/**
 * Network stays off inside the sandbox (Codex's own workspace-write default): a command that needs it is
 * denied by the sandbox and comes back as a `commandExecution/requestApproval` to rerun outside it, which is the
 * ask the user sees in Styx. That also covers the styx shims (they reach the broker over a unix socket, which the
 * sandbox blocks): the rerun after approval runs unsandboxed and the grant flow proceeds as for any agent.
 * Writable roots are the worktree only: the main checkout is never written without a review.
 */
const workspaceWrite = (roots: readonly string[]): CodexSandboxPolicy => ({
  type: 'workspaceWrite',
  writableRoots: [...new Set(roots)],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});

/**
 * Styx permission mode → Codex `approvalPolicy` × `sandboxPolicy` × `approvalsReviewer` (docs/research/agent-parity.md
 * §5), chosen at `thread/start` and re-sent on every `turn/start` so a live mode switch applies to the next turn:
 *
 * | Styx              | approval   | sandbox                              | reviewer    |
 * | default           | on-request | workspaceWrite (worktree + project)  | user        |
 * | acceptEdits       | on-request | workspaceWrite                       | user        | (edits never ask in workspace-write anyway)
 * | plan              | on-request | readOnly                             | user        |
 * | bypassPermissions | never      | dangerFullAccess                     | user        |
 * | dontAsk           | never      | workspaceWrite                       | user        | (whatever would ask fails back to the model)
 * | auto              | on-request | workspaceWrite                       | auto_review | (`--approve-for-me`)
 */
export const codexPolicy = (mode: PermissionMode, roots: readonly string[]): CodexPolicy => {
  switch (mode) {
    case 'default':
    case 'acceptEdits':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: workspaceWrite(roots),
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'user',
      };
    case 'plan':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        sandboxMode: 'read-only',
        approvalsReviewer: 'user',
      };
    case 'bypassPermissions':
      return {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        sandboxMode: 'danger-full-access',
        approvalsReviewer: 'user',
      };
    case 'dontAsk':
      return {
        approvalPolicy: 'never',
        sandboxPolicy: workspaceWrite(roots),
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'user',
      };
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: workspaceWrite(roots),
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'auto_review',
      };
  }
};

// --- Launch ------------------------------------------------------------------

/** The `-c` overrides that register the styx MCP server (env forwarded by name) and mark both checkouts trusted. */
const configOverrides = (ctx: AgentLaunchContext): string[] => {
  const bin = styxBin(ctx);
  const args = [
    '-c',
    `mcp_servers.styx.command=${JSON.stringify(bin)}`,
    '-c',
    'mcp_servers.styx.args=["mcp"]',
    '-c',
    `mcp_servers.styx.env_vars=${JSON.stringify(MCP_ENV_VARS)}`,
  ];
  for (const path of new Set([ctx.worktreePath, ctx.projectPath])) {
    args.push('-c', `${codexTrustKey(path)}="trusted"`);
  }
  return args;
};

/**
 * Codex CLI.
 *
 * `stream` (ADR-0016, codex ≥ 0.154 with `app-server` in its `--help`): `codex app-server` speaks JSON-RPC 2.0 over
 * stdio; the AppServerRunner starts the thread, sends turns, answers approvals and maps items onto the transcript.
 * The `-c` overrides are the same ones the TUI takes (VERIFIED 2026-09-16: `codex app-server --help` lists
 * `-c, --config <key=value>`): the styx MCP server with its env forwarded by name, and both checkouts trusted. No
 * `notify` hook — `turn/started` / `turn/completed` drive the state machine directly. Model, effort and permission
 * mode travel in `thread/start` / `turn/start`, never on argv.
 *
 * `pty` (older builds, ADR-0010): the TUI in xterm with the `notify` hook (`agent-turn-complete` → `styx hook codex`)
 * for idle detection, and the directory marked trusted so the TUI does not open on its "Do you trust the contents
 * of this directory?" dialog — which swallowed the first message and stalled every session started from Styx.
 *
 * VERIFIED 2026-09-15 against codex 0.154.0 (`codex mcp list` with the same overrides): `mcp_servers.<name>.command`,
 * `.args`, `.env_vars` (names forwarded from Codex's own env — Codex hands MCP servers a core env only, so without
 * this `styx mcp` never saw the broker and Codex reported "1 MCP startup issue"), `notify=[...]`, and
 * `projects."<path>".trust_level="trusted"` (the key Codex writes itself; for a git worktree Codex looks up the main
 * checkout root, so both paths are marked).
 */
export async function codexLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  if (ctx.runner === 'stream') {
    return {
      command: ctx.binary,
      args: ['app-server', ...configOverrides(ctx)],
      env: {},
      typeFirstMessage: false,
      stream: { kind: 'app-server' },
      cleanup: async () => undefined,
    };
  }
  const bin = styxBin(ctx);
  const args = [...configOverrides(ctx), '-c', `notify=[${JSON.stringify(bin)},"hook","codex"]`];
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: async () => undefined };
}
