import type { ReadModel, Session, SessionId } from '@styx/core';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { env, type BridgePlatform } from './bridge';
import { useReadModel } from './read-model';
import { selectSessionId, useUiStore, type UiStore } from './ui-store';

/**
 * Runs a core selector against the mirrored model. Recomputed when the model (or the selector identity)
 * changes; pass module-level selectors or `useCallback` ones to avoid per-render recomputation.
 */
export function useModel<T>(selector: (model: ReadModel) => T): T {
  const model = useReadModel((s) => s.model);
  return useMemo(() => selector(model), [model, selector]);
}

export function useUi<T>(selector: (ui: UiStore) => T): T {
  return useUiStore(selector);
}

/** Shallow-compared variant for selectors that return fresh objects/arrays. */
export function useUiShallow<T>(selector: (ui: UiStore) => T): T {
  return useUiStore(useShallow(selector));
}

export const useSessionId = (): SessionId | null => useUiStore(selectSessionId);

/**
 * Platform for user-facing words (`platformCopy`, `defaultProjectLocation`: Touch ID / Windows Hello, Keychain /
 * Credential Manager, `~/code` / `C:\dev`, the `mod` glyph in labels): follows the rendered chrome (`env.chrome`
 * override, else `ui.platform`), so win chrome never mixes mac copy (spec §7). Keyboard *handling* (metaKey vs
 * ctrlKey) and chord hints stay on `ui.platform` (discrepancy #21).
 */
export function useCopyPlatform(): BridgePlatform {
  const platform = useUiStore((u) => u.platform);
  const chrome = env().chrome;
  return chrome === 'mac' ? 'darwin' : chrome === 'win' ? 'win32' : platform;
}

const frozenNow = (): number | null => {
  const n = env().now;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Wall clock for selectors; frozen to `env.now` (STYX_NOW) when set, else ticks every `intervalMs`. */
export function useNow(intervalMs = 30_000): number {
  const frozen = frozenNow();
  const [now, setNow] = useState(() => frozen ?? Date.now());
  useEffect(() => {
    if (frozen !== null) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [frozen, intervalMs]);
  return frozen ?? now;
}

export function useSession(id: SessionId | null): Session | null {
  return useReadModel((s) => (id === null ? null : (s.model.sessions.byId[id] ?? null)));
}
