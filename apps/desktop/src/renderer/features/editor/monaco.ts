/**
 * Monaco bootstrap (plan §8 Tricky pieces): the ESM core API, Vite `?worker` workers (editor + ts + json + css +
 * html, bundled as ES workers by `worker.format:'es'`), monarch tokenizers for highlighting only (ADR-0002: no
 * language service, so no diagnostics workers are ever started), a curated set of editing features, and the two
 * monochrome themes from the tokens.
 *
 * monaco-editor ≥ 0.53 maps `monaco-editor/<path>` onto `esm/vs/<path>.js` through its exports map.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
// Every monarch tokenizer monaco ships (84 languages): highlighting only — ADR-0002 keeps the language services
// off, so no diagnostics worker ever starts. One import instead of a hand-kept list that silently rots.
// JSON has no monarch tokenizer (only a full language service, 1.2 MB + a worker), so `.json` uses the
// JavaScript tokenizer: strings, numbers and punctuation highlight correctly without any service.
import 'monaco-editor/languages/definitions/register.all';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/gotoLine/register';
import 'monaco-editor/features/format/register';
import 'monaco-editor/features/suggest/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/links/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import { monacoTheme, monacoThemeName } from './editor-theme';

let booted = false;

const workerFor = (label: string): Worker => {
  switch (label) {
    case 'typescript':
    case 'javascript':
      return new TsWorker({ name: label });
    case 'json':
      return new JsonWorker({ name: label });
    case 'css':
    case 'scss':
    case 'less':
      return new CssWorker({ name: label });
    case 'html':
    case 'handlebars':
    case 'razor':
      return new HtmlWorker({ name: label });
    default:
      return new EditorWorker({ name: label });
  }
};

/** Idempotent: installs `MonacoEnvironment.getWorker` and defines both themes. */
export const bootMonaco = (): typeof monaco => {
  if (booted) return monaco;
  booted = true;
  (self as unknown as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    getWorker: (_workerId: string, label: string) => workerFor(label),
  };
  monaco.editor.defineTheme(monacoThemeName('dark'), monacoTheme('dark'));
  monaco.editor.defineTheme(monacoThemeName('light'), monacoTheme('light'));
  return monaco;
};

export { monaco };
