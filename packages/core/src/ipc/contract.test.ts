import { describe, expect, it } from 'vitest';
import { demoReadModel, ids } from '../fixtures/demo';
import { rows } from '../read-model';
import {
  CHANNELS,
  COMMAND_NAMES,
  EVENT_NAMES,
  commandResultSchema,
  commands,
  events,
  isCommandName,
  isEventName,
} from './contract';

describe('ipc contract', () => {
  it('lists every plan §7 command family', () => {
    const families = new Set(COMMAND_NAMES.map((n) => n.split('.')[0]));
    expect([...families].sort()).toEqual(
      [
        'ask',
        'audit',
        'deploy',
        'detect',
        'dialog',
        'fs',
        'grant',
        'hunk',
        'ide',
        'link',
        'notify',
        'onboarding',
        'policy',
        'preview',
        'project',
        'session',
        'settings',
        'store',
        'target',
        'terminal',
        'ui',
        'window',
        'worktree',
      ].sort(),
    );
    expect(COMMAND_NAMES.length).toBeGreaterThanOrEqual(55);
    expect(isCommandName('grant.approve')).toBe(true);
    expect(isCommandName('toString')).toBe(false);
    expect(isEventName('store.delta')).toBe(true);
    expect(isEventName('nope')).toBe(false);
    expect(EVENT_NAMES).toContain('theme.resolved');
    expect(EVENT_NAMES).toContain('nav.go');
    expect(isCommandName('project.templates')).toBe(true);
    // CLI-first connect: status / login terminal / save, plus the health refresh.
    for (const n of [
      'target.connect.cliStatus',
      'target.connect.cliLogin',
      'target.connect.cliSave',
      'target.refresh',
    ])
      expect(isCommandName(n), n).toBe(true);
    expect(EVENT_NAMES).toContain('connect.cliLogin');
    expect(
      commands['target.connect.cliStatus'].output.safeParse({
        installed: true,
        binary: '/usr/local/bin/gcloud',
        version: '500.0.0',
        loginCommand: 'gcloud auth login',
        accounts: [{ id: 'nic@acme.dev', label: 'nic@acme.dev', active: true, detail: 'project acme-shop' }],
      }).success,
    ).toBe(true);
    expect(
      commands['target.connect.cliSave'].input.parse({
        projectId: ids.project.acmeShop,
        provider: 'aws',
        env: 'prod',
        name: 'AWS acme-prod',
        account: 'acme-prod',
      }),
    ).toMatchObject({ config: {} });
    expect(
      commands['target.connect.cliSave'].input.safeParse({
        projectId: ids.project.acmeShop,
        provider: 'aws',
        env: 'prod',
        name: 'AWS acme-prod',
        account: '',
      }).success,
    ).toBe(false);
    expect(commands['target.refresh'].input.parse({})).toEqual({});
    expect(
      events['connect.cliLogin'].safeParse({ terminalId: 'term:1', provider: 'gh', status: 'running' })
        .success,
    ).toBe(false);
    expect(
      events['connect.cliLogin'].safeParse({
        terminalId: 'term:1',
        provider: 'github',
        status: 'exited',
        exitCode: 0,
      }).success,
    ).toBe(true);
    expect(
      commands['project.templates'].output.safeParse({
        builtins: ['node'],
        org: [{ name: 'tpl', fullName: 'acme/tpl' }],
      }).success,
    ).toBe(true);
    expect(CHANNELS).toEqual({ command: 'styx:cmd', store: 'styx:store', pty: 'styx:pty' });
  });

  it('parses representative inputs and applies defaults', () => {
    expect(
      commands['grant.approve'].input.parse({ grantId: ids.grant.supabaseCodex, duration: '1h' }),
    ).toEqual({ grantId: ids.grant.supabaseCodex, duration: '1h' });
    expect(commands['grant.revoke'].input.parse({ grantId: ids.grant.supabaseCodex }).triggeredBy).toBe(
      'lock glyph',
    );
    expect(commands['audit.list'].input.parse({})).toEqual({ cursor: null, limit: 100 });
    expect(commands['fs.listDir'].input.parse({ worktreeId: ids.worktree.fixCheckout }).path).toBe('');
    expect(() => commands['grant.approve'].input.parse({ grantId: '', duration: '1h' })).toThrow();
    expect(() =>
      commands['session.spawn'].input.parse({ projectId: ids.project.acmeShop, agent: 'bash' }),
    ).toThrow();
    // Native pickers: optional title/defaultPath/filters in, a nullable path out (null = dismissed).
    expect(commands['dialog.pickFolder'].input.parse({})).toEqual({});
    expect(
      commands['dialog.pickFile'].input.parse({ filters: [{ name: 'Keys', extensions: ['pem'] }] }),
    ).toEqual({
      filters: [{ name: 'Keys', extensions: ['pem'] }],
    });
    expect(commands['dialog.pickFolder'].output.parse({ path: null })).toEqual({ path: null });
    expect(() => commands['dialog.pickFile'].input.parse({ title: '' })).toThrow();
    expect(commands['detect.setBinary'].input.parse({ agent: 'codex', path: '/opt/bin/codex' }).agent).toBe(
      'codex',
    );
    expect(() => commands['detect.setBinary'].input.parse({ agent: 'codex', path: '' })).toThrow();
    expect(
      events['project.cloneProgress'].parse({
        url: 'u',
        dest: '/d',
        phase: 'cloning',
        message: null,
        projectId: null,
      }),
    ).toMatchObject({ phase: 'cloning' });
    expect(() =>
      events['project.cloneProgress'].parse({
        url: 'u',
        dest: '/d',
        phase: 'started',
        message: null,
        projectId: null,
      }),
    ).toThrow();
  });

  it('every command has input/output schemas that accept an object', () => {
    for (const name of COMMAND_NAMES) {
      expect(typeof commands[name].input.safeParse).toBe('function');
      expect(typeof commands[name].output.safeParse).toBe('function');
    }
    for (const name of EVENT_NAMES) expect(typeof events[name].safeParse).toBe('function');
  });

  it('store.snapshot output accepts the demo read model', () => {
    const m = demoReadModel();
    const snapshot = {
      seq: m.seq,
      projects: rows(m.projects),
      repos: rows(m.repos),
      worktrees: rows(m.worktrees),
      sessions: rows(m.sessions),
      targets: rows(m.targets),
      grants: rows(m.grants),
      auditEntries: rows(m.auditEntries),
      policies: rows(m.policies),
      pendingAsks: rows(m.pendingAsks),
      notifications: rows(m.notifications),
      transcripts: m.transcripts,
      hunks: m.hunks,
      discovery: m.discovery,
      settings: m.settings,
      popouts: m.popouts,
      ui: { screen: null, projectId: null, projectSession: {}, paneSizes: {} },
      activity: m.activity,
    };
    const r = commands['store.snapshot'].output.safeParse(snapshot);
    expect(r.success).toBe(true);
    const ok = commandResultSchema('store.snapshot').safeParse({ ok: true, value: snapshot });
    expect(ok.success).toBe(true);
    const err = commandResultSchema('grant.deny').safeParse({
      ok: false,
      error: { code: 'mfa-required', message: 'Touch ID' },
    });
    expect(err.success).toBe(true);
  });

  it('event payloads parse', () => {
    expect(
      events['store.delta'].safeParse({ seq: 1, deltas: [{ op: 'popouts.set', sessionIds: [] }] }).success,
    ).toBe(true);
    expect(
      events['banner.set'].safeParse({
        bannerKey: 'cli-missing:codex',
        kind: 'cli-missing',
        text: 'codex not found on PATH. 1 session cannot start.',
        cta: 'Install guide',
        action: { kind: 'install-guide', agent: 'codex' },
        sessionId: null,
        reason: 'cli-missing',
      }).success,
    ).toBe(true);
    expect(events['theme.resolved'].safeParse({ theme: 'sepia' }).success).toBe(false);
    expect(events['nav.go'].safeParse({ screen: 'agents' }).success).toBe(true);
    expect(events['nav.go'].safeParse({ screen: 'diff' }).success).toBe(false);
  });
});
