import type { EventName, EventPayload, StyxApi, StyxEnv } from '@styx/core';

/**
 * The one place the renderer touches `window.styx`. Typed against the core `StyxApi` contract so the renderer
 * compiles regardless of which preload build is loaded; every accessor tolerates a missing method so `pnpm dev`
 * works before main lands (see `state/sync.ts` for the fixture fallback).
 */
type StyxWindow = { styx?: Partial<StyxApi> };

const noop = (): void => {};

export const bridge = (): Partial<StyxApi> | null => {
  if (typeof window === 'undefined') return null;
  // Single cast site: the preload `index.d.ts` declares `window.styx` with the preload's own type.
  const w = window as unknown as StyxWindow;
  return w.styx ?? null;
};

export type BridgePlatform = 'darwin' | 'win32';

/** Keyboard platform: Mod = ⌘ on darwin, Ctrl elsewhere (linux keys like win32). */
export const platform = (): BridgePlatform => (bridge()?.platform === 'darwin' ? 'darwin' : 'win32');

export const env = (): StyxEnv => bridge()?.env ?? {};

/** Visual chrome: `env.chrome` overrides the OS (visual harness renders both on one machine). */
export const chromePlatform = (): BridgePlatform => {
  const chrome = env().chrome;
  if (chrome === 'mac') return 'darwin';
  if (chrome === 'win') return 'win32';
  return platform();
};

export const windowKind = (): 'main' | 'popout' => bridge()?.window?.kind ?? 'main';

export const popoutSessionId = (): string | null => bridge()?.window?.popoutSessionId ?? null;

export const onEvent = <E extends EventName>(
  name: E,
  cb: (payload: EventPayload<E>) => void,
): (() => void) => {
  const on = bridge()?.onEvent;
  return on ? on(name, cb) : noop;
};

export const hasSnapshot = (): boolean => typeof bridge()?.snapshot === 'function';
