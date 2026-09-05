/**
 * Monaco bootstrap (plan §8 Tricky pieces): the ESM core API, Vite `?worker` workers (editor + ts + json + css +
 * html, bundled as ES workers by `worker.format:'es'`), monarch tokenizers for highlighting only (ADR-0002: no
 * language service, so no diagnostics workers are ever started), a curated set of editing features, and the two
 * monochrome themes from the tokens.
 *
 * monaco-editor ≥ 0.53 maps `monaco-editor/<path>` onto `esm/vs/<path>.js` through its exports map.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/bracketMatching/register';
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
