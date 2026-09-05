import { describe, expect, it } from 'vitest';
import { demoClis, demoIdes, errorFixture } from '../fixtures/demo';
import { cliAuthLabel, cliVersionLabel, ideImportsLabel, ideVersionLabel } from './discovery';

describe('onboarding discovery labels', () => {
  it('IDE rows match the prototype ideDefs', () => {
    expect(demoIdes().map((i) => [i.product, ideVersionLabel(i), ideImportsLabel(i)])).toEqual([
      ['VS Code', '1.98 · /Applications', '14 recents · keybindings · theme'],
      ['Cursor', '1.4', '6 recents · keybindings'],
      ['JetBrains (WebStorm)', '2026.2', '3 recents'],
      ['Neovim', '0.11 · /opt/homebrew', 'recents via shada'],
    ]);
    expect(ideVersionLabel({ version: null, location: null })).toBe('not found on PATH');
    expect(
      ideImportsLabel({ imported: { recents: 0, keybindings: false, theme: true }, recentsSource: null }),
    ).toBe('theme');
    expect(
      ideImportsLabel({
        imported: { recents: 0, keybindings: false, theme: false },
        recentsSource: 'state-db',
      }),
    ).toBe('—');
  });

  it('CLI rows match the prototype obClis, including the missing-codex error state', () => {
    expect(demoClis().map((c) => [cliVersionLabel(c), cliAuthLabel(c)])).toEqual([
      ['claude 2.4.1', 'signed in'],
      ['codex 0.9.3', 'signed in'],
      ['gemini 1.2.0', 'Sign in →'],
      ['cursor-agent 0.5.2', 'signed in'],
      ['zsh 5.9', '—'],
    ]);
    const codex = errorFixture().clis.find((c) => c.agent === 'codex');
    expect(codex && [cliVersionLabel(codex), cliAuthLabel(codex)]).toEqual([
      'not found on PATH',
      'Install →',
    ]);
    expect(cliAuthLabel({ found: true, authState: 'unknown' })).toBe('Sign in →');
    expect(cliVersionLabel({ agent: 'gemini', found: true, version: null, binary: null })).toBe('gemini');
    expect(cliVersionLabel({ agent: 'gemini', found: true, version: '1.0', binary: '' })).toBe('gemini 1.0');
  });
});
