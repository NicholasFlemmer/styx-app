import { branchOf, composerPlaceholder, copy, idFrom, projectNameOf, type SessionId } from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect } from 'react';
import { keys, shellBindings } from '../keys';
import { chromePlatform, popoutSessionId } from '../state/bridge';
import { command } from '../state/commands';
import { useModel, useSession } from '../state/hooks';
import { connectSync } from '../state/sync';
import { ANNOUNCER_ID } from './announcer';
import { useThemeController, usePlatformAttr } from './AppRoot';
import { OverlayHost } from './OverlayHost';
import s from './PopoutRoot.module.css';

/** Pop-out chat window (spec §3: 400×500): 32px titlebar with agent, project · branch, Dock; compact chat pane. */
export function PopoutRoot() {
  useThemeController();
  usePlatformAttr();
  useEffect(() => connectSync(), []);
  useEffect(() => keys.registerAll(shellBindings()), []);
  useEffect(() => keys.install(window), []);

  const raw = popoutSessionId();
  const sessionId: SessionId | null = raw === null ? null : idFrom<'SessionId'>(raw);
  const session = useSession(sessionId);
  const project = useModel((m) =>
    session === null ? copy.general.none : projectNameOf(m, session.projectId),
  );
  const branch = useModel((m) => (session === null ? copy.general.none : branchOf(m, session)));
  const placeholder = useModel((m) => (sessionId === null ? '' : composerPlaceholder(m, sessionId)));
  const agent = session === null ? copy.general.none : copy.agents[session.agent];
  const chrome = chromePlatform();

  return (
    <>
      <div id="layer-app" className={s['popout']} data-keyscope="chat">
        <header className={s['titlebar']} data-platform={chrome}>
          <span className={s['agent']}>{agent}</span>
          <span className={s['meta']}>
            {project} · {branch}
          </span>
          <span className={s['spacer']} />
          <Button
            variant="secondary"
            size="compact"
            onClick={() => {
              if (sessionId !== null) void command('window.dock', { sessionId });
            }}
          >
            {copy.window.dock}
          </Button>
        </header>
        <div className={s['chat']} data-screen-ready="popout">
          <span className="t-label">{copy.chat.poppedOut}</span>
        </div>
        <div className={s['composer']}>
          <div className={s['composerBox']}>{placeholder}</div>
        </div>
      </div>
      <OverlayHost />
      <div id={ANNOUNCER_ID} className="visually-hidden" aria-live="polite" aria-atomic="true" />
    </>
  );
}
