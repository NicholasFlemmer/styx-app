import { isDeployableTarget, type PaletteAction } from '@styx/core';
import { forgetInvoker, invokerOf, rememberInvoker } from '../../overlays/stack';
import { command } from '../../state/commands';
import { openTour } from '../tour/open-tour';
import { startLearnDeploy } from '../abilities/learn';
import { startDebtAudit } from '../audit';
import { openFolderAsProject } from '../../state/project-entry';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { openArcade } from '../arcade/ArcadePanel';
import { guardAddProject } from '../../state/account-gate';

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
  // The game is not an overlay, so nothing goes inert under it: the palette's own focus return (next frame)
  // would take focus off the board just after it took it. The board hands focus back itself, on quit.
  if (action.kind === 'arcade') forgetInvoker(opts.paletteId);
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
    // New task in the workspace (ADR-0027 §1): "Spawn agent in …" opens it empty, "Start … as a task" with the words.
    case 'spawn':
      ui.openNewTask(action.projectId);
      return;
    case 'new-task':
      ui.openNewTask(action.projectId, action.text);
      return;
    // The four routes that add a project: free for one, a second asks for an account (discrepancy row 113).
    case 'new-project':
      if (guardAddProject()) open({ kind: 'modal', modal: 'new-project' });
      return;
    case 'add-existing':
      if (guardAddProject()) open({ kind: 'modal', modal: 'add-existing' });
      return;
    case 'open-folder':
      if (guardAddProject()) void openFolderAsProject();
      return;
    case 'clone-url':
      if (guardAddProject()) open({ kind: 'modal', modal: 'new-project', mode: 'clone' });
      return;
    case 'agent-dock':
      void command('window.agentDock', { open: true });
      return;
    case 'feedback':
      open({ kind: 'modal', modal: 'feedback' });
      return;
    case 'tour':
      openTour();
      return;
    case 'debt-audit': {
      const projectId = action.projectId;
      void startDebtAudit(model, projectId);
      return;
    }
    case 'publish':
      ui.setProject(action.projectId);
      open({ kind: 'modal', modal: 'publish', worktreeId: action.worktreeId });
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
    case 'reopen-session': {
      const session = model.sessions.byId[action.sessionId];
      if (session === undefined) return;
      void command('session.reopen', { sessionId: session.id }).then((r) => {
        if (r.ok) ui.openSession(session.projectId, session.id);
      });
      return;
    }
    case 'arcade':
      // Snake in the project's chat pane (discrepancy row 110); Esc / ✕ on the board hands focus back here.
      ui.setProject(action.projectId);
      if (ui.screen !== 'workspace') ui.setScreen('workspace');
      openArcade(action.projectId, invoker);
      return;
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
      // This row is the palette's default selection, so ⌘K then Enter used to run a no-op.
      ui.setProject(action.projectId);
      const target = model.targets.byId[action.targetId];
      // No command for this target yet: the agent works the first deploy out and teaches Styx (AI-native).
      if (target !== undefined && !isDeployableTarget(target)) {
        void startLearnDeploy(model, target);
        return;
      }
      open({ kind: 'modal', modal: 'deploy', targetId: action.targetId });
      return;
    }
  }
};
