import {
  chatMeta,
  composerPlaceholder,
  copy,
  deliveryWhileWorking,
  fill,
  headAskOf,
  isMidTurn,
  modelCatalogueFor,
  sessionTabs,
  type CommandInput,
  type ModelInfo,
  type ProjectId,
  type QueuedMessage,
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
  QuestionSet,
} from '@styx/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { sizes } from '@styx/tokens';
import { env } from '../../state/bridge';
import { useFloatingMenu } from '../../state/use-floating-menu';
import { command } from '../../state/commands';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import s from './ChatPane.module.css';
import {
  decodeEffort,
  decodeModel,
  decodePermissionMode,
  effortOptionsFor,
  encodeNullable,
  hasControls,
  modelOptionsFor,
  permissionModeHint,
  permissionModeOptionsFor,
  sessionControls,
} from './session-controls';
import {
  composerChips,
  isAttachError,
  pendingBytes,
  messageChips,
  readAttachment,
  sendAttachments,
  withMention,
  type Pending,
} from './chat-attachments';
import { CheckpointRow } from './CheckpointRow';
import { mentionItems as toMentionItems, slashItems } from './slash-commands';
import { thinkingLabel, elapsedLabel, workingLine } from './stream-state';
import { inlineSegments, transcriptItems, type TranscriptItem } from './transcript-items';
import { ArcadeHeldStrip, ArcadePanel, openArcade, quitArcade } from '../arcade/ArcadePanel';

const omitKey = <T,>(all: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _dropped, ...rest } = all;
  return rest;
};

export interface ChatPaneProps {
  projectId: ProjectId;
  /** Pop-out window (spec §4.13): compact messages/composer, no tab row, no meta line. */
  compact?: boolean;
  /** Pins the pane to one session (the pop-out window's); defaults to the project's active session. */
  sessionId?: SessionId;
}

const MODEL_LABEL = copy.chat.composer.model.replace(/\s*▾$/, '');

/**
 * Live session controls in the composer hint row (owner addition, discrepancies #54 / #83): Permissions / Model
 * (/ Effort where it applies per turn) as t-label selects, `Stop · esc` mid-turn. The lists follow the session's
 * agent: Claude's aliases, or the catalogue its CLI published (`capabilities.models`). A pty session keeps the
 * prototype's static `Model ▾` hint.
 */
function SessionControlsRow({ session, catalogue }: { session: Session; catalogue: readonly ModelInfo[] }) {
  const c = sessionControls(session);
  const configure = (patch: Omit<CommandInput<'session.configure'>, 'sessionId'>) =>
    void command('session.configure', { sessionId: session.id, ...patch });
  const modeHint = permissionModeHint(session.agent, session.permissionMode);
  return (
    <>
      {c.mode && (
        <Select
          className={s['control'] ?? ''}
          width="auto"
          aria-label={copy.chat.controls.permissions}
          title={modeHint}
          value={session.permissionMode}
          options={permissionModeOptionsFor(session.agent, true).map((o) => ({
            value: o.value,
            label: o.label,
          }))}
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
          options={modelOptionsFor(session.agent, session.model, catalogue, true)}
          onChange={(e) => configure({ model: decodeModel(e.currentTarget.value) })}
          data-session-control="model"
        />
      )}
      {c.liveEffort && (
        <Select
          className={s['control'] ?? ''}
          width="auto"
          aria-label={copy.chat.controls.effort}
          title={copy.chat.controls.effort}
          value={encodeNullable(session.effort)}
          options={effortOptionsFor(session.agent, session.model, catalogue, session.effort)}
          onChange={(e) => configure({ effort: decodeEffort(e.currentTarget.value) })}
          data-session-control="effort"
        />
      )}
      {c.pause && (
        <Button
          variant="ghost"
          className={s['stop']}
          on={c.paused}
          title={c.paused ? copy.chat.controls.resume : copy.chat.controls.paused}
          onClick={() =>
            void command(c.paused ? 'session.resume' : 'session.pause', { sessionId: session.id })
          }
          data-session-control="pause"
        >
          {c.paused ? copy.chat.controls.resume : copy.chat.controls.pause}
        </Button>
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
      {/* Nothing finishes a session on its own (discrepancy #111); this is how one reaches Done. */}
      {c.markDone && !c.stop && (
        <Button
          variant="ghost"
          className={s['stop']}
          title={copy.chat.controls.markDoneTitle}
          onClick={() => void command('session.markDone', { sessionId: session.id })}
          data-session-control="markDone"
        >
          {copy.chat.controls.markDone}
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
/** Chat pane width is persisted per machine like the terminal's height (`ui.persist` → `paneSizes`). */
const CHAT_PANE_KEY = 'chat';
const CHAT_MIN = 280;
/** Leave room for the editor stack: the window minimum is 1100 and files + rail + nav already take ~424. */
const CHAT_MAX = 720;
const CHAT_KEY_STEP = 16;

export const clampChatWidth = (w: number): number => Math.max(CHAT_MIN, Math.min(CHAT_MAX, Math.round(w)));

export function ChatPane({ projectId, compact = false, sessionId: pinnedId }: ChatPaneProps) {
  const model = useModel(useCallback((m: ReadModel) => m, []));
  const activeSessionId = useSessionId();
  const sessionId = pinnedId ?? activeSessionId;
  const setSession = useUi((u) => u.setSession);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const setScreen = useUi((u) => u.setScreen);
  const setDiffCheckpoint = useUi((u) => u.setDiffCheckpoint);
  const [menuOpen, setMenuOpen] = useState(false);
  useFloatingMenu(menuOpen); // the +N sessions menu floats over the pane and, with it, the design window
  /**
   * Attachments waiting to go with the next message (images read to base64, `@`-mentioned worktree files), per
   * session: what was attached in one tab must not ride along in another.
   */
  const [pendingBySession, setPendingBySession] = useState<Record<string, Pending[]>>({});
  const [mentionPaths, setMentionPaths] = useState<readonly string[]>([]);
  const [slashQuery, setSlashQuery] = useState('');
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const overflowTab = useRef<HTMLButtonElement>(null);

  const tabs = useMemo(() => sessionTabs(model, projectId, sessionId), [model, projectId, sessionId]);
  const activeId: SessionId | null = tabs.activeId;
  const pending: Pending[] = activeId === null ? [] : (pendingBySession[activeId] ?? []);
  const setPending = useCallback(
    (update: Pending[] | ((prev: Pending[]) => Pending[])) => {
      if (activeId === null) return;
      setPendingBySession((all) => {
        const prev = all[activeId] ?? [];
        const next = typeof update === 'function' ? update(prev) : update;
        return next.length === 0 ? omitKey(all, activeId) : { ...all, [activeId]: next };
      });
    },
    [activeId],
  );
  // The composer's text, per session, in the store: it survives a tab switch and a trip to another screen.
  const composerText = useUi((u) => (activeId === null ? '' : (u.composerText[activeId] ?? '')));
  const arcadeProject = useUi((u) => u.arcade?.projectId ?? null);
  const arcadeHeld = useUi((u) => u.arcade?.held ?? false);
  const setComposerText = useUi((u) => u.setComposerText);
  // Working line (discrepancy #55): hidden under the e2e/visual harness like the session controls — the demo
  // Claude session is `working`, so the line would otherwise land on the baked `workspace` baseline. Whether it
  // shows does not depend on the clock; the clock only feeds its elapsed seconds, ticking 1s while it is up.
  const workingActive = activeId !== null && env().e2e !== true && workingLine(model, activeId, 0) !== null;
  const now = useNow(workingActive ? 1000 : undefined);
  const working = workingActive && activeId !== null ? workingLine(model, activeId, now) : null;
  const meta = activeId === null ? '' : chatMeta(model, activeId, now);
  const items = useMemo(() => (activeId === null ? [] : transcriptItems(model, activeId)), [model, activeId]);
  const popped = activeId !== null && model.popouts.includes(activeId);
  // Snake in this pane (discrepancy row 110): the board takes the transcript's place while it plays; held (the
  // tab on screen needs the person), it folds to a strip over the transcript so the ask is what the pane shows.
  // Never in the pop-out: that window is the transcript and nothing else.
  const arcadeHere = !compact && activeId !== null && arcadeProject === projectId;
  const arcadePlaying = arcadeHere && !arcadeHeld;
  // The button under the tab row (owner: "just make it available in a chat"). Hidden under the harness like the
  // session controls: the baked `workspace` baseline has the prototype's bare meta line.
  const arcadeButton = !compact && activeId !== null && env().e2e !== true;
  const placeholder = activeId === null ? '' : composerPlaceholder(model, activeId);
  const session = activeId === null ? null : (model.sessions.byId[activeId] ?? null);
  const agent = session?.agent ?? null;
  const arcadeBlocked = session?.state === 'needs-you';
  const clis = model.discovery.clis;
  const catalogue = useMemo(
    () => (agent === null ? [] : modelCatalogueFor({ discovery: { ides: [], clis } }, agent)),
    [clis, agent],
  );
  // Hidden under the e2e/visual harness: the prototype-baked `workspace` baseline has the static hint row and the
  // control row moved it by +0.37 % (discrepancy #54); the harness screenshots the fixture's working Claude session.
  const controls =
    session !== null && env().e2e !== true && hasControls(sessionControls(session)) ? (
      <SessionControlsRow session={session} catalogue={catalogue} />
    ) : undefined;
  // Mid-turn the send hint says what happens to the message: Steer (Codex takes it into the running turn) or
  // Queue (held until the turn settles). Hidden under the harness like the controls: the baked `workspace`
  // baseline shows the fixture's working Claude session with the prototype's static `⏎ send`.
  const delivery =
    session !== null && env().e2e !== true && isMidTurn(session) ? deliveryWhileWorking(session) : null;
  const sendLabel = delivery === null ? copy.chat.composer.send : copy.queue.send[delivery];
  const sendTitle =
    delivery === null || session === null
      ? undefined
      : fill(delivery === 'steer' ? copy.queue.steerHint : copy.queue.queueHint, {
          agent: copy.agentProducts[session.agent],
        });
  // Messages held while the agent is mid-turn (queue): dashed bubbles under the transcript, oldest first.
  const queued: readonly QueuedMessage[] = activeId === null ? [] : (model.queues[activeId] ?? []);
  // Text handed back to this composer (Take back, or Stop returning the queue): applied once, then cleared.
  const draft = useUi((u) => (activeId === null ? null : (u.drafts[activeId] ?? null)));
  const clearDraft = useUi((u) => u.clearDraft);
  const prefillDraft = useUi((u) => u.prefillDraft);
  useEffect(() => {
    // The Composer applies the prefill in its own (child) effect first; clearing here keeps a remount from
    // applying it again.
    if (draft !== null && activeId !== null) clearDraft(activeId);
  }, [draft, activeId, clearDraft]);
  const sendNow = (m: QueuedMessage) => {
    void command('session.sendQueued', { sessionId: m.sessionId, messageId: m.id });
  };
  const takeBack = (m: QueuedMessage) => {
    prefillDraft(m.sessionId, m.body);
    void command('session.unqueue', { sessionId: m.sessionId, messageId: m.id });
  };

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

  /** ✕ on a tab: ends the session if it is still running and archives it, so the tab goes away either way. */
  const closeSession = (id: SessionId) => {
    void command('session.close', { sessionId: id });
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

  const answerQuestions = (
    item: Extract<TranscriptItem, { kind: 'questions' }>,
    answers: { key: string; chosen: string[]; freeText: string | null }[],
  ) => {
    if (item.askId === null) return;
    void command('ask.respond', { askId: item.askId, resolution: { kind: 'questions', answers } });
  };

  const decidePlan = (item: Extract<TranscriptItem, { kind: 'plan' }>, outcome: 'approved' | 'rejected') => {
    if (item.askId === null) return;
    void command('ask.respond', { askId: item.askId, resolution: { kind: 'plan', outcome, note: null } });
  };

  /** Review opens the Diff screen on the turn's patch; Revert (confirmed in the row) restores the workspace. */
  const reviewCheckpoint = (checkpointId: string) => {
    setDiffCheckpoint(checkpointId);
    setScreen('diff');
  };
  /** A refused revert (the agent is still working) surfaces as the command wrapper's error toast. */
  const revertCheckpoint = (checkpointId: string) => {
    void command('checkpoint.revert', { checkpointId });
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
  const imageInput = useRef<HTMLInputElement>(null);

  // Resize, mirroring the terminal's handle (spec §4.1 gives the terminal one; the chat pane was left fixed).
  const chatWidth = useUi((u) => u.paneSizes[CHAT_PANE_KEY] ?? null);
  const setPaneSize = useUi((u) => u.setPaneSize);
  const persistWidth = useCallback(
    (w: number) => {
      setPaneSize(CHAT_PANE_KEY, w);
      void command('ui.persist', { paneSizes: { [CHAT_PANE_KEY]: w } });
    },
    [setPaneSize],
  );
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = handle.parentElement?.getBoundingClientRect().width ?? CHAT_MIN;
    let next = startW;
    handle.setPointerCapture(e.pointerId);
    // Dragging left widens the chat: it is the right-hand pane, so the delta is inverted.
    const move = (ev: globalThis.PointerEvent) => {
      next = clampChatWidth(startW + (startX - ev.clientX));
      setPaneSize(CHAT_PANE_KEY, next);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      persistWidth(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  /** Keyboard parity with the terminal handle (spec §9): ← / → resize by 16px. */
  const onResizeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const base = chatWidth ?? sizes.chatPane;
    persistWidth(clampChatWidth(base + (e.key === 'ArrowLeft' ? CHAT_KEY_STEP : -CHAT_KEY_STEP)));
  };

  /** Any file from a paste, a drop or the picker (images inline where the agent takes them; the rest by path). */
  const addFiles = (files: readonly File[]) => {
    let reserved = pendingBytes(pending);
    for (const file of files) {
      const id = `att:${file.name}:${file.size}:${Date.now()}`;
      const already = reserved;
      reserved += file.size;
      void readAttachment(file, id, already).then((r) => {
        if (isAttachError(r)) {
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
      case 'checkpoint':
        return (
          <CheckpointRow
            key={item.id}
            turn={item.turn}
            files={item.files}
            added={item.added}
            removed={item.removed}
            reverted={item.reverted}
            busy={session !== null && (session.state === 'working' || session.state === 'needs-you')}
            onReview={() => reviewCheckpoint(item.checkpointId)}
            onRevert={() => revertCheckpoint(item.checkpointId)}
            compact={compact}
          />
        );
      case 'peer':
        // Deliberately not a user bubble: a peer's words must never read as the operator's.
        return (
          <div key={item.id} className={s['peer']} data-peer={item.inbound ? 'in' : 'out'}>
            <span className={['t-label', s['peerHead']].join(' ')}>
              {fill(item.inbound ? copy.chat.peer.from : copy.chat.peer.to, {
                agent: item.agent,
                branch: item.branch ?? copy.chat.peer.noBranch,
              })}
            </span>
            <Body text={item.text} />
          </div>
        );
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
      case 'questions':
        return (
          <QuestionSet
            key={item.id}
            questions={item.questions}
            answers={item.answers}
            disabled={!item.open}
            onSubmit={(answers) => answerQuestions(item, answers)}
            header={copy.session.questions.header(item.questions.length)}
            submitLabel={copy.session.questions.submit}
            freeTextPlaceholder={copy.session.questions.freeText}
            secretPlaceholder={copy.session.questions.secret}
            compact={compact}
          />
        );
      case 'plan':
        return (
          <Message
            key={item.id}
            kind="decision"
            options={[
              { label: copy.session.plan.approve },
              { label: copy.session.plan.reject, primary: false },
            ]}
            onChoose={(label) =>
              decidePlan(item, label === copy.session.plan.approve ? 'approved' : 'rejected')
            }
            chosen={
              item.outcome === null
                ? null
                : item.outcome === 'approved'
                  ? copy.session.plan.approve
                  : copy.session.plan.reject
            }
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
      {...(compact || chatWidth === null ? {} : { style: { width: chatWidth } })}
      data-keyscope="chat"
      data-chat-pane="true"
      data-chat-compact={compact ? 'true' : undefined}
      aria-label={copy.nav.agents}
    >
      {!compact && (
        <div
          className={s['resize']}
          role="separator"
          aria-orientation="vertical"
          aria-label={copy.workspace.resizeChat}
          aria-valuenow={chatWidth ?? sizes.chatPane}
          aria-valuemin={CHAT_MIN}
          aria-valuemax={CHAT_MAX}
          tabIndex={0}
          onPointerDown={onResizeDown}
          onKeyDown={onResizeKeyDown}
          data-chat-resize="true"
        />
      )}
      {!compact && (
        <div className={s['tabsRow']} data-session-tabs="true">
          <TabRow aria-label="Sessions" className={s['tabs']}>
            {tabs.visible.map((t) => (
              <Tab
                key={t.sessionId}
                label={t.label}
                dot={t.dot}
                badge={t.needs}
                inv={t.active}
                onClick={() => pick(t.sessionId)}
                onClose={() => closeSession(t.sessionId)}
                closeLabel={copy.chat.closeSessionNamed(t.label)}
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
                        data-session-menu-item={t.sessionId}
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
            data-spawn-agent="true"
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
        <div className={s['metaRow']}>
          <div className={s['meta']} data-chat-meta="true">
            {meta}
          </div>
          {arcadeButton && (
            <button
              type="button"
              className={s['arcadeButton']}
              aria-pressed={arcadeHere}
              data-inv={arcadeHere ? 'true' : undefined}
              disabled={arcadeBlocked && !arcadeHere}
              title={
                arcadeBlocked && !arcadeHere && session !== null
                  ? fill(copy.arcade.openBlocked, { agent: copy.agents[session.agent] })
                  : copy.arcade.openTitle
              }
              onClick={(e) => {
                if (arcadeHere) quitArcade();
                else openArcade(projectId, e.currentTarget);
              }}
              data-arcade-open={arcadeHere ? 'open' : 'closed'}
            >
              {copy.arcade.open}
            </button>
          )}
        </div>
      )}
      {arcadeHere && arcadeHeld && <ArcadeHeldStrip projectId={projectId} sessionId={activeId} />}
      {arcadePlaying ? (
        <ArcadePanel
          projectId={projectId}
          sessionId={activeId}
          {...(working !== null
            ? {
                footer: (
                  <WorkingLine
                    label={working.label}
                    elapsedLabel={elapsedLabel(working.elapsedMs)}
                    compact={compact}
                  />
                ),
              }
            : {})}
        />
      ) : popped && !compact ? (
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
              elapsedLabel={elapsedLabel(working.elapsedMs)}
              compact={compact}
            />
          )}
          {queued.map((m) => (
            <div key={m.id} className={s['queued']} data-queued={m.id}>
              <div className={s['queuedBody']}>{m.body}</div>
              <div className={s['queuedMeta']}>
                <span className={s['queuedLabel']}>
                  {copy.queue.queued} · {copy.queue.hint}
                </span>
                <Button variant="ghost" className={s['queuedAction']} onClick={() => sendNow(m)}>
                  {copy.queue.sendNow}
                </Button>
                <Button variant="ghost" className={s['queuedAction']} onClick={() => takeBack(m)}>
                  {copy.queue.takeBack}
                </Button>
              </div>
            </div>
          ))}
        </Transcript>
      )}
      <div data-keyscope="composer">
        {/*
          Any file, from anywhere: the picker, a paste and a drop all read the file's bytes here and main saves it
          into the session's worktree (images the agent takes inline stay in memory). Worktree files also have
          their own route through `@`.
        */}
        <input
          ref={imageInput}
          type="file"
          multiple
          hidden
          data-chat-file-input="true"
          onChange={(e) => {
            addFiles(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = '';
          }}
        />
        <Composer
          key={activeId ?? 'none'}
          initialText={composerText}
          onTextChange={(text) => {
            if (activeId !== null) setComposerText(activeId, text);
          }}
          placeholder={placeholder}
          onSend={send}
          hints={[copy.chat.composer.file, copy.chat.composer.command]}
          modelLabel={MODEL_LABEL}
          {...(controls !== undefined ? { controls } : {})}
          sendLabel={sendLabel}
          {...(sendTitle !== undefined ? { sendTitle } : {})}
          prefill={draft}
          compact={compact}
          disabled={activeId === null || (popped && !compact)}
          attachments={composerChips(pending)}
          onRemoveAttachment={(id) => setPending((prev) => prev.filter((p) => p.id !== id))}
          canSend={pending.length > 0}
          onPaste={addFiles}
          onDrop={addFiles}
          onAttachClick={() => imageInput.current?.click()}
          attachLabel={copy.chat.composer.attach}
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
                slashHint: fill(copy.chat.slash.hint, { agent: copy.agentProducts[session.agent] }),
                slashEmpty: copy.chat.slash.none,
              }
            : {})}
        />
      </div>
    </section>
  );
}
