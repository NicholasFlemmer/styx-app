import { fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  autoBranch,
  autoBranchFor,
  cliMissing,
  cliVersionLabel,
  createLabel,
  githubNote,
  githubTargetOf,
  keyFormValid,
  methodLabel,
  methodOf,
  newProjectPayload,
  newProjectValid,
  spawnPayload,
  spawnValid,
  sshFormValid,
} from './modals';

const acme = fixtures.ids.project.acmeShop;

describe('connect helpers', () => {
  it.each([
    ['vercel', 'oauth', 'OAuth'],
    ['aws', 'key', 'IAM / key'],
    ['gcp', 'key', 'IAM / key'],
    ['supabase', 'oauth', 'OAuth'],
    ['github', 'oauth', 'OAuth'],
    ['ssh', 'ssh', 'SSH'],
  ] as const)('%s → %s (%s)', (provider, method, label) => {
    expect(methodOf(provider)).toBe(method);
    expect(methodLabel(provider)).toBe(label);
  });

  it('validates key and ssh forms field by field', () => {
    expect(keyFormValid({ name: '', accessKey: 'AKIA', secret: 's' })).toBe(false);
    expect(keyFormValid({ name: 'acme-prod', accessKey: ' ', secret: 's' })).toBe(false);
    expect(keyFormValid({ name: 'acme-prod', accessKey: 'AKIA', secret: '' })).toBe(false);
    expect(keyFormValid({ name: 'acme-prod', accessKey: 'AKIA', secret: 's' })).toBe(true);
    expect(sshFormValid({ host: 'h', user: 'u', keyPath: '' })).toBe(false);
    expect(sshFormValid({ host: 'h', user: 'u', keyPath: '~/.ssh/id_ed25519' })).toBe(true);
  });
});

describe('spawn helpers', () => {
  const model = fixtures.demoReadModel();

  it('auto-names the branch agent/<name>-<n> with the first free counter', () => {
    expect(autoBranch('claude', 'agent/', [])).toBe('agent/claude-1');
    expect(autoBranch('claude', 'agent/', ['agent/claude-1', 'agent/claude-2'])).toBe('agent/claude-3');
    expect(autoBranch('claude', 'agent/', ['agent/claude-2'])).toBe('agent/claude-1');
    expect(autoBranch('cursor', 'agent/', ['agent/cursor-1'])).toBe('agent/cursor-2');
    expect(autoBranch('gemini', 'ai/', ['agent/gemini-1'])).toBe('ai/gemini-1');
    expect(autoBranchFor(model, acme, 'codex')).toBe('agent/codex-1');
  });

  it('labels tiles with binary + version and flags missing CLIs', () => {
    expect(cliVersionLabel(model.discovery.clis[0])).toBe('claude 2.4.1');
    expect(cliVersionLabel(model.discovery.clis[3])).toBe('cursor-agent 0.5.2');
    expect(cliVersionLabel(model.discovery.clis[4])).toBe('zsh 5.9');
    expect(cliVersionLabel(undefined)).toBe('not found on PATH');
    expect(cliMissing(model, 'codex')).toBe(false);
    expect(cliMissing(fixtures.errorReadModel(), 'codex')).toBe(true);
  });

  it('builds the session.spawn payload for a new worktree and blocks missing CLIs', () => {
    const form = {
      agent: 'claude' as const,
      worktree: 'new',
      branch: ' agent/claude-1 ',
      firstMessage: 'Add tests',
      toggles: { autoApproveEdits: false, mayRequestTargets: true, notifyWhenNeedsMe: true },
    };
    expect(spawnPayload(model, acme, form)).toEqual({
      projectId: acme,
      agent: 'claude',
      worktree: { kind: 'new', base: 'main', branch: 'agent/claude-1' },
      firstMessage: 'Add tests',
      toggles: form.toggles,
      model: null,
    });
    expect(spawnValid(model, form)).toBe(true);
    expect(spawnValid(model, { ...form, branch: '  ' })).toBe(false);
    expect(spawnValid(fixtures.errorReadModel(), { ...form, agent: 'codex' })).toBe(false);
    const existing = spawnPayload(model, acme, { ...form, worktree: fixtures.ids.worktree.fixCheckout });
    expect(existing.worktree).toEqual({ kind: 'existing', worktreeId: fixtures.ids.worktree.fixCheckout });
  });
});

describe('new project helpers', () => {
  const model = fixtures.demoReadModel();
  const base = {
    name: 'orders-service',
    location: '~/code/orders-service',
    startFrom: 'agent' as const,
    template: 'node',
    brief: 'A TypeScript service.',
    gitInit: true,
    createGithubRepo: true,
    copyTargets: false,
    openInIde: false,
  };

  it('validates per start-from kind', () => {
    expect(newProjectValid(base)).toBe(true);
    expect(newProjectValid({ ...base, name: ' ' })).toBe(false);
    expect(newProjectValid({ ...base, brief: '' })).toBe(false);
    expect(newProjectValid({ ...base, startFrom: 'empty', brief: '' })).toBe(true);
    expect(newProjectValid({ ...base, startFrom: 'template', template: '' })).toBe(false);
  });

  it('builds project.create payloads', () => {
    expect(newProjectPayload(base, 'claude', acme)).toEqual({
      name: 'orders-service',
      location: '~/code/orders-service',
      startFrom: { kind: 'agent', agent: 'claude', brief: 'A TypeScript service.' },
      gitInit: true,
      createGithubRepo: true,
      copyTargetsFrom: null,
      openInIde: false,
    });
    expect(
      newProjectPayload({ ...base, startFrom: 'template', copyTargets: true }, 'claude', acme).startFrom,
    ).toEqual({
      kind: 'template',
      template: 'node',
    });
    expect(newProjectPayload({ ...base, copyTargets: true }, 'claude', acme).copyTargetsFrom).toBe(acme);
    expect(newProjectPayload({ ...base, startFrom: 'empty' }, 'claude', null).startFrom).toEqual({
      kind: 'empty',
    });
  });

  it('writes the GitHub note from the target owner and the footer label per platform', () => {
    const gh = githubTargetOf(model, acme);
    if (gh === undefined) throw new Error('no github target');
    expect(githubNote(gh, 'orders-service')).toBe(
      'GitHub acme · persistent grant · repo will be acme/orders-service',
    );
    expect(githubTargetOf(model, fixtures.ids.project.infraTools)).toBeUndefined();
    expect(createLabel('agent', 'claude', 'darwin', '⌘')).toBe('Create · spawn Claude Code · ⌘⏎');
    expect(createLabel('empty', 'claude', 'win32', 'Ctrl')).toBe('Create · Ctrl⏎');
  });
});
