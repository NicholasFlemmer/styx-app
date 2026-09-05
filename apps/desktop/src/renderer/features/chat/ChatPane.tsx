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
import { Button, Composer, Message, StatusDot, Tab, TabRow, Transcript } from '@styx/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import s from './ChatPane.module.css';
import { inlineSegments, transcriptItems, type TranscriptItem } from './transcript-items';

export interface ChatPaneProps {
  projectId: ProjectId;
  /** Pop-out window (spec §4.13): compact messages/composer, no tab row, no meta line. */
  compact?: boolean;
  /** Pins the pane to one session (the pop-out window's); defaults to the project's active session. */
  sessionId?: SessionId;
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
export function ChatPane({ projectId, compact = false, sessionId: pinnedId }: ChatPaneProps) {
  const model = useModel(useCallback((m: ReadModel) => m, []));
  const activeSessionId = useSessionId();
  const sessionId = pinnedId ?? activeSessionId;
  const now = useNow();
  const setSession = useUi((u) => u.setSession);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const overflowTab = useRef<HTMLButtonElement>(null);

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

  // Menu keyboard (spec §9): first item takes focus on open; ↑ / ↓ move; Esc closes and refocuses the ▾ tab.
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);
  const closeMenu = (refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) overflowTab.current?.focus();
  };
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const pick = (id: SessionId) => {
    setSession(projectId, id);
    closeMenu(true);
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
    <section
      className={[s['pane'], compact ? s['compact'] : undefined].filter(Boolean).join(' ')}
      data-keyscope="chat"
      data-chat-pane="true"
      data-chat-compact={compact ? 'true' : undefined}
      aria-label={copy.nav.agents}
    >
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
                  ref={overflowTab}
                  overflow
                  label={`+${tabs.overflow.length}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                  data-session-overflow="true"
                />
                {menuOpen && (
                  <div role="menu" aria-label="Sessions" className={s['menu']} onKeyDown={onMenuKeyDown}>
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
            {copy.window.popout}
          </button>
        </div>
      )}
      {!compact && (
        <div className={s['meta']} data-chat-meta="true">
          {meta}
        </div>
      )}
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
          disabled={activeId === null || (popped && !compact)}
        />
      </div>
    </section>
  );
}
