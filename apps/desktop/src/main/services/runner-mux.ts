import { EventEmitter } from 'node:events';
import type { ImageBlock } from './stream-runner';
import type { StreamInput } from '../agents/types';
import type { StreamEvents, StreamRunnerLike, StreamSpawnOptions } from './stream-runner';

/** A backend is a full `StreamRunnerLike` that also emits the shared `effect` / `exit` events. */
export type RunnerBackend = StreamRunnerLike & EventEmitter<StreamEvents>;

/**
 * One `stream` door for the session service, several protocols behind it (docs/research/agent-parity.md):
 * Claude Code's NDJSON (`stdin` / `argv`), Codex's JSON-RPC app-server (`app-server`) and the Agent Client
 * Protocol (`acp`). The session service keeps calling `stream.*` with a session id; the mux remembers which backend
 * spawned that id and forwards. Backends register once at container build time; a launch whose kind has no
 * backend fails loudly at spawn rather than silently falling back to a pty.
 */
export class RunnerMux extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  private readonly backends = new Map<StreamInput['kind'], RunnerBackend>();
  private readonly owner = new Map<string, RunnerBackend>();

  register(kinds: readonly StreamInput['kind'][], backend: RunnerBackend): this {
    for (const kind of kinds) this.backends.set(kind, backend);
    backend.on('effect', (id, effect) => this.emit('effect', id, effect));
    backend.on('exit', (id, exitCode) => {
      this.owner.delete(id);
      this.emit('exit', id, exitCode);
    });
    return this;
  }

  /** Which backend would take this launch; null when none is registered for its kind. */
  backendFor(kind: StreamInput['kind']): RunnerBackend | null {
    return this.backends.get(kind) ?? null;
  }

  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    const backend = this.backends.get(opts.input.kind);
    if (!backend) throw new Error(`no stream runner registered for '${opts.input.kind}'`);
    this.owner.set(opts.id, backend);
    try {
      return await backend.spawn(opts);
    } catch (e) {
      this.owner.delete(opts.id);
      throw e;
    }
  }

  send(id: string, text: string, blocks?: readonly ImageBlock[]): void {
    this.owner.get(id)?.send(id, text, blocks);
  }

  acceptsImages(id: string): boolean {
    const backend = this.owner.get(id);
    return backend?.acceptsImages?.(id) ?? false;
  }

  respondPermission(
    id: string,
    requestId: string,
    allow: boolean,
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.owner.get(id)?.respondPermission(id, requestId, allow, message, updatedInput);
  }

  setModel(id: string, model: string | null): void {
    this.owner.get(id)?.setModel(id, model);
  }

  setPermissionMode(id: string, mode: string): void {
    this.owner.get(id)?.setPermissionMode(id, mode);
  }

  setEffort(id: string, effort: string | null): void {
    this.owner.get(id)?.setEffort(id, effort);
  }

  interrupt(id: string): void {
    this.owner.get(id)?.interrupt(id);
  }

  kill(id: string): void {
    this.owner.get(id)?.kill(id);
  }

  has(id: string): boolean {
    return this.owner.has(id);
  }

  killAll(): void {
    for (const backend of new Set(this.backends.values())) backend.killAll();
  }
}
