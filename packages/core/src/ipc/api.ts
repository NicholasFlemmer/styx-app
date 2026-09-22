import type {
  CommandInput,
  CommandName,
  CommandResult,
  EventName,
  EventPayload,
  ReadModelSnapshot,
} from './contract';
import type { DeltaBatch } from '../deltas';

/** Dev/e2e switches passed from main to the renderer (never secrets). */
export interface StyxEnv {
  fixture?: string;
  screen?: string;
  theme?: 'dark' | 'light' | 'system';
  chrome?: 'mac' | 'win';
  now?: number;
  e2e?: boolean;
}

/**
 * The exact surface preload exposes as `window.styx` (contextBridge). Main validates every command with the
 * contract schema and returns a CommandResult; state arrives via snapshot + seq-numbered delta batches.
 */
export interface StyxApi {
  platform: 'darwin' | 'win32' | 'linux';
  env: StyxEnv;
  /** Which window this renderer runs in. */
  window: {
    kind: 'main' | 'popout' | 'dock';
    popoutSessionId: string | null;
    control(action: 'minimize' | 'maximize' | 'close'): void;
  };
  command<N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandResult<N>>;
  snapshot(): Promise<ReadModelSnapshot>;
  onDelta(cb: (batch: DeltaBatch) => void): () => void;
  onEvent<E extends EventName>(name: E, cb: (payload: EventPayload<E>) => void): () => void;
  pty: {
    /** `seq` numbers each batch per pty (1, 2, …); a late-attached terminal uses it to skip what its backlog covered. */
    onData(cb: (id: string, data: string, seq: number) => void): () => void;
    onExit(cb: (id: string, exitCode: number | null) => void): () => void;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
  theme: { resolved(): Promise<'dark' | 'light'>; onResolved(cb: (t: 'dark' | 'light') => void): () => void };
}
