import type { Agent, Runner } from '@styx/core';

export interface AgentLaunchContext {
  agent: Agent;
  /** Resolved CLI binary (DetectService) or the login shell for `shell`. */
  binary: string;
  sessionId: string;
  worktreePath: string;
  firstMessage: string | null;
  model: string | null;
  /** `stream` = headless stream-json over pipes (ADR-0010); `pty` = the CLI's own TUI in xterm. */
  runner: Runner;
  /** Session toggle: edits are allowed without a permission prompt. */
  autoApproveEdits: boolean;
  /** Per-session scratch dir for temp config files (`<userData>/agents/<sessionId>`). */
  configDir: string;
  shimDir: string;
  platform: NodeJS.Platform;
  /** The session env (STYX_*); adapters may add to it. */
  env: Record<string, string>;
}

/**
 * How a `stream` launch receives user turns:
 * - `stdin`: one long-lived process; each message is an NDJSON `{type:'user'}` line on stdin (Claude Code).
 * - `argv`: one process per turn; the prompt is the last argument and later turns pass `<resumeFlag> <chatId>`
 *   with the id learned from the first turn's `system/init` event (cursor-agent).
 */
export type StreamInput = { kind: 'stdin' } | { kind: 'argv'; resumeFlag: string };

export interface AgentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** When the CLI takes no prompt argument, the first message is typed into the pty after start. */
  typeFirstMessage: boolean;
  /** Present only for `stream` launches. */
  stream?: StreamInput;
  cleanup(): Promise<void>;
}

/** The `styx` shim on PATH (absolute so MCP configs work regardless of the agent's own PATH handling). */
export const styxBin = (ctx: Pick<AgentLaunchContext, 'shimDir' | 'platform'>): string =>
  `${ctx.shimDir}${ctx.platform === 'win32' ? '\\styx.cmd' : '/styx'}`;

/** MCP server entry every agent gets: `styx mcp` proxies the broker over stdio (plan §6). */
export const styxMcpServer = (
  ctx: AgentLaunchContext,
): { command: string; args: string[]; env: Record<string, string> } => ({
  command: styxBin(ctx),
  args: ['mcp'],
  env: {
    STYX_SESSION_ID: ctx.env['STYX_SESSION_ID'] ?? '',
    STYX_BROKER: ctx.env['STYX_BROKER'] ?? '',
    STYX_TOKEN: ctx.env['STYX_TOKEN'] ?? '',
  },
});
