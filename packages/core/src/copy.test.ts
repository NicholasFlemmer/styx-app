import { describe, expect, it } from 'vitest';
import { copy, defaultProjectLocation, fill, platformCopy } from './copy';

describe('copy (spec §10 verbatim)', () => {
  it('key strings', () => {
    expect(copy.palette.placeholder).toBe('switch, spawn, deploy, grant, diff…');
    expect(copy.palette.titlebarField).toBe('Switch, spawn, deploy, grant…');
    expect(copy.board.empty.working).toBe('No agents running. Spawn one below, or ask in the palette.');
    expect(copy.grantSheet.prodNote).toBe(
      'Prod write requires {mfa}. Token is scoped to this session and revoked on expiry or when the session ends. Logged to audit.',
    );
    expect(copy.grantResult.line).toBe('grant: {target} · {scopes} · expires in {t}');
    expect(copy.policies.askMfaProdWrite).toBe('Always ask, require {mfa} for prod write');
    expect(copy.empty.targets).toBe(
      'No targets connected. Agents can still work locally; the first time one asks for a deploy or server, Styx opens this connect flow inline.',
    );
    expect(copy.errors.conflict.text).toBe(
      '{branch} conflicts with main in {file}. {agent} is paused until resolved.',
    );
    expect(copy.onboarding.editor.headline).toBe('Connect your editor.');
    expect(copy.connect.ssh.body).toBe(
      "Agents get a forwarded agent socket for the grant's duration, never the key file.",
    );
    expect(copy.spawn.firstMessagePlaceholder).toBe('What should {agent} do? Reference files with @.');
    expect(copy.toast.title).toBe('{agent} wants {target} · {scope}');
  });

  it('tone: no exclamation marks, no "please"', () => {
    const walk = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : v !== null && typeof v === 'object' ? Object.values(v).flatMap(walk) : [];
    const strings = walk(copy);
    expect(strings.length).toBeGreaterThan(200);
    expect(strings.filter((s) => s.includes('!'))).toEqual([]);
    expect(strings.filter((s) => /\bplease\b/i.test(s))).toEqual([]);
  });

  it('fill substitutes known placeholders and leaves unknown ones visible', () => {
    expect(fill(copy.grantResult.line, { target: 'supabase-prod', scopes: 'read+write', t: '59m' })).toBe(
      'grant: supabase-prod · read+write · expires in 59m',
    );
    expect(fill(copy.grantSheet.grantMfa, { duration: '1h', mfa: platformCopy('darwin').mfa })).toBe(
      'Grant 1h · Touch ID',
    );
    expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}');
  });

  it('platform words', () => {
    expect(platformCopy('darwin')).toEqual({
      mfa: 'Touch ID',
      mfaFallback: 'password',
      mod: '⌘',
      keychainName: 'macOS Keychain',
      keychainShort: 'Keychain',
      defaultProjectDir: '~/code',
      shell: 'zsh',
    });
    expect(platformCopy('win32')).toEqual({
      mfa: 'Windows Hello',
      mfaFallback: 'PIN',
      mod: 'Ctrl',
      keychainName: 'Windows Credential Manager',
      keychainShort: 'Credential Manager',
      defaultProjectDir: 'C:\\dev',
      shell: 'PowerShell',
    });
    expect(defaultProjectLocation('orders-service', 'darwin')).toBe('~/code/orders-service');
    expect(defaultProjectLocation('orders-service', 'win32')).toBe('C:\\dev\\orders-service');
  });
});
