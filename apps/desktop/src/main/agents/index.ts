import { claudeLaunch } from './claude';
import { codexLaunch } from './codex';
import { cursorLaunch } from './cursor';
import { geminiLaunch } from './gemini';
import { opencodeLaunch } from './opencode';
import { shellLaunch } from './shell';
import type { AgentLaunch, AgentLaunchContext } from './types';

export * from './types';
export { gitExcludeFile, excludeLocally } from './git-exclude';

/**
 * Per-agent argv + MCP/hook config injection (plan §6). Claude Code flags were verified against the installed CLI
 * (see claude.ts); codex/gemini/cursor adapters carry an UNVERIFIED note because those CLIs were not installed on the
 * verifying machine. OpenCode's ACP launch was checked against a real install (see opencode.ts).
 */
export function buildAgentLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  switch (ctx.agent) {
    case 'claude':
      return claudeLaunch(ctx);
    case 'codex':
      return codexLaunch(ctx);
    case 'gemini':
      return geminiLaunch(ctx);
    case 'cursor':
      return cursorLaunch(ctx);
    case 'opencode':
      return opencodeLaunch(ctx);
    case 'shell':
      return shellLaunch(ctx);
  }
}
