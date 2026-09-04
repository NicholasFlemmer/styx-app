import type { AgentLaunch, AgentLaunchContext } from './types';

/** Plain login shell: shims on PATH + `styx request/status/targets`; the first message is typed as a command. */
export async function shellLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  return { command: ctx.binary, args: ctx.platform === 'win32' ? [] : ['-il'], env: {}, typeFirstMessage: true, cleanup: async () => undefined };
}
