import { describe, expect, it } from 'vitest';
import { demoClis, demoIdes, errorFixture } from '../fixtures/demo';
import {
  cliAccountLabel,
  cliAuthLabel,
  cliConnectionLabel,
  cliConnectionState,
  cliVersionLabel,
  ideImportsLabel,
  ideVersionLabel,
} from './discovery';

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

describe('agent connection state (Settings › Agents)', () => {
  it('demo rows: claude/codex connected, gemini signed out, cursor unverified, shell ready', () => {
    expect(demoClis().map((c) => [c.agent, cliConnectionState(c), cliAccountLabel(c)])).toEqual([
      ['claude', 'connected', 'nic@acme.dev'],
      ['codex', 'connected', 'ChatGPT'],
      ['gemini', 'signed-out', '—'],
      ['cursor', 'unverified', 'nic@acme.dev'],
      ['shell', 'shell', '—'],
    ]);
  });

  it.each([
    ['shell wins over everything', { agent: 'shell', found: false, authState: 'n/a', verifiedAt: null }, 'shell'],
    ['not found → missing', { agent: 'codex', found: false, authState: 'signed-in', verifiedAt: 1 }, 'missing'],
    ['signed-out → signed-out', { agent: 'gemini', found: true, authState: 'signed-out', verifiedAt: 1 }, 'signed-out'],
    ['unknown → signed-out', { agent: 'cursor', found: true, authState: 'unknown', verifiedAt: null }, 'signed-out'],
    ['n/a on a real CLI → signed-out', { agent: 'claude', found: true, authState: 'n/a', verifiedAt: 1 }, 'signed-out'],
    ['signed-in, never verified → unverified', { agent: 'claude', found: true, authState: 'signed-in', verifiedAt: null }, 'unverified'],
    ['signed-in and verified → connected', { agent: 'claude', found: true, authState: 'signed-in', verifiedAt: 1 }, 'connected'],
  ] as const)('%s', (_name, cli, expected) => {
    expect(cliConnectionState(cli)).toBe(expected);
  });

  it('labels every state with the verbatim agentsPage copy', () => {
    expect(
      (['connected', 'unverified', 'signed-out', 'missing', 'shell'] as const).map(cliConnectionLabel),
    ).toEqual(['connected', 'not verified', 'signed out', 'not installed', 'ready']);
  });
});
