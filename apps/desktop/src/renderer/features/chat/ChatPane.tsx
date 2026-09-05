import {
  chatMeta,
  composerPlaceholder,
  copy,
  headAskOf,
  sessionTabs,
  type ProjectId,
  type ReadModel,
  type SessionId,
} from '@styx/core';
import { Button, Composer, Icon, Message, StatusDot, Tab, TabRow, Transcript } from '@styx/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import s from './ChatPane.module.css';
import { inlineSegments, transcriptItems, type TranscriptItem } from './transcript-items';

export interface ChatPaneProps {
  projectId: ProjectId;
  /** Pop-out window: compact messages/composer, no tab row. */
  compact?: boolean;
}

const MODEL_LABEL = copy.chat.composer.model.replace(/\s*▾$/, '');

/** Body text with file names in mono (prototype agent bubbles). */
function Body({ text }: { text: string }) {
  return (
    <>
      {inlineSegments(text).map((seg, i) =>
        seg.code ? (
          <span key={i} className={s['code']}>
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Chat pane (spec §4.1, 360px): session tabs (3 visible + ▾, accent `!` when needs-you, `+` spawns, ⤢ pops
 * out), meta line, transcript of the six Message kinds, composer. `data-keyscope="chat"` / `"composer"`.
 */
export function ChatPane({ projectId, compact = false }: ChatPaneProps) {
  const model = useModel(useCallback((m: ReadModel) => m, []));
  const sessionId = useSessionId();
  const now = useNow();
  const setSession = useUi((u) => u.setSession);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  const tabs = useMemo(() => sessionTabs(model, projectId, sessionId), [model, projectId, sessionId]);
  const activeId: SessionId | null = tabs.activeId;
  const meta = activeId === null ? '' : chatMeta(model, activeId, now);
  const items = useMemo(() => (activeId === null ? [] : transcriptItems(model, activeId)), [model, activeId]);
  const popped = activeId !== null && model.popouts.includes(activeId);
  const placeholder = activeId === null ? '' : composerPlaceholder(model, activeId);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menu.current !== null && !menu.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const pick = (id: SessionId) => {
    setSession(projectId, id);
    setMenuOpen(false);
  };

  const review = (item: Extract<TranscriptItem, { kind: 'accessRequest' }>) => {
    if (activeId === null) return;
    const askId = item.askId ?? headAskOf(model, activeId)?.id ?? null;
    if (askId === null) return;
    pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId: activeId, askId });
  };

  const choose = (item: Extract<TranscriptItem, { kind: 'decision' }>, label: string) => {
    if (item.askId !== null) {
      void command('ask.respond', { askId: item.askId, resolution: { kind: 'decision', chosen: label } });
    } else if (activeId !== null) {
      void command('session.sendMessage', { sessionId: activeId, body: label });
    }
  };

  const send = (text: string) => {
    if (activeId !== null) void command('session.sendMessage', { sessionId: activeId, body: text });
  };

  const renderItem = (item: TranscriptItem) => {
    switch (item.kind) {
      case 'user':
        return <Message key={item.id} kind="user" text={item.text} compact={compact} />;
      case 'agent':
        return (
          <Message key={item.id} kind="agent" compact={compact}>
            <Body text={item.text} />
          </Message>
        );
      case 'system':
        return <Message key={item.id} kind="system" text={item.text} compact={compact} />;
      case 'fileList':
        return <Message key={item.id} kind="fileList" files={item.files} compact={compact} />;
      case 'decision':
        return (
          <Message
            key={item.id}
            kind="decision"
            options={item.options.map((label) => ({ label }))}
            onChoose={(label) => choose(item, label)}
            compact={compact}
          >
            <Body text={item.text} />
          </Message>
        );
      case 'accessRequest':
        return (
          <Message
            key={item.id}
            kind="accessRequest"
            target={item.target}
            {...(item.env === undefined ? {} : { env: item.env })}
            scopes={item.scopes}
            onReview={() => review(item)}
            onDeny={() => void command('grant.deny', { grantId: item.grantId })}
            compact={compact}
          />
        );
    }
  };

  return (
    <section className={s['pane']} data-keyscope="chat" data-chat-pane="true" aria-label={copy.nav.agents}>
      {!compact && (
        <div className={s['tabsRow']}>
          <TabRow aria-label="Sessions" className={s['tabs']}>
            {tabs.visible.map((t) => (
              <Tab
                key={t.sessionId}
                label={t.label}
                dot={t.dot}
                badge={t.needs}
                inv={t.active}
                onClick={() => pick(t.sessionId)}
                data-session-tab={t.sessionId}
              />
            ))}
            {tabs.overflow.length > 0 && (
              <div ref={menu} className={s['overflow']}>
                <Tab
                  overflow
                  label={`+${tabs.overflow.length}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                  data-session-overflow="true"
                />
                {menuOpen && (
                  <div role="menu" className={s['menu']}>
                    {tabs.overflow.map((t) => (
                      <button
                        key={t.sessionId}
                        type="button"
                        role="menuitem"
                        className={s['menuItem']}
                        onClick={() => pick(t.sessionId)}
                      >
                        <StatusDot tone={t.dot} size={7} />
                        {t.label}
                        {t.needs && <span className={s['badge']}>!</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </TabRow>
          <button
            type="button"
            className={s['plus']}
            aria-label={copy.board.actions.spawn.replace(/^\+\s*/, '')}
            onClick={() => pushOverlay({ kind: 'modal', modal: 'spawn', projectId })}
          >
            +
          </button>
          <span className={s['spacer']} />
          <button
            type="button"
            className={s['popout']}
            title="Pop out chat"
            aria-label="Pop out chat"
            disabled={activeId === null}
            onClick={() => {
              if (activeId !== null) void command('window.popout', { sessionId: activeId });
            }}
          >
            <Icon name="popout" />
          </button>
        </div>
      )}
      <div className={s['meta']} data-chat-meta="true">
        {meta}
      </div>
      {popped && !compact ? (
        <div className={s['popped']}>
          <span className="t-label">{copy.chat.poppedOut}</span>
          <Button
            onClick={() => {
              if (activeId !== null) void command('window.dock', { sessionId: activeId });
            }}
          >
            {copy.chat.dock}
          </Button>
        </div>
      ) : (
        <Transcript compact={compact}>{items.map(renderItem)}</Transcript>
      )}
      <div data-keyscope="composer">
        <Composer
          placeholder={placeholder}
          onSend={send}
          hints={[copy.chat.composer.file, copy.chat.composer.command]}
          modelLabel={MODEL_LABEL}
          compact={compact}
          disabled={activeId === null || popped}
        />
      </div>
    </section>
  );
}
