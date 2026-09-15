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

/**
 * Codex CLI: `-c key=value` config overrides register the styx MCP server and the `notify` hook, and mark the
 * directory trusted so the TUI does not open on its "Do you trust the contents of this directory?" dialog — which
 * swallowed the first message and stalled every session started from Styx.
 *
 * VERIFIED 2026-09-15 against codex 0.154.0 (`codex mcp list` with the same overrides): `mcp_servers.<name>.command`,
 * `.args`, `.env_vars` (names forwarded from Codex's own env — Codex hands MCP servers a core env only, so without
 * this `styx mcp` never saw the broker and Codex reported "1 MCP startup issue"), `notify=[...]`, and
 * `projects."<path>".trust_level="trusted"` (the key Codex writes itself; for a git worktree Codex looks up the main
 * checkout root, so both paths are marked). Codex stays on the `pty` runner (ADR-0010): its `exec` mode has no
 * bidirectional stream, and the `notify` hook (`agent-turn-complete`) already drives idle detection through
 * `styx hook codex`.
 */
export async function codexLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const bin = styxBin(ctx);
  const args = [
    '-c',
    `mcp_servers.styx.command=${JSON.stringify(bin)}`,
    '-c',
    'mcp_servers.styx.args=["mcp"]',
    '-c',
    `mcp_servers.styx.env_vars=${JSON.stringify(MCP_ENV_VARS)}`,
    '-c',
    `notify=[${JSON.stringify(bin)},"hook","codex"]`,
  ];
  for (const path of new Set([ctx.worktreePath, ctx.projectPath])) {
    args.push('-c', `${codexTrustKey(path)}="trusted"`);
  }
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: async () => undefined };
}
