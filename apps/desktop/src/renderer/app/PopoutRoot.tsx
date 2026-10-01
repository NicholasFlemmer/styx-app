import { branchOf, copy, idFrom, projectNameOf, type SessionId } from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect, useMemo } from 'react';
import { ChatPane } from '../features/chat/ChatPane';
import { KeyRegistry, popoutBindings } from '../keys';
import { chromePlatform, platform, popoutSessionId } from '../state/bridge';
import { command } from '../state/commands';
import { useModel, useSession } from '../state/hooks';
import { useReadModel } from '../state/read-model';
import { connectSync } from '../state/sync';
import { useUiStore } from '../state/ui-store';
import { ANNOUNCER_ID } from './announcer';
import { useThemeController, usePlatformAttr } from './AppRoot';
import { OverlayHost } from './OverlayHost';
import s from './PopoutRoot.module.css';

/**
 * Pop-out chat window (spec §4.13, 400×500): own 32px titlebar (platform chrome, agent name, `project · branch`,
 * Dock), then the same transcript/composer as the chat pane in compact mode. Shares main's store via
 * `connectSync`; runs its own key registry (`composer` + `global`, no palette, Esc does nothing).
 */
export function PopoutRoot() {
  useThemeController();
  usePlatformAttr();
  useEffect(() => connectSync(), []);
  // Lifts the main window's 1100×680 `#root` minimum (styles/app.css) for the 400×500 pop-out.
  useEffect(() => {
    document.documentElement.dataset['window'] = 'popout';
  }, []);

  const raw = popoutSessionId();
  const sessionId: SessionId | null = raw === null ? null : idFrom<'SessionId'>(raw);
  const keys = useMemo(
    () => new KeyRegistry({ platform, overlayOpen: () => useUiStore.getState().overlays.length > 0 }),
    [],
  );
  useEffect(
    () => (sessionId === null ? undefined : keys.registerAll(popoutBindings(sessionId))),
    [keys, sessionId],
  );
  useEffect(() => keys.install(window), [keys]);

  const connection = useReadModel((st) => st.connection);
  const session = useSession(sessionId);
  const project = useModel((m) =>
    session === null ? copy.general.none : projectNameOf(m, session.projectId),
  );
  const branch = useModel((m) => (session === null ? copy.general.none : branchOf(m, session)));
  const agent = session === null ? copy.general.none : copy.agents[session.agent];
  const chrome = chromePlatform();
  const ready = connection !== 'connecting' && session !== null;

  return (
    <>
      <div
        id="layer-app"
        className={s['popout']}
        data-window="popout"
        data-screen-ready={ready ? 'popout' : undefined}
      >
        <header className={s['titlebar']} data-platform={chrome}>
          <span className={s['agent']}>{agent}</span>
          <span className={s['meta']}>
            {project} · {branch}
          </span>
          <span className={s['spacer']} />
          <Button
            variant="secondary"
            size="compact"
            className={s['dock']}
            onClick={() => {
              if (sessionId !== null) void command('window.dock', { sessionId });
            }}
          >
            {copy.window.dock}
          </Button>
        </header>
        {session !== null ? (
          <ChatPane projectId={session.projectId} sessionId={session.id} compact />
        ) : (
          <div className={s['empty']}>
            <span className="t-label">{copy.general.none}</span>
          </div>
        )}
      </div>
      <OverlayHost />
      <div id={ANNOUNCER_ID} className="visually-hidden" aria-live="polite" aria-atomic="true" />
    </>
  );
}
