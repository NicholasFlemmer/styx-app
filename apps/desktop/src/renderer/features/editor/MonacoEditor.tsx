import type { AgentChange, WorktreeId } from '@styx/core';
import type { Theme } from '@styx/tokens';
import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';
import { languageLabelOf, languageOf, monacoThemeName } from './editor-theme';
import { readWorktreeFile, writeWorktreeFile, type FileSource } from './fs-source';
import { buildHunkDecorations } from './hunk-decorations';
import { bootMonaco, monaco } from './monaco';
import s from './MonacoEditor.module.css';

type CodeEditor = monaco.editor.IStandaloneCodeEditor;

interface ModelEntry {
  model: monaco.editor.ITextModel;
  source: FileSource;
  eol: 'lf' | 'crlf';
  writeTimer: number | null;
}

/** One editor per worktree (plan §8): the DOM host survives unmounts so view state and models persist. */
interface EditorEntry {
  editor: CodeEditor;
  host: HTMLDivElement;
  models: Map<string, ModelEntry>;
  viewStates: Map<string, monaco.editor.ICodeEditorViewState | null>;
  decorations: monaco.editor.IEditorDecorationsCollection;
  /** Right-pinned `{agent} · {age}` labels, one overlay widget per labelled line. */
  labels: LabelWidget[];
  path: string | null;
}

interface LabelWidget {
  widget: monaco.editor.IOverlayWidget;
  node: HTMLDivElement;
  line: number;
}

const editors = new Map<string, EditorEntry>();
const WRITE_DEBOUNCE_MS = 500;

const currentTheme = (): Theme => (document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');

let themeWatched = false;
/** `data-theme` on <html> drives `monaco.editor.setTheme` (plan §8 Theme). */
const watchTheme = (): void => {
  if (themeWatched || typeof MutationObserver !== 'function') return;
  themeWatched = true;
  new MutationObserver(() => monaco.editor.setTheme(monacoThemeName(currentTheme()))).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] },
  );
};

/**
 * Prototype recipe: JetBrains Mono 12.5/22, 30px right-aligned line numbers (4 × 7.5px digits; the spec's 3 chars
 * would sit the code 7px left of the prototype) + 14px decoration gap, nothing else drawn.
 */
const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12.5,
  lineHeight: 22,
  fontLigatures: false,
  lineNumbersMinChars: 4,
  lineDecorationsWidth: 14,
  glyphMargin: false,
  folding: false,
  minimap: { enabled: false },
  renderLineHighlight: 'none',
  scrollBeyondLastLine: false,
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
  padding: { top: 10, bottom: 10 },
  automaticLayout: true,
  roundedSelection: false,
  cursorSmoothCaretAnimation: 'off',
  smoothScrolling: false,
  renderWhitespace: 'none',
  guides: { indentation: false, bracketPairs: false },
  bracketPairColorization: { enabled: false },
  matchBrackets: 'never',
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  wordBasedSuggestions: 'off',
  parameterHints: { enabled: false },
  hover: { enabled: 'off' },
  codeLens: false,
  lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
  links: false,
  colorDecorators: false,
  renderValidationDecorations: 'off',
  stickyScroll: { enabled: false },
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
  fixedOverflowWidgets: true,
  contextmenu: false,
};

const accessibility = (screenReader: boolean): 'on' | 'auto' => (screenReader ? 'on' : 'auto');

const getEntry = (worktreeId: WorktreeId, screenReader: boolean): EditorEntry => {
  const existing = editors.get(worktreeId);
  if (existing !== undefined) return existing;
  bootMonaco();
  watchTheme();
  const host = document.createElement('div');
  host.className = s['host'] ?? '';
  const editor = monaco.editor.create(host, {
    ...OPTIONS,
    theme: monacoThemeName(currentTheme()),
    accessibilitySupport: accessibility(screenReader),
    model: null,
  });
  const entry: EditorEntry = {
    editor,
    host,
    models: new Map(),
    viewStates: new Map(),
    decorations: editor.createDecorationsCollection([]),
    labels: [],
    path: null,
  };
  editor.onDidScrollChange(() => positionLabels(entry));
  editors.set(worktreeId, entry);
  void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
  return entry;
};

const uriFor = (worktreeId: WorktreeId, path: string): monaco.Uri =>
  monaco.Uri.from({ scheme: 'styx', authority: worktreeId, path: `/${path}` });

/** Models per file path; fs-backed models write back (debounced) through `fs.writeFile`. */
const getModel = async (entry: EditorEntry, worktreeId: WorktreeId, path: string): Promise<ModelEntry> => {
  const cached = entry.models.get(path);
  if (cached !== undefined) return cached;
  const loaded = await readWorktreeFile(worktreeId, path);
  const again = entry.models.get(path);
  if (again !== undefined) return again;
  const model = monaco.editor.createModel(loaded.text, languageOf(path), uriFor(worktreeId, path));
  // Monochrome: bracket pair colours are a model option, not an editor one.
  model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
  model.setEOL(
    loaded.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
  );
  const me: ModelEntry = { model, source: loaded.source, eol: loaded.eol, writeTimer: null };
  model.onDidChangeContent(() => {
    if (me.source !== 'fs') return;
    if (me.writeTimer !== null) window.clearTimeout(me.writeTimer);
    me.writeTimer = window.setTimeout(() => {
      me.writeTimer = null;
      writeWorktreeFile(worktreeId, path, model.getValue());
    }, WRITE_DEBOUNCE_MS);
  });
  entry.models.set(path, me);
  return me;
};

export interface FileState {
  eol: 'lf' | 'crlf';
  lang: string;
}

export interface MonacoEditorProps {
  worktreeId: WorktreeId;
  /** Open file (tree path) or null for an empty editor. */
  path: string | null;
  /** Agent changes of this worktree (pending ones decorate the open file). */
  changes: readonly AgentChange[];
  agentOf: (sessionId: AgentChange['sessionId']) => string;
  /** Clock for the `{agent} · {age}` labels (re-rendered every 30 s by the caller). */
  now: number;
  /** settings.app.screenReader → Monaco `accessibilitySupport: 'on'`. */
  screenReader: boolean;
  onFileState?: (state: FileState | null) => void;
}

const toDecorations = (
  model: monaco.editor.ITextModel,
  decos: ReturnType<typeof buildHunkDecorations>,
): monaco.editor.IModelDeltaDecoration[] =>
  decos
    .filter((d) => d.line <= model.getLineCount())
    .map((d) => ({
      range: new monaco.Range(d.line, 1, d.line, 1),
      options: {
        isWholeLine: true,
        className: 'styx-hunk-line',
        marginClassName: 'styx-hunk-line',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));

const positionLabels = (entry: EditorEntry): void => {
  const scrollTop = entry.editor.getScrollTop();
  for (const l of entry.labels) {
    l.node.style.top = `${entry.editor.getTopForLineNumber(l.line) - scrollTop}px`;
  }
};

/**
 * `{agent} · {age}` pinned to the right of the first added line of each hunk. Overlay widgets rather than
 * injected text: Monaco positions `.view-line > span` absolutely, so an inline label can only pin to the text's
 * right edge, not the line's.
 */
const setLabels = (entry: EditorEntry, decos: ReturnType<typeof buildHunkDecorations>): void => {
  for (const l of entry.labels) entry.editor.removeOverlayWidget(l.widget);
  entry.labels = [];
  const lineCount = entry.editor.getModel()?.getLineCount() ?? 0;
  for (const d of decos) {
    if (d.label === null || d.line > lineCount) continue;
    const node = document.createElement('div');
    node.className = 'styx-hunk-label';
    node.textContent = d.label;
    const widget: monaco.editor.IOverlayWidget = {
      getId: () => `styx.hunk-label.${d.hunkId}.${d.line}`,
      getDomNode: () => node,
      getPosition: () => null,
    };
    entry.editor.addOverlayWidget(widget);
    entry.labels.push({ widget, node, line: d.line });
  }
  positionLabels(entry);
};

/**
 * Monaco bound to a worktree: models per path, hunk decorations (`.styx-hunk-line` + right-pinned label),
 * theme follows `data-theme`, `data-keyscope="editor"` so only RESERVED chords leave the editor.
 */
export function MonacoEditor({
  worktreeId,
  path,
  changes,
  agentOf,
  now,
  screenReader,
  onFileState,
}: MonacoEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const entryRef = useRef<EditorEntry | null>(null);
  const [attached, setAttached] = useState<WorktreeId | null>(null);
  const [loaded, setLoaded] = useState<{ worktreeId: WorktreeId; path: string } | null>(null);
  const [contentVersion, setContentVersion] = useState(0);
  const fileStateCb = useRef(onFileState);
  useEffect(() => {
    fileStateCb.current = onFileState;
  }, [onFileState]);

  // Mount: attach the worktree's persistent host; detach (never dispose) on unmount.
  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    const e = getEntry(worktreeId, screenReader);
    entryRef.current = e;
    el.append(e.host);
    e.editor.layout();
    setAttached(worktreeId);
    return () => {
      e.host.remove();
      entryRef.current = null;
    };
    // screenReader is applied by its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  useEffect(() => {
    entryRef.current?.editor.updateOptions({ accessibilitySupport: accessibility(screenReader) });
  }, [attached, screenReader]);

  // Open file → model (cached per path) + restored view state.
  useEffect(() => {
    const entry = entryRef.current;
    if (entry === null || attached !== worktreeId) return;
    let cancelled = false;
    const open = async (): Promise<{ worktreeId: WorktreeId; path: string } | null> => {
      if (entry.path !== null) entry.viewStates.set(entry.path, entry.editor.saveViewState());
      if (path === null) {
        entry.editor.setModel(null);
        entry.path = null;
        fileStateCb.current?.(null);
        return null;
      }
      const me = await getModel(entry, worktreeId, path);
      if (cancelled) return null;
      entry.editor.setModel(me.model);
      const view = entry.viewStates.get(path);
      if (view !== undefined && view !== null) entry.editor.restoreViewState(view);
      entry.path = path;
      fileStateCb.current?.({
        eol: me.model.getEOL() === '\r\n' ? 'crlf' : 'lf',
        lang: languageLabelOf(path),
      });
      return { worktreeId, path };
    };
    void open().then((state) => {
      if (!cancelled) setLoaded(state);
    });
    return () => {
      cancelled = true;
    };
  }, [attached, worktreeId, path]);

  // Edits shift hunk lines: bump a version so decorations are re-anchored.
  useEffect(() => {
    const entry = entryRef.current;
    if (entry === null || loaded === null) return;
    const model = entry.editor.getModel();
    if (model === null) return;
    let frame = 0;
    const sub = model.onDidChangeContent(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setContentVersion((v) => v + 1));
    });
    return () => {
      cancelAnimationFrame(frame);
      sub.dispose();
    };
  }, [loaded]);

  // Hunk decorations for the open file; `now` re-renders the age labels.
  useEffect(() => {
    const entry = entryRef.current;
    if (entry === null || loaded === null || loaded.path !== path) return;
    const model = entry.editor.getModel();
    if (model === null) return;
    const decos = buildHunkDecorations({
      changes,
      path: loaded.path,
      modelLines: model.getLinesContent(),
      agentOf,
      now,
    });
    entry.decorations.set(toDecorations(model, decos));
    setLabels(entry, decos);
  }, [loaded, path, changes, agentOf, now, contentVersion]);

  const onFocus = useCallback((e: FocusEvent<HTMLDivElement>) => {
    // Focus returned to the scope root (overlay close) lands in Monaco itself.
    if (e.target === e.currentTarget) entryRef.current?.editor.focus();
  }, []);

  return (
    <div
      ref={container}
      className={s['root']}
      data-keyscope="editor"
      data-editor-file={path ?? undefined}
      tabIndex={-1}
      onFocus={onFocus}
    />
  );
}
