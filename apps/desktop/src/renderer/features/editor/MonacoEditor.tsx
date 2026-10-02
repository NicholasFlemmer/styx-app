import type { AgentChange, WorktreeId } from '@styx/core';
import type { Theme } from '@styx/tokens';
import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';
import { command } from '../../state/commands';
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
  /** Binary or over the size cap: the editor is read-only and never writes back (discrepancies #58). */
  readOnly: 'binary' | 'large' | null;
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
  folding: true,
  showFoldingControls: 'mouseover',
  foldingHighlight: false,
  minimap: { enabled: false },
  renderLineHighlight: 'line',
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
  guides: { indentation: true, bracketPairs: false, highlightActiveIndentation: false },
  bracketPairColorization: { enabled: false },
  matchBrackets: 'always',
  occurrencesHighlight: 'singleFile',
  selectionHighlight: false,
  quickSuggestions: { other: true, comments: false, strings: false },
  suggestOnTriggerCharacters: true,
  wordBasedSuggestions: 'currentDocument',
  suggest: { showWords: true, showIcons: false, insertMode: 'insert' },
  acceptSuggestionOnEnter: 'off',
  parameterHints: { enabled: false },
  hover: { enabled: 'on', delay: 250 },
  codeLens: false,
  lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
  links: true,
  colorDecorators: false,
  renderValidationDecorations: 'off',
  stickyScroll: { enabled: false },
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
  fixedOverflowWidgets: true,
  contextmenu: true,
};

const accessibility = (screenReader: boolean): 'on' | 'auto' => (screenReader ? 'on' : 'auto');

/** Word wrap is a per-machine preference (`paneSizes['editor.wordWrap']`, 0 / 1), applied to every editor. */
export const WORD_WRAP_KEY = 'editor.wordWrap';
let wordWrapOn = false;
/** Set by the mounted component so a toggle inside Monaco reaches the ui store. */
let onWordWrapChange: ((on: boolean) => void) | null = null;
export const setWordWrapListener = (fn: ((on: boolean) => void) | null): void => {
  onWordWrapChange = fn;
};

/** Links in code open in the browser through main (https only); Monaco must never navigate the renderer. */
let linkOpenerRegistered = false;
const registerLinkOpener = (): void => {
  if (linkOpenerRegistered) return;
  linkOpenerRegistered = true;
  monaco.editor.registerLinkOpener({
    open: (resource) => {
      const url = resource.toString();
      if (/^https:\/\//.test(url)) void command('link.open', { url });
      return Promise.resolve(true);
    },
  });
};

/** Alt+Z on every editor; the caller persists the new value. */
export const applyWordWrap = (on: boolean): void => {
  wordWrapOn = on;
  for (const e of editors.values()) e.editor.updateOptions({ wordWrap: on ? 'on' : 'off' });
};
export const isWordWrapOn = (): boolean => wordWrapOn;

const getEntry = (worktreeId: WorktreeId, screenReader: boolean): EditorEntry => {
  const existing = editors.get(worktreeId);
  if (existing !== undefined) return existing;
  bootMonaco();
  watchTheme();
  const host = document.createElement('div');
  host.className = s['host'] ?? '';
  registerLinkOpener();
  const editor = monaco.editor.create(host, {
    ...OPTIONS,
    theme: monacoThemeName(currentTheme()),
    accessibilitySupport: accessibility(screenReader),
    wordWrap: wordWrapOn ? 'on' : 'off',
    model: null,
  });
  editor.addAction({
    id: 'styx.toggleWordWrap',
    label: 'Toggle Word Wrap',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
    run: () => {
      applyWordWrap(!wordWrapOn);
      onWordWrapChange?.(wordWrapOn);
    },
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
  editor.onDidLayoutChange(() => positionLabels(entry));
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
  model.updateOptions({
    bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false },
  });
  model.setEOL(
    loaded.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
  );
  const me: ModelEntry = {
    model,
    source: loaded.source,
    eol: loaded.eol,
    writeTimer: null,
    readOnly: loaded.notice ?? null,
  };
  model.onDidChangeContent(() => {
    if (me.source !== 'fs' || me.readOnly !== null) return;
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
  /** 1-based caret position, tracked live (owner addition, discrepancies #58). */
  cursor: { line: number; col: number } | null;
  wrap: boolean;
  readOnly: 'binary' | 'large' | null;
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
  /** Alt+Z inside Monaco: the host persists the preference. */
  onWordWrap?: (on: boolean) => void;
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

/** Gap kept between a line's code and its label; closer than this the label steps aside instead of covering code. */
const LABEL_CLEARANCE = 12;

const positionLabels = (entry: EditorEntry): void => {
  const { editor } = entry;
  const scrollTop = editor.getScrollTop();
  const scrollLeft = editor.getScrollLeft();
  const model = editor.getModel();
  const layout = editor.getLayoutInfo();
  for (const l of entry.labels) {
    l.node.style.top = `${editor.getTopForLineNumber(l.line) - scrollTop}px`;
    if (model === null || l.line > model.getLineCount()) continue;
    // A line that runs under the label (a narrow editor) hides it: never text drawn over code.
    const textRight =
      layout.contentLeft + editor.getOffsetForColumn(l.line, model.getLineMaxColumn(l.line)) - scrollLeft;
    const labelLeft = layout.width - layout.verticalScrollbarWidth - 12 - l.node.offsetWidth;
    l.node.style.visibility = textRight + LABEL_CLEARANCE > labelLeft ? 'hidden' : 'visible';
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
  onWordWrap,
}: MonacoEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const entryRef = useRef<EditorEntry | null>(null);
  const [attached, setAttached] = useState<WorktreeId | null>(null);
  const [loaded, setLoaded] = useState<{ worktreeId: WorktreeId; path: string } | null>(null);
  const [contentVersion, setContentVersion] = useState(0);
  const fileStateCb = useRef(onFileState);
  const stateRef = useRef<FileState | null>(null);
  const wordWrapCb = useRef(onWordWrap);
  useEffect(() => {
    wordWrapCb.current = onWordWrap;
  }, [onWordWrap]);
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

  // Live caret position and the word-wrap toggle feed the status bar (discrepancies #58).
  useEffect(() => {
    const editor = entryRef.current?.editor;
    if (editor === undefined || attached === null) return;
    const patch = (next: Partial<FileState>): void => {
      const current = stateRef.current;
      if (current === null) return;
      const merged = { ...current, ...next };
      stateRef.current = merged;
      fileStateCb.current?.(merged);
    };
    const cursor = editor.onDidChangeCursorPosition((e) =>
      patch({ cursor: { line: e.position.lineNumber, col: e.position.column } }),
    );
    setWordWrapListener((on) => {
      wordWrapCb.current?.(on);
      patch({ wrap: on });
    });
    return () => {
      cursor.dispose();
      setWordWrapListener(null);
    };
  }, [attached]);

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
        stateRef.current = null;
        fileStateCb.current?.(null);
        return null;
      }
      const me = await getModel(entry, worktreeId, path);
      if (cancelled) return null;
      entry.editor.setModel(me.model);
      const view = entry.viewStates.get(path);
      if (view !== undefined && view !== null) entry.editor.restoreViewState(view);
      entry.path = path;
      entry.editor.updateOptions({ readOnly: me.readOnly !== null });
      const pos = entry.editor.getPosition();
      stateRef.current = {
        eol: me.model.getEOL() === '\r\n' ? 'crlf' : 'lf',
        lang: languageLabelOf(path),
        cursor: pos === null ? null : { line: pos.lineNumber, col: pos.column },
        wrap: isWordWrapOn(),
        readOnly: me.readOnly,
      };
      fileStateCb.current?.({
        eol: me.model.getEOL() === '\r\n' ? 'crlf' : 'lf',
        lang: languageLabelOf(path),
        cursor: pos === null ? null : { line: pos.lineNumber, col: pos.column },
        wrap: isWordWrapOn(),
        readOnly: me.readOnly,
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
