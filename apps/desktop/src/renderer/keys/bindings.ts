import {
  copy,
  fill,
  headAskOf,
  joinScopes,
  sessionTabs,
  type Grant,
  type ReadModel,
  type SessionId,
  type ThemePreference,
} from '@styx/core';
import { shortcuts } from '@styx/tokens';
import { announce } from '../app/announcer';
import { escapeTarget, findOverlay } from '../overlays/stack';
import { command } from '../state/commands';
import { useReadModel } from '../state/read-model';
import { selectSessionId, useUiStore } from '../state/ui-store';
import { nextPermissionMode, sessionControls } from '../features/chat/session-controls';
import type { KeyBinding } from './registry';

const THEME_CYCLE: Record<ThemePreference, ThemePreference> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};

const model = (): ReadModel => useReadModel.getState().model;

/** The grant behind the head ask of the active session, when that ask is a grant request. */
export const pendingGrantOfActiveSession = (): Grant | null => {
  const ui = useUiStore.getState();
  const sessionId = selectSessionId(ui);
  if (sessionId === null) return null;
  const ask = headAskOf(model(), sessionId);
  if (ask === null || ask.kind !== 'grant' || ask.grantId === null) return null;
  return model().grants.byId[ask.grantId] ?? null;
};

const focusAgent = (n: number): boolean => {
  const ui = useUiStore.getState();
  if (ui.projectId === null) return false;
  const tabs = sessionTabs(model(), ui.projectId, selectSessionId(ui));
  const all = [...tabs.visible, ...tabs.overflow];
  const tab = all[n - 1];
  if (tab === undefined) return false;
  ui.setSession(ui.projectId, tab.sessionId);
  return true;
};

/**
 * Approves `grant` as requested (its own scope, 1h) and announces the result (spec §9). Shared by the chat /
 * workspace Mod+⏎ chord and the Agents board cards.
 */
export const approveGrantAsRequested = (grant: Grant): void => {
  const m = model();
  const target = m.targets.byId[grant.targetId];
  const session = grant.sessionId === null ? undefined : m.sessions.byId[grant.sessionId];
  const duration = '1h';
  void command('grant.approve', { grantId: grant.id, duration, scope: [...grant.scope] }).then((r) => {
    if (!r.ok || target === undefined) return;
    announce(
      fill(copy.grantResult.announce, {
        agent: session === undefined ? copy.general.none : copy.agents[session.agent],
        scopes: joinScopes(grant.scope, ', '),
        target: `${target.name} ${target.env}`,
        duration: '1 hour',
      }),
    );
  });
};

const approvePending = (): boolean => {
  const grant = pendingGrantOfActiveSession();
  if (grant === null) return false;
  approveGrantAsRequested(grant);
  return true;
};

const denyPending = (): boolean => {
  const grant = pendingGrantOfActiveSession();
  if (grant === null) return false;
  void command('grant.deny', { grantId: grant.id });
  return true;
};

const popoutOrDock = (): boolean => {
  const ui = useUiStore.getState();
  const sessionId = selectSessionId(ui);
  if (sessionId === null) return false;
  const popped = model().popouts.includes(sessionId);
  void command(popped ? 'window.dock' : 'window.popout', { sessionId });
  return true;
};

const spawn = (): boolean => {
  const ui = useUiStore.getState();
  if (ui.projectId === null) return false;
  ui.pushOverlay({ kind: 'modal', modal: 'spawn', projectId: ui.projectId });
  return true;
};

/** Esc pops the topmost trapping overlay (sheet / drawer / modal / palette) before any toast. */
const closeTopmost = (): boolean => {
  const ui = useUiStore.getState();
  const target = escapeTarget(ui.overlays);
  if (target === null) return false;
  ui.popOverlay(target.id);
  return true;
};

const cycleTheme = (): boolean => {
  const next = THEME_CYCLE[model().settings.app.theme];
  void command('settings.set', { patch: { theme: next } });
  return true;
};

const activeSessionId = (): SessionId | null => selectSessionId(useUiStore.getState());

/**
 * Composer-scoped Claude Code parity keys (discrepancy #54): Esc interrupts the current turn while the session
 * is working (overlays still close first: `overlay` resolves before `composer`), ⇧⇥ cycles the permission mode
 * default → acceptEdits → plan. Both decline (`false`) when the session has no such control, so the key falls
 * through to the textarea.
 */
export const composerBindings = (sessionOf: () => SessionId | null): KeyBinding[] => [
  {
    id: 'interrupt',
    chord: 'Escape',
    scope: 'composer',
    run: () => {
      const sessionId = sessionOf();
      const session = sessionId === null ? undefined : model().sessions.byId[sessionId];
      if (session === undefined || !sessionControls(session).stop) return false;
      void command('session.interrupt', { sessionId: session.id });
      return true;
    },
  },
  {
    id: 'cycleMode',
    chord: 'Shift+Tab',
    scope: 'composer',
    run: () => {
      const sessionId = sessionOf();
      const session = sessionId === null ? undefined : model().sessions.byId[sessionId];
      if (session === undefined || !sessionControls(session).mode) return false;
      void command('session.configure', {
        sessionId: session.id,
        permissionMode: nextPermissionMode(session.permissionMode),
      });
      return true;
    },
  },
];

/** Spec §6 bindings; diff keys are registered by the Diff screen in scope `diff` (see `diffBindings`). */
export const shellBindings = (): KeyBinding[] => [
  {
    id: 'palette',
    chord: shortcuts.palette,
    scope: 'global',
    run: () => useUiStore.getState().togglePalette(),
  },
  {
    id: 'switchProject',
    chord: shortcuts.switchProject,
    scope: 'global',
    run: () => useUiStore.getState().openPalette('projects'),
  },
  ...shortcuts.focusAgent.map((chord, i): KeyBinding => ({
    id: `focusAgent:${i + 1}`,
    chord,
    scope: 'workspace',
    when: () => useUiStore.getState().screen === 'workspace',
    run: () => focusAgent(i + 1),
  })),
  // Focus-agent also works from global while the Workspace screen is shown (focus may sit on body).
  ...shortcuts.focusAgent.map((chord, i): KeyBinding => ({
    id: `focusAgent:global:${i + 1}`,
    chord,
    scope: 'global',
    when: () => useUiStore.getState().screen === 'workspace',
    run: () => focusAgent(i + 1),
  })),
  { id: 'popoutChat', chord: shortcuts.popoutChat, scope: 'workspace', run: popoutOrDock },
  {
    id: 'popoutChat:global',
    chord: shortcuts.popoutChat,
    scope: 'global',
    when: () => useUiStore.getState().screen === 'workspace',
    run: popoutOrDock,
  },
  { id: 'spawnAgent', chord: shortcuts.spawnAgent, scope: 'global', run: spawn },
  {
    id: 'approve',
    chord: shortcuts.approve,
    scope: 'chat',
    when: () => findOverlay(useUiStore.getState().overlays, 'sheet') === null,
    run: approvePending,
  },
  {
    id: 'deny',
    chord: shortcuts.deny,
    scope: 'chat',
    when: () => findOverlay(useUiStore.getState().overlays, 'sheet') === null,
    run: denyPending,
  },
  {
    id: 'approve:workspace',
    chord: shortcuts.approve,
    scope: 'workspace',
    when: () => findOverlay(useUiStore.getState().overlays, 'sheet') === null,
    run: approvePending,
  },
  {
    id: 'deny:workspace',
    chord: shortcuts.deny,
    scope: 'workspace',
    when: () => findOverlay(useUiStore.getState().overlays, 'sheet') === null,
    run: denyPending,
  },
  { id: 'toggleTheme', chord: shortcuts.toggleTheme, scope: 'global', run: cycleTheme },
  {
    id: 'close',
    chord: shortcuts.close,
    scope: 'overlay',
    when: () => escapeTarget(useUiStore.getState().overlays) !== null,
    run: closeTopmost,
  },
  {
    id: 'close:palette',
    chord: shortcuts.close,
    scope: 'palette',
    when: () => escapeTarget(useUiStore.getState().overlays) !== null,
    run: closeTopmost,
  },
  ...composerBindings(activeSessionId),
];

/**
 * Pop-out chat window (spec §4.13): its own registry with `composer` + `global` only. No palette (Mod+K / Mod+P
 * belong to the main window), no overlay close (Esc does nothing), Mod+Shift+O docks the window back.
 */
export const popoutBindings = (sessionId: SessionId): KeyBinding[] => [
  {
    id: 'dock',
    chord: shortcuts.popoutChat,
    scope: 'global',
    run: () => {
      void command('window.dock', { sessionId });
    },
  },
  { id: 'toggleTheme', chord: shortcuts.toggleTheme, scope: 'global', run: cycleTheme },
  ...composerBindings(() => sessionId),
];

export interface DiffActions {
  accept: () => void;
  reject: () => void;
  next: () => void;
  prev: () => void;
  done: () => void;
}

/** a r j k Mod+Enter, only in scope `diff` (spec §6). */
export const diffBindings = (actions: DiffActions): KeyBinding[] => [
  { id: 'diffAccept', chord: shortcuts.diffAccept, scope: 'diff', run: actions.accept },
  { id: 'diffReject', chord: shortcuts.diffReject, scope: 'diff', run: actions.reject },
  { id: 'diffNext', chord: shortcuts.diffNext, scope: 'diff', run: actions.next },
  { id: 'diffPrev', chord: shortcuts.diffPrev, scope: 'diff', run: actions.prev },
  { id: 'diffDone', chord: shortcuts.diffDone, scope: 'diff', run: actions.done },
];

export interface BoardActions {
  /** Mod+⏎ on the focused needs-you card: approve the grant as requested / run the card's CTA. */
  approve: () => void | boolean;
  /** Mod+⌫ on the focused needs-you card: deny the grant / reject the plan. */
  deny: () => void | boolean;
}

/** Spec §6: approve / deny also fire on a focused Agents board card (scope `board`). */
export const boardBindings = (actions: BoardActions): KeyBinding[] => [
  { id: 'boardApprove', chord: shortcuts.approve, scope: 'board', run: actions.approve },
  { id: 'boardDeny', chord: shortcuts.deny, scope: 'board', run: actions.deny },
];
