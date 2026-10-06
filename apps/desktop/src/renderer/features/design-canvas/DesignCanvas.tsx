import {
  AGENT_LABEL,
  DEFAULT_DESIGN_TOKENS,
  DESIGN_SIZES,
  copy,
  fill,
  taskOf,
  tokensCss,
  type DesignFidelity,
  type DesignList,
  type DesignSize,
  type DesignTokens,
  type ProjectId,
  type ReadModel,
  type Session,
  type SessionId,
} from '@styx/core';
import { AgentDot, Button, Select, Textarea } from '@styx/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { SPAWN_AGENTS } from '../modals/modals';
import { useSpawnForm } from '../modals/use-spawn-form';
import { Artboard } from './Artboard';
import { describeSelection, serializeForSave, type CanvasSelection } from './design-doc';
import { SelectionPanel, TokensPanel, selectionKey } from './DesignInspector';
import { HandoverDialog } from './HandoverDialog';
import s from './DesignCanvas.module.css';

const selectModel = (m: ReadModel) => m;
const ZOOMS = [0.25, 0.33, 0.5, 0.75, 1];
const POLL_MS = 2000;
/** A file we just wrote is not reloaded when its own write shows up in the next listing. */
const OWN_WRITE_MS = 3000;
const SAVE_DEBOUNCE_MS = 400;

export interface DesignCanvasProps {
  projectId: ProjectId;
  sessionId: SessionId | null;
}

/** The task whose design this lane shows: itself when it is a design task, the design it builds otherwise. */
export const designTaskFor = (model: ReadModel, session: Session | null): Session | null => {
  if (session === null) return null;
  if (session.kind === 'design') return session;
  if (session.designSessionId === undefined) return null;
  return model.sessions.byId[session.designSessionId] ?? null;
};

/**
 * The Design tab (#140, #150): a design task's screens (or a build task's own, when its worktree has some) on a canvas, every size side by side, wireframe or high fidelity.
 * Select (V) picks an element or, dragged, an area: change it here, or tell the agent with the element and a picture
 * of it. Aa is Type and colour for every screen. Build it hands the screens over to a build task.
 */
export function DesignCanvas({ projectId, sessionId }: DesignCanvasProps) {
  const model = useModel(selectModel);
  const session = sessionId === null ? null : (model.sessions.byId[sessionId] ?? null);
  const design = designTaskFor(model, session);
  const own = useOwnScreens(session, design === null);
  if (design === null) {
    if (session === null) return <DesignStart projectId={projectId} />;
    // A build task with screens in its own worktree (a mockup put there by hand, or by its agent) shows them.
    if (own === true)
      return <Canvas key={session.id} projectId={projectId} design={session} linked={false} />;
    return own === null ? null : <DesignStart projectId={projectId} />;
  }
  return (
    <Canvas
      key={design.id}
      projectId={projectId}
      design={design}
      linked={session !== null && session.id !== design.id}
    />
  );
}

/**
 * Whether a task's own worktree holds screens (`.styx/designs/<screen>/<size>.html`), polled like the canvas so files
 * dropped in by hand appear without a reload. Null until the first answer, or while not asked.
 */
function useOwnScreens(session: Session | null, enabled: boolean): boolean | null {
  const worktreeId = session?.worktreeId ?? null;
  const [has, setHas] = useState<{ worktreeId: string; screens: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || worktreeId === null) return;
    let live = true;
    const check = async () => {
      const r = await command('design.list', { worktreeId });
      if (live && r.ok) setHas({ worktreeId, screens: r.value.screens.length > 0 });
    };
    const first = setTimeout(() => void check(), 0);
    const t = setInterval(() => void check(), POLL_MS);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [worktreeId, enabled]);
  return enabled && has !== null && has.worktreeId === worktreeId ? has.screens : null;
}

function Canvas({ projectId, design, linked }: { projectId: ProjectId; design: Session; linked: boolean }) {
  const openSession = useUi((u) => u.openSession);
  const worktreeId = design.worktreeId;
  const agentName = AGENT_LABEL[design.agent];
  const d = copy.chat.design;
  const [list, setList] = useState<DesignList | null>(null);
  const [fidelity, setFidelity] = useState<DesignFidelity>('hi');
  const [size, setSize] = useState<DesignSize | 'all'>('all');
  const [zoom, setZoom] = useState(0.33);
  const [selecting, setSelecting] = useState(false);
  const [panel, setPanel] = useState<'tokens' | null>(null);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [draft, setDraft] = useState<DesignTokens | null>(null);
  const [handover, setHandover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState('');
  const [versions, setVersions] = useState<Record<string, { mtime: number; version: number }>>({});
  const ownWrites = useRef(new Map<string, number>());
  const rows = useRef(new Map<string, HTMLDivElement>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokensTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askId = useId();

  const refresh = useCallback(async () => {
    const r = await command('design.list', { worktreeId });
    if (!r.ok) return;
    const at = Date.now();
    // A file that changed on disk reloads its frame; one we just saved ourselves keeps the frame (and the selection).
    setVersions((prev) => {
      let next = prev;
      for (const screen of r.value.screens)
        for (const f of screen.files) {
          const p = prev[f.path];
          const own = (ownWrites.current.get(f.path) ?? 0) > at - OWN_WRITE_MS;
          if (p !== undefined && p.mtime === f.mtime) continue;
          next = next === prev ? { ...prev } : next;
          next[f.path] = { mtime: f.mtime, version: p === undefined ? 0 : own ? p.version : p.version + 1 };
        }
      return next;
    });
    setList(r.value);
  }, [worktreeId]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      if (tokensTimer.current !== null) clearTimeout(tokensTimer.current);
    },
    [],
  );

  const tokens = draft ?? list?.tokens ?? null;
  const liveCss = useMemo(() => (draft === null ? null : tokensCss(draft)), [draft]);

  const onEdited = () => {
    const sel = selection;
    if (sel === null) return;
    const doc = sel.kind === 'element' ? sel.el.ownerDocument : sel.els[0]?.ownerDocument;
    if (!doc) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      ownWrites.current.set(sel.file.path, Date.now());
      void command('design.write', { worktreeId, path: sel.file.path, html: serializeForSave(doc) });
    }, SAVE_DEBOUNCE_MS);
  };

  const onTokens = (next: DesignTokens) => {
    setDraft(next);
    if (tokensTimer.current !== null) clearTimeout(tokensTimer.current);
    tokensTimer.current = setTimeout(() => {
      void command('design.setTokens', { worktreeId, tokens: next }).then(() => void refresh());
    }, SAVE_DEBOUNCE_MS);
  };

  /** A picture of the selection: its box on screen, from the window's own pixels. */
  const capture = async (sel: CanvasSelection): Promise<string | null> => {
    const frame = document.querySelector<HTMLIFrameElement>(
      `[data-artboard="${CSS.escape(sel.file.path)}"] iframe`,
    );
    if (frame === null) return null;
    const f = frame.getBoundingClientRect();
    const r = sel.kind === 'element' ? sel.el.getBoundingClientRect() : sel.rect;
    const pad = 8;
    const x = Math.max(0, Math.floor(f.left + (r.x - pad) * zoom));
    const y = Math.max(0, Math.floor(f.top + (r.y - pad) * zoom));
    const width = Math.max(1, Math.min(window.innerWidth - x, Math.ceil((r.width + pad * 2) * zoom)));
    const height = Math.max(1, Math.min(window.innerHeight - y, Math.ceil((r.height + pad * 2) * zoom)));
    const res = await command('design.capture', { rect: { x, y, width, height } });
    return res.ok ? res.value.image : null;
  };

  const send = async (text: string) => {
    if (selection === null) return;
    setBusy(true);
    const { label, detail } = describeSelection(selection);
    const image = await capture(selection);
    await command('session.sendMessage', {
      sessionId: design.id,
      body: text,
      attachments:
        image === null ? [] : [{ kind: 'image', name: 'selection.png', mediaType: 'image/png', data: image }],
      pointer: { source: 'design', label, detail, toDesign: false },
    });
    setBusy(false);
    setSent(true);
    setTimeout(() => setSent(false), 2500);
  };

  const askForScreen = () => {
    const name = ask.trim();
    if (name === '') return;
    void command('session.sendMessage', {
      sessionId: design.id,
      body: fill(d.askScreenText, { screen: name }),
      attachments: [],
    });
    setAsk('');
    setAsking(false);
  };

  // V and Escape are the canvas's while the Design tab is up, wherever focus is (not while typing, or under a dialog).
  const overlays = useUi((u) => u.overlays.filter((o) => o.kind !== 'toast').length);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (overlays > 0 || handover || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setSelecting((v) => !v);
      } else if (e.key === 'Escape' && (selection !== null || selecting)) {
        e.preventDefault();
        if (selection !== null) setSelection(null);
        else setSelecting(false);
      }
    };
    // Capture: the app's key registry handles Escape on the way down too; the canvas's selection goes first.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [overlays, handover, selection, selecting]);

  const screens = list?.screens ?? [];
  const shown = screens
    .map((screen) => ({
      screen,
      files: screen.files.filter((f) => f.fidelity === fidelity && (size === 'all' || f.size === size)),
    }))
    .filter((x) => x.files.length > 0);

  return (
    <div className={s['root']} data-design-canvas={design.id}>
      <div className={s['bar']} role="toolbar" aria-label={copy.chat.instruments.canvas}>
        <div className={s['seg']} role="radiogroup" aria-label={d.fidelity}>
          {(['wire', 'hi'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={fidelity === f}
              data-inv={fidelity === f ? 'true' : undefined}
              onClick={() => setFidelity(f)}
              data-design-fidelity={f}
            >
              {f === 'wire' ? d.wireframe : d.hifi}
            </button>
          ))}
        </div>
        <div className={s['seg']} role="radiogroup" aria-label={d.sizes}>
          {(['all', ...DESIGN_SIZES] as const).map((z) => (
            <button
              key={z}
              type="button"
              role="radio"
              aria-checked={size === z}
              data-inv={size === z ? 'true' : undefined}
              onClick={() => setSize(z)}
              data-design-size={z}
            >
              {z === 'all' ? d.allSizes : d.size[z]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={s['tool']}
          aria-pressed={selecting}
          data-on={selecting ? 'true' : undefined}
          title={d.select}
          aria-label={d.select}
          onClick={() => setSelecting((v) => !v)}
          data-design-select="true"
        >
          ↖
        </button>
        <button
          type="button"
          className={s['tool']}
          aria-pressed={panel === 'tokens'}
          data-on={panel === 'tokens' ? 'true' : undefined}
          title={d.typeColour}
          aria-label={d.typeColour}
          onClick={() => {
            setPanel((p) => (p === 'tokens' ? null : 'tokens'));
            setSelection(null);
          }}
          data-design-tokens="true"
        >
          Aa
        </button>
        <span className={s['spacer']} />
        <label className="visually-hidden" htmlFor={`${askId}-zoom`}>
          {d.zoom}
        </label>
        <select
          id={`${askId}-zoom`}
          className={s['zoom']}
          value={String(zoom)}
          onChange={(e) => setZoom(Number(e.currentTarget.value))}
        >
          {ZOOMS.map((z) => (
            <option key={z} value={String(z)}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
        {/* Build it hands a design task's screens to a build task; a build task showing its own screens is one. */}
        {!linked && design.kind === 'design' ? (
          <Button
            variant="accent"
            size="compact"
            disabled={screens.length === 0}
            onClick={() => setHandover(true)}
            data-design-build="true"
          >
            {d.buildIt} →
          </Button>
        ) : null}
      </div>
      <div className={[s['main'], panel !== null || selection !== null ? s['withPanel'] : ''].join(' ')}>
        <nav className={s['screens']} aria-label={d.screens}>
          {linked ? <p className={s['linked']}>{fill(d.linked, { task: taskOf(design) })}</p> : null}
          <div className={s['screensHead']}>
            <span>{d.screens}</span>
            <span>{screens.length}</span>
          </div>
          {screens.map((screen) => (
            <button
              key={screen.slug}
              type="button"
              className={s['screenItem']}
              onClick={() =>
                rows.current.get(screen.slug)?.scrollIntoView({ block: 'start', behavior: 'instant' })
              }
              data-design-screen={screen.slug}
            >
              <span>{screen.name}</span>
              <small>{[...new Set(screen.files.map((f) => d.size[f.size]))].join(' · ')}</small>
            </button>
          ))}
          {asking ? (
            <div className={s['askBox']}>
              <label className="visually-hidden" htmlFor={askId}>
                {d.askScreen}
              </label>
              <input
                id={askId}
                className={s['input']}
                autoFocus
                value={ask}
                placeholder="checkout"
                onChange={(e) => setAsk(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') askForScreen();
                  if (e.key === 'Escape') setAsking(false);
                }}
                data-design-ask-input="true"
              />
            </div>
          ) : (
            <button type="button" className={s['ask']} onClick={() => setAsking(true)} data-design-ask="true">
              {d.askScreen}
            </button>
          )}
          <div className={s['withAgent']}>
            <b>{fill(d.withAgent, { agent: agentName })}</b>
            {fill(d.withAgentBody, { agent: agentName })}
          </div>
        </nav>
        <div className={s['canvas']} data-selecting={selecting ? 'true' : undefined}>
          {list !== null && screens.length === 0 ? (
            <div className={s['empty']}>
              <b>{d.noScreens}</b>
              <span>{fill(d.noScreensBody, { agent: agentName })}</span>
            </div>
          ) : list !== null && shown.length === 0 ? (
            <div className={s['empty']}>
              <span>{fill(fidelity === 'wire' ? d.noScreensWire : d.noScreensHi, { agent: agentName })}</span>
            </div>
          ) : (
            shown.map(({ screen, files }) => (
              <div
                key={screen.slug}
                ref={(el) => {
                  if (el === null) rows.current.delete(screen.slug);
                  else rows.current.set(screen.slug, el);
                }}
                className={s['row']}
                data-design-row={screen.slug}
              >
                <div className={s['rowName']}>{screen.name}</div>
                <div className={s['rowBoards']}>
                  {files.map((f) => (
                    <Artboard
                      key={f.path}
                      worktreeId={worktreeId}
                      file={f}
                      version={versions[f.path]?.version ?? 0}
                      zoom={zoom}
                      selecting={selecting}
                      liveCss={liveCss}
                      selection={selection}
                      onSelect={(sel) => {
                        setSelection(sel);
                        if (sel !== null) setPanel(null);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
          {!selecting && selection === null && screens.length > 0 ? (
            <p className={s['hint']}>{d.hint}</p>
          ) : null}
        </div>
        {selection !== null ? (
          <SelectionPanel
            key={selectionKey(selection)}
            selection={selection}
            tokens={tokens}
            agent={design.agent}
            busy={busy}
            onEdited={onEdited}
            onSend={(text) => void send(text)}
          />
        ) : panel === 'tokens' ? (
          <TokensPanel tokens={tokens} fallback={DEFAULT_DESIGN_TOKENS} onChange={onTokens} />
        ) : null}
      </div>
      {sent ? (
        <div className={s['sent']} role="status">
          {fill(d.sent, { agent: agentName })}
        </div>
      ) : null}
      {handover && list !== null ? (
        <HandoverDialog
          designSessionId={design.id}
          agent={design.agent}
          design={list}
          onClose={() => setHandover(false)}
          onStarted={(id, mode) => {
            setHandover(false);
            if (mode === 'new') openSession(projectId, id);
          }}
        />
      ) : null}
    </div>
  );
}

const AGENT_OPTIONS = SPAWN_AGENTS.filter((a) => a !== 'shell').map((a) => ({
  value: a,
  label: copy.agentProducts[a],
}));

/** No design for this lane yet: start a design task (its own lane, its own branch). */
function DesignStart({ projectId }: { projectId: ProjectId }) {
  const openSession = useUi((u) => u.openSession);
  const { form, pickAgent, valid, busy, spawn } = useSpawnForm(projectId);
  const [text, setText] = useState('');
  const ids = { text: useId(), agent: useId() };
  const t = copy.chat.design.start;
  const ready = valid && text.trim() !== '';
  const start = async () => {
    if (!ready) return;
    const id = await spawn(text.trim(), 'design');
    if (id !== null) openSession(projectId, id);
  };
  return (
    <div className={s['start']} data-design-start="true">
      <div className={s['startIn']}>
        <h2 className={s['startTitle']}>{t.title}</h2>
        <p className={s['startBody']}>{t.body}</p>
        <label htmlFor={ids.text} className="visually-hidden">
          {t.label}
        </label>
        <Textarea
          id={ids.text}
          minHeight={84}
          placeholder={t.placeholder}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void start();
            }
          }}
          data-design-start-text="true"
        />
        <div className={s['startRow']}>
          <label htmlFor={ids.agent} className="visually-hidden">
            {copy.chat.design.handover.agent}
          </label>
          <AgentDot agent={form.agent} />
          <Select
            id={ids.agent}
            value={form.agent}
            options={AGENT_OPTIONS}
            onChange={(e) => {
              const a = SPAWN_AGENTS.find((x) => x === e.currentTarget.value);
              if (a !== undefined) pickAgent(a);
            }}
          />
          <Button
            variant="accent"
            disabled={!ready || busy}
            onClick={() => void start()}
            className={s['startBtn'] ?? ''}
            data-design-start-go="true"
          >
            {t.start}
          </Button>
        </div>
      </div>
    </div>
  );
}
