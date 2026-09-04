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
        'detect',
        'fs',
        'grant',
        'hunk',
        'ide',
        'notify',
        'onboarding',
        'policy',
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
  });
});
