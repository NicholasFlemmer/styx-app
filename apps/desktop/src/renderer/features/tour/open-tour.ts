import { useUiStore } from '../../state/ui-store';

/**
 * Plays the walkthrough from wherever it was asked for (palette, Settings, the Help menu). It starts on Home,
 * where its first cards point, and goes back to the screen it was opened from when it ends.
 */
export const openTour = (): void => {
  const ui = useUiStore.getState();
  ui.setTourOpen(true);
};
