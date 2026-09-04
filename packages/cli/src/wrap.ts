import { spawn } from 'node:child_process';
import { BrokerClient } from '@styx/broker';
import { resolveRealBinary } from './path-resolve';

export interface WrapIo {
  env: NodeJS.ProcessEnv;
  stderr: (s: string) => void;
  spawn?: typeof spawn;
}

/**
 * Provider shim: `styx wrap <tool> [argv…]`. Asks the broker to authorize the command (which may prompt the user),
 * then execs the real tool with the grant's credentials injected, and reports the exit code for the audit log.
 */
export async function wrap(tool: string, argv: string[], io: WrapIo): Promise<number> {
  const real = resolveRealBinary(tool, io.env);
  if (!real) {
    io.stderr(`styx: ${tool} is not installed (not found on PATH).\n`);
    return 127;
  }
  let extraEnv: Record<string, string> = {};
  let useId: string | null = null;
  let client: BrokerClient | null = null;
  if (io.env['STYX_BROKER'] && io.env['STYX_SESSION_ID'] && io.env['STYX_TOKEN']) {
    try {
      client = BrokerClient.fromEnv('shim', io.env);
      await client.connect();
      const auth = await client.call('exec_authorize', { tool, argv, cwd: process.cwd() }, { timeoutMs: 600_000 });
      extraEnv = auth.env;
      useId = auth.useId;
    } catch (e) {
      io.stderr(`styx: access to ${tool} was not granted: ${(e as Error).message}\n`);
      client?.close();
      return 77; // EX_NOPERM
    }
  }
  const code = await new Promise<number>((resolve) => {
    const child = (io.spawn ?? spawn)(real, argv, { stdio: 'inherit', env: { ...io.env, ...extraEnv } });
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
    child.on('error', (err) => {
      io.stderr(`styx: failed to start ${real}: ${err.message}\n`);
      resolve(126);
    });
  });
  if (client && useId) {
    try {
      await client.call('exec_report', { useId, exitCode: code });
    } catch {
      /* best effort */
    }
    client.close();
  }
  return code;
}
