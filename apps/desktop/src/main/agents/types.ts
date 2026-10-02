import { copy, fill, type Agent, type Effort, type PermissionMode, type Runner } from '@styx/core';

/** The styx MCP server as an agent protocol takes it in-band (`session/new.mcpServers`, Codex `-c mcp_servers.*`). */
export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentLaunchContext {
  agent: Agent;
  /** Resolved CLI binary (DetectService) or the login shell for `shell`. */
  binary: string;
  sessionId: string;
  worktreePath: string;
  /** The project's main checkout: some CLIs key per-directory trust on it rather than on the worktree (Codex). */
  projectPath: string;
  firstMessage: string | null;
  model: string | null;
  /** `stream` = headless stream-json over pipes (ADR-0010); `pty` = the CLI's own TUI in xterm. */
  runner: Runner;
  /** Flag capabilities DetectService read off `--help` (`streamJson`, `appServer`, `acp`, …). */
  capabilities: Record<string, boolean>;
  /** Session toggle: edits are allowed without a permission prompt. */
  autoApproveEdits: boolean;
  /**
   * Claude Code only (`--permission-mode`); `default` passes no flag and lets `autoApproveEdits` pick `acceptEdits`.
   * Other adapters ignore it.
   */
  permissionMode: PermissionMode;
  /** Claude Code only (`--effort`); null = the CLI's default. Other adapters ignore it. */
  effort: Effort | null;
  /**
   * The CLI's own session id from an earlier process (`Session.cliSessionId`) when this is a relaunch: Claude Code
   * gets `--resume <id>` so the conversation context survives a dead process. Null on the first launch.
   */
  resumeSessionId: string | null;
  /** Keep lanes current (ADR-0023): the lane's branch and the base it was cut from, for the system-prompt line. */
  lane?: {
    branch: string;
    base: string;
    /** The "other lanes right now" block (ADR-0025); '' when alone. */
    others?: string;
  };
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
 * - `app-server`: Codex `codex app-server`, JSON-RPC 2.0 over stdio (thread/start, turn/start, approvals as
 *   server requests). See docs/research/agent-parity.md.
 * - `acp`: the Agent Client Protocol over stdio (`gemini --acp`, `agent acp`): session/new, session/prompt,
 *   session/update, session/request_permission.
 */
export type StreamInput =
  { kind: 'stdin' } | { kind: 'argv'; resumeFlag: string } | { kind: 'app-server' } | { kind: 'acp' };

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

/** CLIs with no system-prompt flag: what Claude Code gets in `--append-system-prompt` goes ahead of their first turn. */
export const PREAMBLE_AGENTS: readonly Agent[] = ['codex', 'gemini', 'cursor'];

/**
 * The lines every agent should start with (ADR-0025): the shims, peers, the lane and the other lanes right now —
 * for `PREAMBLE_AGENTS`, sent as text ahead of the first message (or the next one, when the session starts blank).
 */
export const agentPreamble = (lane: AgentLaunchContext['lane']): string => {
  const parts: string[] = [copy.agentPrompt.preamble, copy.agentPrompt.shims, copy.agentPrompt.peers];
  if (lane) parts.push(fill(copy.agentPrompt.lane, { branch: lane.branch, base: lane.base }));
  if (lane?.others) parts.push(lane.others);
  return parts.join('\n\n');
};

/** The `styx` shim on PATH (absolute so MCP configs work regardless of the agent's own PATH handling). */
export const styxBin = (ctx: Pick<AgentLaunchContext, 'shimDir' | 'platform'>): string =>
  `${ctx.shimDir}${ctx.platform === 'win32' ? '\\styx.cmd' : '/styx'}`;

/**
 * MCP server entry every agent gets: `styx mcp` proxies the broker over stdio (plan §6). The env block (with the
 * session's broker token) belongs only in files under `<userData>/agents/<sessionId>` (Claude, Codex); config
 * written into the worktree (Gemini, Cursor) uses `styxMcpServerInherit` so the token never lands in the repo (L5).
 */
export const styxMcpServer = (
  ctx: AgentLaunchContext,
): { command: string; args: string[]; env: Record<string, string> } => ({
  ...mcpCommand(ctx),
  env: {
    STYX_SESSION_ID: ctx.env['STYX_SESSION_ID'] ?? '',
    STYX_BROKER: ctx.env['STYX_BROKER'] ?? '',
    STYX_TOKEN: ctx.env['STYX_TOKEN'] ?? '',
  },
});

/** Same entry without an env block: the CLI spawns MCP servers with its own (session) environment. */
export const styxMcpServerInherit = (ctx: AgentLaunchContext): { command: string; args: string[] } =>
  mcpCommand(ctx);

/**
 * How an agent starts `styx mcp`. On Windows the shim is a `.cmd`, which a plain spawn (most MCP clients) refuses to
 * start: it goes through `cmd.exe /d /c` (no `/s`, so a quoted path with spaces survives).
 */
const mcpCommand = (
  ctx: Pick<AgentLaunchContext, 'shimDir' | 'platform'>,
): { command: string; args: string[] } =>
  ctx.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/c', styxBin(ctx), 'mcp'] }
    : { command: styxBin(ctx), args: ['mcp'] };

/** Merges the styx server into an existing MCP config file; `restore()` puts the file back (or removes it). */
export async function writeWorktreeMcpConfig(
  file: string,
  ctx: AgentLaunchContext,
  io: {
    mkdir(dir: string): Promise<void>;
    read(file: string): Promise<string>;
    write(file: string, text: string): Promise<void>;
    remove(file: string): Promise<void>;
  },
  dir: string,
): Promise<{ restore(): Promise<void> }> {
  await io.mkdir(dir);
  let previous: string | null = null;
  let existing: Record<string, unknown> = {};
  try {
    previous = await io.read(file);
    existing = JSON.parse(previous) as Record<string, unknown>;
  } catch {
    previous = null;
    existing = {};
  }
  const mcpServers = {
    ...((existing['mcpServers'] as Record<string, unknown> | undefined) ?? {}),
    styx: styxMcpServerInherit(ctx),
  };
  await io.write(file, JSON.stringify({ ...existing, mcpServers }, null, 2));
  return {
    restore: async () => {
      if (previous === null) await io.remove(file);
      else await io.write(file, previous);
    },
  };
}
