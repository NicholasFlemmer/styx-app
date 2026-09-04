import { claudeLaunch } from './claude';
import { codexLaunch } from './codex';
import { cursorLaunch } from './cursor';
import { geminiLaunch } from './gemini';
import { shellLaunch } from './shell';
import type { AgentLaunch, AgentLaunchContext } from './types';

export * from './types';
export { gitExcludeFile, excludeLocally } from './git-exclude';

/** Per-agent argv + MCP/hook config injection (plan §6). Each adapter stays small; flags marked UNVERIFIED are confirmed in the Phase 8 spike. */
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
    case 'shell':
      return shellLaunch(ctx);
  }
}
