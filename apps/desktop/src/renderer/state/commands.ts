import type { CommandInput, CommandName, CommandResult } from '@styx/core';
import { bridge } from './bridge';
import { useUiStore } from './ui-store';

const NOT_CONNECTED: CommandResult<CommandName> = {
  ok: false,
  error: { code: 'internal', message: 'Main process not connected' },
};

/**
 * Every mutation goes through here (CLAUDE.md: named commands only). Returns the CommandResult unchanged; an
 * `ok:false` result is logged and surfaced as an error toast so screens can stay optimistic.
 */
export const command = async <N extends CommandName>(
  name: N,
  input: CommandInput<N>,
): Promise<CommandResult<N>> => {
  const api = bridge();
  let result: CommandResult<N>;
  if (api?.command === undefined) {
    console.warn(`[styx] command ${name} dropped: main not connected`, input);
    result = NOT_CONNECTED as CommandResult<N>;
  } else {
    try {
      result = await api.command(name, input);
    } catch (err) {
      result = {
        ok: false,
        error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  if (!result.ok) {
    console.error(`[styx] ${name} failed: ${result.error.code} — ${result.error.message}`);
    if (api?.command !== undefined) {
      useUiStore.getState().pushOverlay({
        kind: 'toast',
        toast: { kind: 'error', code: result.error.code, message: result.error.message },
      });
    }
  }
  return result;
};
