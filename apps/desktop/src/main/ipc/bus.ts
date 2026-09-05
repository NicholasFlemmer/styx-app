import {
  CHANNELS,
  commands,
  isCommandName,
  type CommandError as CommandErrorShape,
  type CommandInput,
  type CommandName,
  type CommandOutput,
  type CommandParsedInput,
  type CommandResult,
} from '@styx/core';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { logger } from '../services/logger';

export type CommandErrorCode = CommandErrorShape['code'];

/** Thrown by handlers/services to produce a typed `{ ok: false, error }` result. */
export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export function fail(code: CommandErrorCode, message: string, detail?: Record<string, unknown>): never {
  throw new CommandError(code, message, detail);
}

export interface CommandContext {
  senderId: number;
}

export type CommandHandler<N extends CommandName> = (
  input: CommandParsedInput<N>,
  ctx: CommandContext,
) => Promise<CommandOutput<N>> | CommandOutput<N>;

export interface SenderInfo {
  senderId: number;
  frameUrl: string | null;
}

export interface CommandBusDeps {
  /** Window registry check (WindowService / Publisher). */
  isRegistered: (senderId: number) => boolean;
  /** `file://` for the built renderer; the dev-server URL when set. */
  allowedOrigins: string[];
}

const toError = (e: unknown): CommandErrorShape => {
  if (e instanceof CommandError)
    return {
      code: e.code,
      message: e.message,
      ...(e.detail ? { detail: e.detail as CommandErrorShape['detail'] } : {}),
    };
  if (e instanceof z.ZodError) return { code: 'invalid-input', message: z.prettifyError(e) };
  const msg = e instanceof Error ? e.message : String(e);
  if (/^git /.test(msg)) return { code: 'git-error', message: msg };
  if (/ENOENT/.test(msg)) return { code: 'not-found', message: msg };
  return { code: 'internal', message: msg };
};

/**
 * The one command channel (`styx:cmd`). Validates the sender frame origin and window registry, rejects unknown
 * names before parsing, parses with the contract schema, and never throws across IPC (rules/ipc.md).
 */
export class CommandBus {
  private readonly handlers = new Map<CommandName, CommandHandler<CommandName>>();

  constructor(private readonly deps: CommandBusDeps) {}

  register<N extends CommandName>(name: N, handler: CommandHandler<N>): void {
    this.handlers.set(name, handler as unknown as CommandHandler<CommandName>);
  }

  has(name: CommandName): boolean {
    return this.handlers.has(name);
  }

  registered(): CommandName[] {
    return [...this.handlers.keys()];
  }

  originAllowed(url: string | null): boolean {
    if (url === null) return false;
    return this.deps.allowedOrigins.some((o) =>
      o === 'file://' ? url.startsWith('file://') : url.startsWith(o),
    );
  }

  dispatch<N extends CommandName>(sender: SenderInfo, name: N, input: CommandInput<N>): Promise<CommandResult<N>>;
  dispatch(sender: SenderInfo, name: unknown, input: unknown): Promise<CommandResult>;
  async dispatch(sender: SenderInfo, name: unknown, input: unknown): Promise<CommandResult> {
    if (!this.originAllowed(sender.frameUrl) || !this.deps.isRegistered(sender.senderId)) {
      logger.warn('ipc: rejected sender', { senderId: sender.senderId, frameUrl: sender.frameUrl, name });
      return { ok: false, error: { code: 'forbidden', message: 'sender is not a registered Styx window' } };
    }
    if (typeof name !== 'string' || !isCommandName(name)) {
      return { ok: false, error: { code: 'invalid-input', message: `unknown command ${String(name)}` } };
    }
    const handler = this.handlers.get(name);
    if (!handler)
      return { ok: false, error: { code: 'internal', message: `no handler registered for ${name}` } };
    const parsed = commands[name].input.safeParse(input ?? {});
    if (!parsed.success)
      return { ok: false, error: { code: 'invalid-input', message: z.prettifyError(parsed.error) } };
    try {
      const value = await handler(parsed.data as never, { senderId: sender.senderId });
      return { ok: true, value } as CommandResult;
    } catch (e) {
      const error = toError(e);
      logger.warn(`ipc: ${name} failed`, { code: error.code, message: error.message });
      return { ok: false, error };
    }
  }

  /**
   * Main-process-originated dispatch (boot-time discovery refresh, protocol handlers): skips the sender-frame check
   * because there is no renderer sender, but still validates the command name and input against the contract.
   */
  dispatchInternal<N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandResult<N>>;
  async dispatchInternal(name: unknown, input: unknown): Promise<CommandResult> {
    if (typeof name !== 'string' || !isCommandName(name)) {
      return { ok: false, error: { code: 'invalid-input', message: `unknown command ${String(name)}` } };
    }
    const handler = this.handlers.get(name);
    if (!handler)
      return { ok: false, error: { code: 'internal', message: `no handler registered for ${name}` } };
    const parsed = commands[name].input.safeParse(input ?? {});
    if (!parsed.success)
      return { ok: false, error: { code: 'invalid-input', message: z.prettifyError(parsed.error) } };
    try {
      const value = await handler(parsed.data as never, { senderId: -1 });
      return { ok: true, value } as CommandResult;
    } catch (e) {
      const error = toError(e);
      logger.warn(`ipc(internal): ${name} failed`, { code: error.code, message: error.message });
      return { ok: false, error };
    }
  }

  attach(ipcMain: IpcMain): void {
    ipcMain.handle(CHANNELS.command, (event: IpcMainInvokeEvent, name: unknown, input: unknown) =>
      this.dispatch({ senderId: event.sender.id, frameUrl: event.senderFrame?.url ?? null }, name, input),
    );
  }
}
