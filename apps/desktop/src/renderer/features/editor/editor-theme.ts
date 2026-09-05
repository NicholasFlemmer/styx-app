import { colors, type Theme } from '@styx/tokens';

/** Structural copy of Monaco's `IStandaloneThemeData` so this module stays free of the Monaco import (testable in jsdom). */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

export const monacoThemeName = (theme: Theme): string => `styx-${theme}`;

const hex = (value: string): string => value.replace(/^#/, '');

/**
 * Monochrome editor theme from the tokens (plan §8 Tricky pieces): `--bg` surface, `--mu` line numbers and
 * comments, `--tx` everything else. Alpha tokens (`--add`, `--dim`) are not theme colours; the hunk background
 * comes from `.styx-hunk-line` CSS instead.
 */
export const monacoTheme = (theme: Theme): MonacoThemeData => {
  const c = colors[theme];
  return {
    base: theme === 'dark' ? 'vs-dark' : 'vs',
    inherit: false,
    rules: [
      { token: '', foreground: hex(c.tx) },
      { token: 'comment', foreground: hex(c.mu) },
      { token: 'comment.doc', foreground: hex(c.mu) },
    ],
    colors: {
      'editor.background': c.bg,
      'editor.foreground': c.tx,
      'editorGutter.background': c.bg,
      'editorLineNumber.foreground': c.mu,
      'editorLineNumber.activeForeground': c.mu,
      'editorCursor.foreground': c.tx,
      'editor.selectionBackground': c.s2,
      'editor.inactiveSelectionBackground': c.s2,
      'editor.selectionHighlightBackground': c.s2,
      'editor.lineHighlightBackground': c.bg,
      'editor.lineHighlightBorder': c.bg,
      'editor.findMatchBackground': c.s2,
      'editor.findMatchHighlightBackground': c.s2,
      'editorBracketHighlight.foreground1': c.tx,
      'editorBracketHighlight.foreground2': c.tx,
      'editorBracketHighlight.foreground3': c.tx,
      'editorBracketHighlight.foreground4': c.tx,
      'editorBracketHighlight.foreground5': c.tx,
      'editorBracketHighlight.foreground6': c.tx,
      'editorBracketMatch.background': c.s2,
      'editorBracketMatch.border': c.ln,
      'editorIndentGuide.background': c.bg,
      'editorIndentGuide.activeBackground': c.bg,
      'editorWhitespace.foreground': c.ln,
      'editorWidget.background': c.s1,
      'editorWidget.foreground': c.tx,
      'editorWidget.border': c.tx,
      'input.background': c.bg,
      'input.foreground': c.tx,
      'input.border': c.ln,
      'inputOption.activeBorder': c.ac,
      focusBorder: c.ac,
      'scrollbar.shadow': c.bg,
      'scrollbarSlider.background': c.ln,
      'scrollbarSlider.hoverBackground': c.mu,
      'scrollbarSlider.activeBackground': c.mu,
      'widget.shadow': c.bg,
    },
  };
};

/** Language id from a file path (highlighting only; ADR-0002: no language service). */
export const languageOf = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'sh':
    case 'zsh':
    case 'bash':
      return 'shell';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return 'plaintext';
  }
};

/** Status-bar language label ("TS", "JSON"); plaintext files read as "TXT". */
export const languageLabelOf = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toUpperCase();
  return ext === '' || ext === path.toUpperCase() ? 'TXT' : ext;
};
