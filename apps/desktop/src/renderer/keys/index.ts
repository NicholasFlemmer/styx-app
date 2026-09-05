import { platform } from '../state/bridge';
import { useUiStore } from '../state/ui-store';
import { KeyRegistry } from './registry';

export { KeyRegistry } from './registry';
export type { KeyBinding, KeyContext } from './registry';
export * from './scopes';
export { shellBindings, diffBindings, popoutBindings } from './bindings';
export type { DiffActions } from './bindings';

/** The app-wide registry; `AppRoot` installs it once. */
export const keys = new KeyRegistry({
  platform,
  overlayOpen: () => useUiStore.getState().overlays.length > 0,
});
