import { describe, expect, it } from 'vitest';
import {
  copy,
  defaultCloneLocation,
  defaultProjectLocation,
  fill,
  platformCopy,
  repoNameOfUrl,
} from './copy';

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
    expect(copy.connect.cli.heading).toBe('Connect with {cli}');
    expect(copy.connect.cli.body).toBe(
      "Uses the account you're signed into in {cli}. Styx never sees the password; each grant asks {cli} for a short-lived token. Anything running as you can also use {cli}, so prefer scoped roles for prod.",
    );
    expect(copy.connect.cli.waiting).toBe('Waiting for {command}…');
    expect(fill(copy.connect.cli.via, { cli: 'gcloud', account: 'nic@acme.dev' })).toBe(
      'via gcloud · nic@acme.dev',
    );
    expect(copy.targets.actions.refresh).toBe('Refresh');
    // Plain-folder projects (owner decision; spec tone, not §10).
    expect(copy.repo.noGit).toEqual({
      label: 'Not a git repository',
      body: 'Agents work in this folder directly. Initialise git to get isolated worktrees, diffs and reviews.',
      cta: 'Initialise git',
    });
    expect(copy.spawn.worktreeFolder).toBe('This folder (no worktree isolation)');
    expect(copy.workspace.noGit).toBe('no git');
    expect(copy.toast.title).toBe('{agent} wants {target} · {scope}');
  });

  it('owner additions (rail menu, clone mode, palette open/clone rows, onboarding add-row segments)', () => {
    expect(copy.rail.menu).toEqual({
      newProject: 'New project…',
      addExisting: 'Add from recent…',
      openFolder: 'Open folder…',
      cloneUrl: 'Clone URL…',
    });
    expect(copy.addExisting.title).toBe('Add from recent projects');
    expect(fill(copy.addExisting.add, { n: '3' })).toBe('Add 3');
    expect(copy.newProject.clone.title).toBe('Clone repository');
    expect(fill(copy.newProject.clone.clone, { mod: '⌘' })).toBe('Clone · ⌘⏎');
    expect(copy.palette.actions.addExisting).toBe('Add from recent projects…');
    expect(copy.palette.actions.openFolder).toBe('Open folder…');
    expect(copy.palette.actions.cloneUrl).toBe('Clone URL…');
    // The three segments concatenate to the §10 add-row string so the row renders unchanged.
    const { addRowNew, addRowSep, addRowFolder, addRowClone, addRow } = copy.onboarding.projects;
    expect(`${addRowNew}${addRowSep}${addRowFolder}${addRowSep}${addRowClone}`).toBe(addRow);
  });

  it('owner additions (Claude Code parity, discrepancy #54): session controls, settings rows, tool glyphs', () => {
    expect(copy.chat.controls).toMatchObject({
      permissions: 'Permissions',
      model: 'Model',
      effort: 'Effort',
      stop: 'Stop · esc',
    });
    expect(fill(copy.chat.controls.usage, { cost: '$0.12', turns: '3' })).toBe('$0.12 · 3 turns');
    expect(copy.settings.rows.permissionMode).toBe('Permission mode');
    expect(copy.settings.rows.effort).toBe('Effort');
    expect(Object.keys(copy.session.permissionModes)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'dontAsk',
      'auto',
    ]);
    expect(Object.keys(copy.session.permissionModeHints)).toEqual(Object.keys(copy.session.permissionModes));
    expect(Object.keys(copy.session.efforts)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(Object.keys(copy.session.models)).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku']);
    expect(copy.session.tool).toEqual({ running: '…', ok: '✓', error: '×' });
  });

  it('repoNameOfUrl / defaultCloneLocation derive the folder from the clone URL', () => {
    expect(repoNameOfUrl('git@github.com:acme/shop.git')).toBe('shop');
    expect(repoNameOfUrl('https://github.com/acme/shop/')).toBe('shop');
    expect(repoNameOfUrl('https://gitlab.com/group/sub/app.GIT')).toBe('app');
    expect(repoNameOfUrl('/srv/git/tools')).toBe('tools');
    expect(repoNameOfUrl('  ')).toBe('');
    expect(defaultCloneLocation('git@github.com:acme/shop.git', 'darwin')).toBe('~/code/shop');
    expect(defaultCloneLocation('https://github.com/acme/shop', 'win32')).toBe('C:\\dev\\shop');
    expect(defaultCloneLocation('', 'darwin')).toBe('~/code');
  });

  it('a11y-only strings (spec §9, not §10) keep the spec tone', () => {
    expect(copy.settings.rows.screenReader).toBe('Screen reader mode');
    expect(copy.palette.resultsLabel).toBe('Results');
    expect(copy.targets.acceptProjectPolicies).toBe('Accept project policies');
    expect(copy.onboarding.stepsLabel).toBe('Steps');
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
