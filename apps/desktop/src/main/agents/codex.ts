import { styxBin, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * Codex CLI: `-c key=value` config overrides register the styx MCP server and the `notify` hook.
 * UNVERIFIED FLAGS: `-c mcp_servers.<name>.command/args` and `-c notify=[...]` follow the documented
 * config.toml keys; confirm the CLI accepts them as overrides in the Phase 8 spike (fallback: per-session CODEX_HOME).
 */
export async function codexLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const bin = styxBin(ctx);
  const args = ['-c', `mcp_servers.styx.command=${JSON.stringify(bin)}`, '-c', 'mcp_servers.styx.args=["mcp"]', '-c', `notify=[${JSON.stringify(bin)},"hook","codex"]`];
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: async () => undefined };
}
