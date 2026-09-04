import type { PaletteAction } from '@styx/core';
import { invokerOf, rememberInvoker } from '../../overlays/stack';
import { command } from '../../state/commands';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';

export interface RunOptions {
  /** Mod+⏎: open agents in a new (pop-out) window. */
  newWindow: boolean;
  /** The palette overlay id; its invoker is handed to any overlay the action opens. */
  paletteId: string;
}

/** Executes a palette row (spec §5 verbs). Closes the palette first so focus return chains correctly. */
export const runPaletteAction = (action: PaletteAction, opts: RunOptions): void => {
  const ui = useUiStore.getState();
  const model = useReadModel.getState().model;
  const invoker = invokerOf(opts.paletteId);
  ui.popOverlay(opts.paletteId);
  const open = (overlay: Parameters<typeof ui.pushOverlay>[0]) => {
    const id = ui.pushOverlay(overlay);
    if (invoker !== null) rememberInvoker(id, invoker);
  };

  switch (action.kind) {
    case 'switch-project': {
      ui.setProject(action.projectId);
      if (ui.screen === 'home' || ui.screen === 'onboarding') ui.setScreen('workspace');
      void command('project.select', { projectId: action.projectId });
      return;
    }
    case 'spawn':
      open({ kind: 'modal', modal: 'spawn', projectId: action.projectId });
      return;
    case 'new-project':
      open({ kind: 'modal', modal: 'new-project' });
      return;
    case 'open-session': {
      const session = model.sessions.byId[action.sessionId];
      if (session === undefined) return;
      if (opts.newWindow) {
        void command('window.popout', { sessionId: session.id });
        return;
      }
      ui.openSession(session.projectId, session.id);
      return;
    }
    case 'review-ask': {
      const session = model.sessions.byId[action.sessionId];
      if (session === undefined) return;
      if (opts.newWindow) {
        void command('window.popout', { sessionId: session.id });
        return;
      }
      ui.openSession(session.projectId, session.id);
      open({ kind: 'sheet', sheet: 'grant', sessionId: session.id, askId: action.askId });
      return;
    }
    case 'deploy': {
      // Deploy flow lands with the grant sheet (Phase 6); route to the project's workspace for now.
      ui.setProject(action.projectId);
      ui.setScreen('workspace');
      return;
    }
  }
};
