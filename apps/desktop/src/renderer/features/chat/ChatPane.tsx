import {
  chatMeta,
  composerPlaceholder,
  copy,
  fill,
  headAskOf,
  sessionTabs,
  type CommandInput,
  type ProjectId,
  type ReadModel,
  type Session,
  type SessionId,
} from '@styx/core';
import {
  Button,
  Composer,
  Icon,
  Markdown,
  Message,
  Select,
  StatusDot,
  Tab,
  TabRow,
  Transcript,
  WorkingLine,
} from '@styx/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { env } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import s from './ChatPane.module.css';
import {
  decodeModel,
  decodePermissionMode,
  encodeNullable,
  hasControls,
  modelOptions,
  permissionModeOptions,
  sessionControls,
} from './session-controls';
import {
  composerChips,
  isImageError,
  messageChips,
  readImage,
  sendAttachments,
  withMention,
  type Pending,
} from './chat-attachments';
import { mentionItems as toMentionItems, slashItems } from './slash-commands';
import { thinkingLabel, wholeSeconds, workingLine } from './stream-state';
import { inlineSegments, transcriptItems, type TranscriptItem } from './transcript-items';

export interface ChatPaneProps {
  projectId: ProjectId;
  /** Pop-out window (spec §4.13): compact messages/composer, no tab row, no meta line. */
  compact?: boolean;
  /** Pins the pane to one session (the pop-out window's); defaults to the project's active session. */
  sessionId?: SessionId;
}

const MODEL_LABEL = copy.chat.composer.model.replace(/\s*▾$/, '');

/**
 * Live Claude Code controls in the composer hint row (owner addition, discrepancy #54): Permissions / Model /
 * Effort as t-label selects, `Stop · esc` mid-turn. Other agents keep the prototype's static `Model ▾` hint.
 */
function SessionControlsRow({ session }: { session: Session }) {
  const c = sessionControls(session);
  const configure = (patch: Omit<CommandInput<'session.configure'>, 'sessionId'>) =>
    void command('session.configure', { sessionId: session.id, ...patch });
  const modeHint = copy.session.permissionModeHints[session.permissionMode];
  return (
    <>
      {c.mode && (
        <Select
          className={s['control'] ?? ''}
          width="auto"
          aria-label={copy.chat.controls.permissions}
          title={modeHint}
          value={session.permissionMode}
          options={permissionModeOptions(true).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(e) => configure({ permissionMode: decodePermissionMode(e.currentTarget.value) })}
          data-session-control="permissionMode"
        />
      )}
      {c.model && (
        <Select
          className={s['control'] ?? ''}
          width="auto"
          aria-label={copy.chat.controls.model}
          title={copy.chat.controls.model}
          value={encodeNullable(session.model)}
          options={modelOptions(session.model, true)}
          onChange={(e) => configure({ model: decodeModel(e.currentTarget.value) })}
          data-session-control="model"
        />
      )}
      {c.stop && (
        <Button
          variant="ghost"
          className={s['stop']}
          title={copy.chat.controls.stop}
          onClick={() => void command('session.interrupt', { sessionId: session.id })}
          data-session-control="stop"
        >
          {copy.chat.controls.stop}
        </Button>
      )}
    </>
  );
}

/** Plain text with file names in mono (prototype agent bubbles); used for text runs inside markdown too. */
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
 * Agent replies render as markdown (owner addition, discrepancy #57): headings, lists, code fences and tables
 * instead of one wall of text. Plain runs keep the prototype's mono file names; links open in the browser.
 */
function AgentBody({ text }: { text: string }) {
  return (
    <Markdown
      text={text}
      renderText={(run) => <Body text={run} />}
      onLink={(url) => void command('link.open', { url })}
    />
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
  const setSession = useUi((u) => u.setSession);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Attachments waiting to go with the next message (images read to base64, `@`-mentioned worktree files). */
  const [pending, setPending] = useState<Pending[]>([]);
  const [mentionPaths, setMentionPaths] = useState<readonly string[]>([]);
  const [slashQuery, setSlashQuery] = useState('');
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const overflowTab = useRef<HTMLButtonElement>(null);

  const tabs = useMemo(() => sessionTabs(model, projectId, sessionId), [model, projectId, sessionId]);
  const activeId: SessionId | null = tabs.activeId;
  // Working line (discrepancy #55): hidden under the e2e/visual harness like the session controls — the demo
  // Claude session is `working`, so the line would otherwise land on the baked `workspace` baseline. Whether it
  // shows does not depend on the clock; the clock only feeds its elapsed seconds, ticking 1s while it is up.
  const workingActive = activeId !== null && env().e2e !== true && workingLine(model, activeId, 0) !== null;
  const now = useNow(workingActive ? 1000 : undefined);
  const working = workingActive && activeId !== null ? workingLine(model, activeId, now) : null;
  const meta = activeId === null ? '' : chatMeta(model, activeId, now);
  const items = useMemo(() => (activeId === null ? [] : transcriptItems(model, activeId)), [model, activeId]);
  const popped = activeId !== null && model.popouts.includes(activeId);
  const placeholder = activeId === null ? '' : composerPlaceholder(model, activeId);
  const session = activeId === null ? null : (model.sessions.byId[activeId] ?? null);
  // Hidden under the e2e/visual harness: the prototype-baked `workspace` baseline has the static hint row and the
  // control row moved it by +0.37 % (discrepancy #54); the harness screenshots the fixture's working Claude session.
  const controls =
    session !== null && env().e2e !== true && hasControls(sessionControls(session)) ? (
      <SessionControlsRow session={session} />
    ) : undefined;

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
    if (activeId === null) return;
    void command('session.sendMessage', {
      sessionId: activeId,
      body: text,
      attachments: sendAttachments(pending),
    });
    setPending([]);
  };

  /** `@…` in the composer searches the session's worktree (debounced 80 ms); the picker inserts `@path`. */
  const onMentionQuery = useCallback(
    (query: string) => {
      const worktreeId = session?.worktreeId ?? null;
      if (worktreeId === null) return;
      if (mentionTimer.current !== null) clearTimeout(mentionTimer.current);
      mentionTimer.current = setTimeout(() => {
        void command('fs.find', { worktreeId, query, limit: 30 }).then((r) => {
          setMentionPaths(r.ok ? r.value.paths : []);
        });
      }, 80);
    },
    [session?.worktreeId],
  );

  useEffect(
    () => () => {
      if (mentionTimer.current !== null) clearTimeout(mentionTimer.current);
    },
    [],
  );

  /** Pasted / dropped images are read here and sent as base64 blocks; anything else is refused with §57 copy. */
  const addImages = (files: readonly File[]) => {
    for (const file of files) {
      const id = `img:${file.name}:${file.size}:${Date.now()}`;
      void readImage(file, id).then((r) => {
        if (isImageError(r)) {
          pushOverlay({ kind: 'toast', toast: { kind: 'error', code: 'attachment', message: r.message } });
          return;
        }
        setPending((prev) => (prev.some((p) => p.id === r.id) ? prev : [...prev, r]));
      });
    }
  };

  const renderItem = (item: TranscriptItem) => {
    switch (item.kind) {
      case 'user':
        return (
          <Message
            key={item.id}
            kind="user"
            text={item.text}
            attachments={messageChips(item.attachments)}
            compact={compact}
          />
        );
      case 'agent':
        return (
          <Message key={item.id} kind="agent" streaming={item.streaming} compact={compact}>
            <AgentBody text={item.text} />
          </Message>
        );
      case 'thinking':
        return (
          <Message
            key={item.id}
            kind="thinking"
            text={item.text}
            status={item.status}
            label={thinkingLabel(item.status, item.durationMs)}
            showLabel={copy.chat.thinking.show}
            hideLabel={copy.chat.thinking.hide}
            compact={compact}
          />
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
            chosen={item.chosen}
            disabled={!item.open}
            compact={compact}
          >
            <Body text={item.text} />
          </Message>
        );
      case 'tool':
        return (
          <Message
            key={item.id}
            kind="tool"
            tool={item.tool}
            hint={item.hint}
            status={item.status}
            statusGlyph={copy.session.tool[item.status]}
            detail={item.detail}
            compact={compact}
          />
        );
      case 'accessRequest':
        return (
          <Message
            key={item.id}
            kind="accessRequest"
            header={fill(copy.accessRequest.header, {
              target: item.env === undefined ? item.target : `${item.target} ${item.env}`,
            })}
            body={fill(copy.accessRequest.scopeLine, { scopes: item.scopes.join(', ') })}
            reviewLabel={copy.accessRequest.review}
            denyLabel={copy.accessRequest.deny}
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
            <Icon name="popout" size={12} />
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
        <Transcript compact={compact}>
          {items.map(renderItem)}
          {working !== null && (
            <WorkingLine
              label={working.label}
              elapsedLabel={fill(copy.chat.working.elapsed, { s: wholeSeconds(working.elapsedMs) })}
              compact={compact}
            />
          )}
        </Transcript>
      )}
      <div data-keyscope="composer">
        <Composer
          placeholder={placeholder}
          onSend={send}
          hints={[copy.chat.composer.file, copy.chat.composer.command]}
          modelLabel={MODEL_LABEL}
          {...(controls !== undefined ? { controls } : {})}
          sendLabel={copy.chat.composer.send}
          compact={compact}
          disabled={activeId === null || (popped && !compact)}
          attachments={composerChips(pending)}
          onRemoveAttachment={(id) => setPending((prev) => prev.filter((p) => p.id !== id))}
          canSend={pending.length > 0}
          onPaste={addImages}
          onDrop={addImages}
          dropHint={copy.chat.attach.dropHint}
          onMentionQuery={onMentionQuery}
          mentionItems={toMentionItems(mentionPaths)}
          onMentionInsert={(path) => setPending((prev) => withMention(prev, path))}
          mentionHint={copy.chat.mention.hint}
          mentionEmpty={copy.chat.mention.none}
          {...(session !== null && session.slashCommands.length > 0
            ? {
                slashItems: slashItems(session, slashQuery),
                onSlashQuery: setSlashQuery,
                slashHint: copy.chat.slash.hint,
                slashEmpty: copy.chat.slash.none,
              }
            : {})}
        />
      </div>
    </section>
  );
}
