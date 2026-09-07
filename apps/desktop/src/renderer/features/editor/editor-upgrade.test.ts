import { copy } from '@styx/core';
import { colors } from '@styx/tokens';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_BY_EXT, languageLabelOf, languageOf, monacoTheme, syntaxRules } from './editor-theme';
import { isBinaryText, MAX_EDITABLE_BYTES } from './fs-source';
import { editorReadoutItems } from './status-bar';

const NUL = String.fromCharCode(0);

describe('languageOf', () => {
  it.each([
    ['src/app.ts', 'typescript'],
    ['src/app.tsx', 'typescript'],
    ['src/app.mjs', 'javascript'],
    ['main.py', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['q.sql', 'sql'],
    ['deploy.yml', 'yaml'],
    ['Dockerfile', 'dockerfile'],
    ['Dockerfile.dev', 'dockerfile'],
    ['.env', 'ini'],
    ['.env.production', 'ini'],
    ['package.json', 'javascript'],
    ['index.html', 'html'],
    ['style.scss', 'scss'],
    ['script.ps1', 'powershell'],
    ['a.c', 'cpp'],
    ['a.h', 'cpp'],
    ['a.cpp', 'cpp'],
    ['A.java', 'java'],
    ['A.kt', 'kotlin'],
    ['A.swift', 'swift'],
    ['a.rb', 'ruby'],
    ['a.php', 'php'],
    ['a.lua', 'lua'],
    ['schema.graphql', 'graphql'],
    ['doc.md', 'markdown'],
    ['run.sh', 'shell'],
    ['notes', 'plaintext'],
  ])('%s -> %s', (path, lang) => {
    expect(languageOf(path)).toBe(lang);
  });

  it('covers the languages a working repo actually contains', () => {
    for (const ext of ['ts', 'tsx', 'js', 'json', 'css', 'html', 'md', 'yml', 'sh', 'py', 'go', 'rs', 'sql'])
      expect(LANGUAGE_BY_EXT[ext]).toBeDefined();
  });
});

describe('languageLabelOf', () => {
  it.each([
    ['src/app.ts', 'TS'],
    ['package.json', 'JSON'],
    ['Dockerfile', 'DOCKERFILE'],
    ['notes', 'TXT'],
  ])('%s -> %s', (path, label) => {
    expect(languageLabelOf(path)).toBe(label);
  });
});

describe('syntax theme', () => {
  it.each(['dark', 'light'] as const)('%s: every rule colour comes from the tokens', (theme) => {
    const c = colors[theme];
    const allowed = new Set([c.tx, c.mu, c.act].map((v) => v.replace('#', '').toLowerCase()));
    for (const rule of syntaxRules({ tx: c.tx, mu: c.mu, act: c.act })) {
      if (rule.foreground === undefined) continue;
      expect(allowed).toContain(rule.foreground.replace('#', '').toLowerCase());
    }
  });

  it('keeps the editor surface monochrome: background and gutter stay on the tokens', () => {
    const t = monacoTheme('dark');
    expect(t.colors['editor.background']).toBe(colors.dark.bg);
    expect(t.colors['editorLineNumber.foreground']).toBe(colors.dark.mu);
  });

  it('comments are muted and strings take the accent-as-text colour', () => {
    const rules = syntaxRules({ tx: '#111111', mu: '#222222', act: '#333333' });
    const by = (token: string) => rules.find((r) => r.token === token)?.foreground;
    // Monaco theme rules take bare hex (no `#`).
    expect(by('comment')).toBe('222222');
    expect(by('string')).toBe('333333');
  });
});

describe('binary and large files', () => {
  it('detects a NUL byte in the probe window only', () => {
    expect(isBinaryText('plain text')).toBe(false);
    expect(isBinaryText(`a${NUL}b`)).toBe(true);
    expect(isBinaryText(`${'x'.repeat(9000)}${NUL}`)).toBe(false);
  });

  it('caps editable files at 1 MB', () => {
    expect(MAX_EDITABLE_BYTES).toBe(1024 * 1024);
  });
});

describe('editorReadoutItems', () => {
  it('shows the caret, then wrap, then any read-only notice', () => {
    expect(editorReadoutItems({ cursor: { line: 12, col: 4 }, wrap: true, readOnly: 'large' })).toEqual([
      'Ln 12, Col 4',
      copy.workspace.editorWrap,
      copy.workspace.editorReadOnly.large,
    ]);
  });

  it('is empty before a file reports anything, so the prototype status bar is unchanged', () => {
    expect(editorReadoutItems({ cursor: null, wrap: false, readOnly: null })).toEqual([]);
  });
});
