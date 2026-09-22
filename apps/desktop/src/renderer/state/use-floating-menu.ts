import { useEffect } from 'react';
import { useUiStore } from './ui-store';

/**
 * Tells the ui store while a floating DOM menu is open (the Deploy picker, the rail +, the session overflow), so
 * the design window's native view leaves the screen for it, as it does for overlays. Balanced on unmount.
 */
export const useFloatingMenu = (open: boolean): void => {
  useEffect(() => {
    if (!open) return;
    const { floatingMenu } = useUiStore.getState();
    floatingMenu(1);
    return () => floatingMenu(-1);
  }, [open]);
};
