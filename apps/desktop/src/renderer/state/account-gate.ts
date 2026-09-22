import { addingProjectNeedsAccount } from '@styx/core';
import { useReadModel } from './read-model';
import { useUiStore } from './ui-store';

/**
 * The one place that decides whether adding a project asks for an account (owner request, discrepancy row 113):
 * Styx is free for one project, and a second is where signing in starts to pay for itself.
 *
 * Every route that adds a project goes through here — the rail's `+`, Home's add row, the palette's four
 * project rows — so the rule cannot be true in one corner of the app and false in another. Main refuses the
 * same three commands as a backstop; this exists so the answer is a sign-in dialog rather than an error toast.
 *
 * Returns true when the caller should carry on.
 */
export const guardAddProject = (): boolean => {
  if (!addingProjectNeedsAccount(useReadModel.getState().model)) return true;
  useUiStore.getState().pushOverlay({ kind: 'modal', modal: 'sign-in', reason: 'second-project' });
  return false;
};
