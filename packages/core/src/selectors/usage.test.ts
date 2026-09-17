import { describe, expect, it } from 'vitest';
import { copy } from '../copy';
import { DEMO_NOW, demoReadModel, emptyReadModel, ids } from '../fixtures/demo';
import type { ProjectId, SessionId } from '../ids';
import type { Session } from '../model/session';
import type { AgentLimits } from '../model/usage';
import { upsertRows, type ReadModel } from '../read-model';
import { limitRows, usageByAgent, usageByProject, usageCells, type UsageRow } from './usage';

const NOW = DEMO_NOW;
const MIN = 60_000;
const HOUR = 60 * MIN;

const withUsage = (
  model: ReadModel,
  patches: Record<string, Partial<Pick<Session, 'costUsd' | 'numTurns' | 'tokensUsed'>>>,
): ReadModel => {
  const next: Session[] = [];
  for (const [id, patch] of Object.entries(patches)) {
    const s = model.sessions.byId[id];
    if (s === undefined) throw new Error(`no session ${id}`);
    next.push({ ...s, ...patch });
  }
  return { ...model, sessions: upsertRows(model.sessions, next) };
};

const flat = (r: UsageRow) => [r.label, r.sessions, r.turns, r.tokens, Number(r.costUsd.toFixed(4))];

describe('usageByAgent', () => {
  it('counts every non-shell session of the demo fixture, zero usage and all, in a stable order', () => {
    const t = usageByAgent(demoReadModel());
    // Nothing reported: ties broken by session count, then product name.
    expect(t.rows.map(flat)).toEqual([
      ['Claude Code', 3, 0, 0, 0],
      ['Gemini CLI', 2, 0, 0, 0],
      ['Codex', 1, 0, 0, 0],
      ['Cursor agent', 1, 0, 0, 0],
    ]);
    expect(t.rows.map((r) => r.key)).toEqual(['claude', 'gemini', 'codex', 'cursor']);
    expect(flat(t.total)).toEqual([copy.usage.total, 7, 0, 0, 0]);
    expect(t.total.key).toBe('total');
  });

  it('sums cost, turns and tokens per agent and sorts by cost, then tokens', () => {
    const model = withUsage(demoReadModel(), {
      [ids.session.claude]: { costUsd: 0.42, numTurns: 7 },
      [ids.session.blog]: { costUsd: 0.1, numTurns: 2 },
      [ids.session.codex]: { costUsd: 0, numTurns: 5, tokensUsed: 14_600 },
      [ids.session.infra]: { costUsd: 0, numTurns: 1, tokensUsed: 900 },
    });
    const t = usageByAgent(model);
    expect(t.rows.map(flat)).toEqual([
      ['Claude Code', 3, 9, 0, 0.52],
      ['Codex', 1, 5, 14_600, 0],
      ['Gemini CLI', 2, 1, 900, 0],
      ['Cursor agent', 1, 0, 0, 0],
    ]);
    expect(flat(t.total)).toEqual([copy.usage.total, 7, 15, 15_500, 0.52]);
  });

  it('is empty for the empty fixture', () => {
    const t = usageByAgent(emptyReadModel());
    expect(t.rows).toEqual([]);
    expect(flat(t.total)).toEqual([copy.usage.total, 0, 0, 0, 0]);
  });

  it('counts archived sessions too (the usage was spent) and leaves shell out', () => {
    const model = demoReadModel();
    const shell = model.sessions.byId[ids.session.shell];
    if (shell === undefined) throw new Error('no shell session');
    const archived: Session = {
      ...shell,
      id: 'sess-archived' as SessionId,
      agent: 'codex',
      costUsd: 0,
      numTurns: 3,
      tokensUsed: 1000,
      archivedAt: NOW - HOUR,
    };
    const t = usageByAgent({ ...model, sessions: upsertRows(model.sessions, [archived]) });
    expect(t.rows.find((r) => r.key === 'codex')?.sessions).toBe(2);
    expect(t.rows.find((r) => r.key === 'shell')).toBeUndefined();
    expect(t.total.sessions).toBe(8);
  });
});

describe('usageByProject', () => {
  it('groups by project name, dropping the shell-only project', () => {
    const model = withUsage(demoReadModel(), {
      [ids.session.blog]: { costUsd: 1.5, numTurns: 4 },
      [ids.session.codex]: { costUsd: 0, numTurns: 5, tokensUsed: 14_600 },
    });
    const t = usageByProject(model);
    expect(t.rows.map(flat)).toEqual([
      ['blog-v2', 1, 4, 0, 1.5],
      ['acme-shop', 4, 5, 14_600, 0],
      ['infra-tools', 1, 0, 0, 0],
      ['side-api', 1, 0, 0, 0],
    ]);
    expect(t.rows[0]?.key).toBe(ids.project.blogV2);
    expect(t.rows.some((r) => r.key === ids.project.clientX)).toBe(false);
    expect(flat(t.total)).toEqual([copy.usage.total, 7, 9, 14_600, 1.5]);
  });

  it('keeps a session whose project is gone under a dash', () => {
    const model = demoReadModel();
    const s = model.sessions.byId[ids.session.claude];
    if (s === undefined) throw new Error('no claude session');
    const orphan: Session = { ...s, id: 'sess-orphan' as SessionId, projectId: 'gone' as ProjectId };
    const t = usageByProject({ ...model, sessions: upsertRows(model.sessions, [orphan]) });
    expect(t.rows.find((r) => r.key === 'gone')?.label).toBe(copy.general.none);
  });
});

describe('usageCells', () => {
  it.each<[UsageRow, [string, string, string, string]]>([
    [
      { key: 'a', label: 'a', sessions: 0, turns: 0, tokens: 0, costUsd: 0 },
      ['0', '0', copy.general.none, copy.general.none],
    ],
    [
      { key: 'a', label: 'a', sessions: 3, turns: 12, tokens: 14_600, costUsd: 0.125 },
      ['3', '12', '14.6k', '$0.13'],
    ],
    [
      { key: 'a', label: 'a', sessions: 1, turns: 1, tokens: 2_500_000, costUsd: 12 },
      ['1', '1', '2.5M', '$12.00'],
    ],
    [
      { key: 'a', label: 'a', sessions: 1, turns: 1, tokens: 999, costUsd: 0.001 },
      ['1', '1', '999', '$0.00'],
    ],
  ])('formats %j', (row, expected) => {
    const c = usageCells(row);
    expect([c.sessions, c.turns, c.tokens, c.cost]).toEqual(expected);
  });
});

describe('limitRows', () => {
  const codex: AgentLimits = {
    agent: 'codex',
    plan: 'team',
    windows: [
      { label: '5 h', usedPercent: 42.4, resetsAt: NOW + 2 * HOUR + 10 * MIN },
      { label: '7 d', usedPercent: 12, resetsAt: NOW + 3 * 24 * HOUR },
    ],
    updatedAt: NOW - 2 * MIN,
  };
  const claude: AgentLimits = {
    agent: 'claude',
    plan: null,
    windows: [{ label: '5 h', usedPercent: 101, resetsAt: null }],
    updatedAt: NOW,
  };

  it('is empty when nothing reported', () => {
    expect(limitRows(demoReadModel(), NOW)).toEqual([]);
  });

  it('renders one row per reporting agent in product order with countdowns, plan and age', () => {
    const model: ReadModel = { ...demoReadModel(), limits: { codex, claude } };
    expect(limitRows(model, NOW)).toEqual([
      {
        agent: 'claude',
        label: 'Claude Code',
        plan: null,
        windows: [{ label: '5 h', usedPercent: 100, used: '5 h · 100% used', resets: null }],
        reported: 'now',
      },
      {
        agent: 'codex',
        label: 'Codex',
        plan: 'plan team',
        windows: [
          { label: '5 h', usedPercent: 42, used: '5 h · 42% used', resets: 'resets in 2h 10m' },
          { label: '7 d', usedPercent: 12, used: '7 d · 12% used', resets: 'resets in 3d' },
        ],
        reported: '2m',
      },
    ]);
  });

  it('floors a reset already in the past at 0m and treats an empty plan as none', () => {
    const model: ReadModel = {
      ...demoReadModel(),
      limits: {
        codex: {
          ...codex,
          plan: '',
          windows: [{ label: '5 h', usedPercent: -3, resetsAt: NOW - HOUR }],
        },
      },
    };
    const [row] = limitRows(model, NOW);
    expect(row?.plan).toBeNull();
    expect(row?.windows).toEqual([
      { label: '5 h', usedPercent: 0, used: '5 h · 0% used', resets: 'resets in 0m' },
    ]);
  });
});
