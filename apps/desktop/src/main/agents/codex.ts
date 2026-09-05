import { styxBin, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * Codex CLI: `-c key=value` config overrides register the styx MCP server and the `notify` hook.
 *
 * UNVERIFIED (2026-09-04): `codex` is not installed on the verifying machine, so `-c mcp_servers.<name>.command/args`,
 * `-c notify=[...]` and `-m <model>` could not be checked with `--help`; they follow the documented config.toml keys
 * (fallback if rejected: a per-session CODEX_HOME with a generated config.toml). Codex stays on the `pty` runner
 * (ADR-0010): its `exec` mode has no bidirectional stream, and the `notify` hook (`agent-turn-complete`) already
 * drives idle detection through `styx hook codex`.
 */
export async function codexLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const bin = styxBin(ctx);
  const args = ['-c', `mcp_servers.styx.command=${JSON.stringify(bin)}`, '-c', 'mcp_servers.styx.args=["mcp"]', '-c', `notify=[${JSON.stringify(bin)},"hook","codex"]`];
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: async () => undefined };
}
