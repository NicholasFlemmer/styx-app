import { headAskOf, liveSessions, rows } from '@styx/core';
import { useEffect } from 'react';
import { keys, shellBindings } from '../keys';
import { bridge, chromePlatform, env } from '../state/bridge';
import { useUi } from '../state/hooks';
import { useReadModel } from '../state/read-model';
import { connectSync } from '../state/sync';
import { useUiStore } from '../state/ui-store';
import { ANNOUNCER_ID } from './announcer';
import { OverlayHost } from './OverlayHost';
import { Shell } from './Shell';

/** `env.theme` (STYX_THEME) forces a theme; otherwise main's resolved theme drives `data-theme`. */
export function useThemeController(): void {
  const resolved = useUi((u) => u.resolvedTheme);
  const setResolvedTheme = useUi((u) => u.setResolvedTheme);
  useEffect(() => {
    const api = bridge()?.theme;
    if (api === undefined) return;
    let off = () => {};
    let cancelled = false;
    void api.resolved().then((t) => {
      if (cancelled) return;
      setResolvedTheme(t);
      off = api.onResolved(setResolvedTheme);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [setResolvedTheme]);
  useEffect(() => {
    const override = env().theme;
    document.documentElement.dataset['theme'] =
      override === 'dark' || override === 'light' ? override : resolved;
  }, [resolved]);
}

export function usePlatformAttr(): void {
  useEffect(() => {
    document.documentElement.dataset['platform'] = chromePlatform();
  }, []);
}

/** Opens the overlay a visual-harness state name asks for (`STYX_SCREEN=palette|spawn|new-project|workspace-sheet|toast|approvals-audit`). */
const applyEnvState = (): void => {
  const state = env().screen;
  const ui = useUiStore.getState();
  const model = useReadModel.getState().model;
  switch (state) {
    case 'palette':
      ui.openPalette('all');
      return;
    case 'spawn':
      if (ui.projectId !== null) ui.pushOverlay({ kind: 'modal', modal: 'spawn', projectId: ui.projectId });
      return;
    case 'new-project':
      ui.pushOverlay({ kind: 'modal', modal: 'new-project' });
      return;
    case 'connect':
      if (ui.projectId !== null) ui.pushOverlay({ kind: 'modal', modal: 'connect', projectId: ui.projectId });
      return;
    case 'workspace-sheet':
    case 'toast': {
      const session = liveSessions(model).find(
        (x) => x.state === 'needs-you' && headAskOf(model, x.id)?.kind === 'grant',
      );
      const ask = session === undefined ? null : headAskOf(model, session.id);
      if (session === undefined || ask === null) return;
      if (state === 'toast') {
        ui.pushOverlay({
          kind: 'toast',
          toast: { kind: 'ask', askId: ask.id, sessionId: session.id, projectId: session.projectId },
        });
      } else {
        ui.openSession(session.projectId, session.id);
        ui.pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId: session.id, askId: ask.id });
      }
      return;
    }
    case 'approvals-audit': {
      const entry = rows(model.auditEntries)[0];
      if (entry !== undefined) ui.pushOverlay({ kind: 'drawer', drawer: 'audit', auditId: entry.id });
      return;
    }
    default:
      return;
  }
};

export function AppRoot() {
  useThemeController();
  usePlatformAttr();
  const connection = useReadModel((s) => s.connection);

  useEffect(() => connectSync(), []);
  useEffect(() => keys.registerAll(shellBindings()), []);
  useEffect(() => keys.install(window), []);
  useEffect(() => {
    if (connection === 'connecting') return;
    applyEnvState();
    // Runs once per hydration: env state is a launch switch, not live state.
  }, [connection]);

  return (
    <>
      <Shell />
      <OverlayHost />
      <div id={ANNOUNCER_ID} className="visually-hidden" aria-live="polite" aria-atomic="true" />
    </>
  );
}
