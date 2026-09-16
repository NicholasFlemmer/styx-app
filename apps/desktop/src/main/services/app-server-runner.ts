import { EventEmitter } from 'node:events';
import type { ImageBlock, StreamEvents, StreamRunnerLike, StreamSpawnOptions } from './stream-runner';

/**
 * Stream backend for Codex `codex app-server` (JSON-RPC 2.0 over stdio): registered on the RunnerMux for `app-server` launches.
 * Placeholder until the runner lands (docs/research/agent-parity.md): a spawn fails loudly, which the session
 * service turns into a paused session with the CLI-missing banner rather than a silent pty fallback.
 */
export class AppServerRunner extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    throw new Error(`app-server runner not available for ${opts.command}`);
  }
  send(_id: string, _text: string, _blocks?: readonly ImageBlock[]): void {}
  respondPermission(): void {}
  setModel(): void {}
  setPermissionMode(): void {}
  setEffort(): void {}
  interrupt(): void {}
  kill(): void {}
  has(): boolean {
    return false;
  }
  killAll(): void {}
}
