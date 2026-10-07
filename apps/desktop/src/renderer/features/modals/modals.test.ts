import { copy, fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  autoBranch,
  autoBranchFor,
  cliMethodLabel,
  cliMissing,
  cliSavePayload,
  cliStatusLine,
  cliTargetMeta,
  cliTargetName,
  cliVersionLabel,
  createLabel,
  defaultAccount,
  defaultProject,
  projectDetail,
  projectTargetMeta,
  githubNote,
  githubTargetOf,
  keyFormValid,
  methodLabel,
  methodOf,
  newProjectPayload,
  newProjectValid,
  primaryStepOf,
  providerCli,
  defaultSessionSettings,
  sessionSettingsFor,
  spawnPayload,
  spawnValid,
  sshFormValid,
  sshPort,
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

  it.each([
    ['vercel', 'vercel', 'cli', 'vercel CLI'],
    ['aws', 'aws', 'cli', 'aws CLI'],
    ['gcp', 'gcloud', 'cli', 'gcloud CLI'],
    ['supabase', 'supabase', 'cli', 'supabase CLI'],
    ['github', 'gh', 'cli', 'gh CLI'],
    ['ssh', null, 'ssh', 'SSH'],
  ] as const)('primary path for %s is %s (%s, tile "%s")', (provider, cli, step, label) => {
    expect(providerCli(provider)).toBe(cli);
    expect(primaryStepOf(provider)).toBe(step);
    expect(cliMethodLabel(provider)).toBe(label);
  });

  const gcloud = {
    installed: true,
    binary: 'gcloud',
    version: '512.0.0',
    loginCommand: 'gcloud auth login',
    accounts: [
      { id: 'nic@acme.dev', label: 'nic@acme.dev', active: false },
      { id: 'ops@acme.dev', label: 'ops@acme.dev', active: true },
    ],
  };

  it('cli status line, default account and target name', () => {
    expect(cliStatusLine('gcloud', gcloud)).toBe('gcloud 512.0.0');
    expect(cliStatusLine('gcloud', { ...gcloud, version: null })).toBe('gcloud');
    expect(cliStatusLine('gcloud', { ...gcloud, binary: null, version: null })).toBe('gcloud');
    expect(cliStatusLine('gh', { ...gcloud, installed: false })).toBe('gh · not found on PATH');
    expect(cliStatusLine('gh', null)).toBe('gh · not found on PATH');
    expect(defaultAccount(gcloud)).toBe('ops@acme.dev');
    expect(
      defaultAccount({ ...gcloud, accounts: gcloud.accounts.map((a) => ({ ...a, active: false })) }),
    ).toBe('nic@acme.dev');
    expect(defaultAccount({ ...gcloud, accounts: [] })).toBeNull();
    expect(defaultAccount(null)).toBeNull();
    expect(cliTargetName('gcp', gcloud.accounts[0], '')).toBe('GCP nic@acme.dev');
    expect(cliTargetName('gcp', gcloud.accounts[0], '  infra ')).toBe('infra');
    expect(cliTargetName('gcp', undefined, '')).toBe('GCP');
    expect(cliTargetName('gcp', { id: 'x', label: ' ', active: true }, '')).toBe('GCP');
  });

  it('builds the target.connect.cliSave payload from the chosen account', () => {
    expect(cliSavePayload(acme, 'gcp', 'staging', gcloud, 'nic@acme.dev', '')).toEqual({
      projectId: acme,
      provider: 'gcp',
      env: 'staging',
      name: 'GCP nic@acme.dev',
      account: 'nic@acme.dev',
      config: {},
    });
  });

  it('cliSave carries the picked project as config.ref (Supabase, issue #5)', () => {
    expect(
      cliSavePayload(acme, 'supabase', 'prod', gcloud, 'nic@acme.dev', 'Supabase prod', 'abc'),
    ).toMatchObject({
      name: 'Supabase prod',
      config: { ref: 'abc' },
    });
  });

  it('project picker: keeps the current project if listed, else the only one, never the first of several', () => {
    const a = { id: 'aaa', name: 'a', region: 'eu-west-1' };
    const b = { id: 'bbb', name: 'b', region: null };
    expect(defaultProject([a, b], null)).toBeNull();
    expect(defaultProject([a, b], 'bbb')).toBe('bbb');
    expect(defaultProject([a, b], 'gone')).toBeNull();
    expect(defaultProject([a], null)).toBe('aaa');
    expect(defaultProject([], null)).toBeNull();
    expect(projectDetail(a)).toBe('aaa · eu-west-1');
    expect(projectDetail(b)).toBe('bbb');
  });

  it('project meta: connected Supabase targets only', () => {
    const m = fixtures.demoReadModel();
    const sb = m.targets.byId[fixtures.ids.target.supabaseProd];
    const aws = m.targets.byId[fixtures.ids.target.awsProd];
    if (sb === undefined || aws === undefined) throw new Error('fixture');
    expect(projectTargetMeta(sb)).toBe('project acme-shop-prod');
    expect(projectTargetMeta({ ...sb, config: {} })).toBe(copy.connect.project.notChosen);
    expect(projectTargetMeta({ ...sb, credentialRef: null })).toBeNull();
    expect(projectTargetMeta(aws)).toBeNull();
  });

  it('cli target meta reads `via <cli> · <account>` only for cli targets', () => {
    const aws = fixtures.demoReadModel().targets.byId[fixtures.ids.target.awsProd];
    if (aws === undefined) throw new Error('no aws target');
    expect(cliTargetMeta(aws)).toBeNull();
    expect(cliTargetMeta({ ...aws, authMethod: 'cli', config: { account: 'acme-prod' } })).toBe(
      'via aws · acme-prod',
    );
    expect(cliTargetMeta({ ...aws, authMethod: 'cli', config: {} })).toBe('via aws · —');
    expect(cliTargetMeta({ ...aws, provider: 'ssh', authMethod: 'cli', config: {} })).toBeNull();
  });

  it('validates key and ssh forms field by field', () => {
    expect(keyFormValid({ name: '', accessKey: 'AKIA', secret: 's' })).toBe(false);
    expect(keyFormValid({ name: 'acme-prod', accessKey: ' ', secret: 's' })).toBe(false);
    expect(keyFormValid({ name: 'acme-prod', accessKey: 'AKIA', secret: '' })).toBe(false);
    expect(keyFormValid({ name: 'acme-prod', accessKey: 'AKIA', secret: 's' })).toBe(true);
    expect(sshFormValid({ host: 'h', user: 'u', keyPath: '', port: '', passphrase: '' })).toBe(false);
    expect(
      sshFormValid({ host: 'h', user: 'u', keyPath: '~/.ssh/id_ed25519', port: '', passphrase: '' }),
    ).toBe(true);
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
      ...defaultSessionSettings(model, acme),
    };
    expect(spawnPayload(model, acme, form)).toEqual({
      projectId: acme,
      agent: 'claude',
      worktree: { kind: 'new', base: 'main', branch: 'agent/claude-1' },
      firstMessage: 'Add tests',
      toggles: form.toggles,
      model: null,
      permissionMode: 'auto',
      effort: null,
    });
    expect(spawnValid(model, form)).toBe(true);
    expect(spawnValid(model, { ...form, branch: '  ' })).toBe(false);
    expect(spawnValid(fixtures.errorReadModel(), { ...form, agent: 'codex' })).toBe(false);
    const existing = spawnPayload(model, acme, { ...form, worktree: fixtures.ids.worktree.fixCheckout });
    expect(existing.worktree).toEqual({ kind: 'existing', worktreeId: fixtures.ids.worktree.fixCheckout });
  });

  it('session settings ride along for every agent but the shell (discrepancies #54, #83)', () => {
    expect(defaultSessionSettings(model, acme)).toEqual({
      permissionMode: 'auto',
      model: null,
      effort: null,
    });
    const chosen = { permissionMode: 'plan' as const, model: 'opus', effort: 'high' as const };
    expect(sessionSettingsFor('claude', chosen)).toEqual(chosen);
    // The modal has already reconciled model / effort against the agent's lists; main maps the mode.
    expect(sessionSettingsFor('cursor', chosen)).toEqual(chosen);
    expect(sessionSettingsFor('codex', chosen)).toEqual(chosen);
    expect(sessionSettingsFor('shell', chosen)).toEqual({
      permissionMode: 'default',
      model: null,
      effort: null,
    });
    const form = {
      agent: 'claude' as const,
      worktree: 'new',
      branch: 'agent/claude-1',
      firstMessage: '',
      toggles: { autoApproveEdits: false, mayRequestTargets: true, notifyWhenNeedsMe: true },
      ...chosen,
    };
    expect(spawnPayload(model, acme, form)).toMatchObject(chosen);
    expect(spawnPayload(model, acme, { ...form, agent: 'shell' })).toMatchObject({
      permissionMode: 'default',
      model: null,
      effort: null,
    });
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

describe('SSH form port', () => {
  const form = (port: string) => ({ host: 'h', user: 'u', keyPath: '/k', port, passphrase: '' });

  it('blank means the default 22', () => {
    expect(sshPort(form(''))).toBe(22);
    expect(sshPort(form('  '))).toBe(22);
  });

  it('accepts a real port and rejects anything that is not one', () => {
    expect(sshPort(form('2222'))).toBe(2222);
    expect(sshPort(form('1'))).toBe(1);
    expect(sshPort(form('65535'))).toBe(65535);
    for (const bad of ['0', '65536', '-1', '22x', 'ssh', '2 2', '999999'])
      expect(sshPort(form(bad))).toBeNull();
  });

  it('an invalid port blocks save, so the form cannot submit a port the contract will reject', () => {
    expect(sshFormValid(form('2222'))).toBe(true);
    expect(sshFormValid(form(''))).toBe(true);
    expect(sshFormValid(form('nope'))).toBe(false);
  });
});
