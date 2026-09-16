import { describe, expect, it } from 'vitest';
import { idFrom } from '../ids';
import type { ProjectId, SessionId, TargetId, WorktreeId } from '../ids';
import { DEMO_NOW, demoReadModel, errorReadModel, ids } from '../fixtures/demo';
import type { Grant } from '../model/grant';
import type { Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { rows, upsertRows } from '../read-model';
import { boardCard, boardColumns } from './board';
import { chatMeta, composerPlaceholder, formatCost, queuedLabel, usageLabel } from './chat';
import {
  branchOf,
  byRecentActivity,
  projectBranch,
  projectNameOf,
  projectSettingsOfOrDefault,
} from './common-settings';
import { mainWorktreeOf, projectBranchOrNull, projectHasGit } from './common';
import { repoHasGit } from '../model/project';
import { activeGrants, homeCounters, lockedCount, needsYouCount, projectCount, workingCount } from './counts';
import { padCount } from './format';
import { sessionTabs } from './tabs';
import { liveGrantsOnTarget, targetDerivedState, targetRows } from './target-state';

const NOW = DEMO_NOW;
const MIN = 60_000;
const HOUR = 60 * MIN;

const withGrant = (model: ReadModel, patch: Partial<Grant> & Pick<Grant, 'id'>): ReadModel => {
  const current = model.grants.byId[patch.id];
  if (current === undefined) throw new Error('unknown grant');
  return { ...model, grants: upsertRows(model.grants, [{ ...current, ...patch }]) };
};

const withSession = (model: ReadModel, patch: Partial<Session> & Pick<Session, 'id'>): ReadModel => {
  const current = model.sessions.byId[patch.id];
  if (current === undefined) throw new Error('unknown session');
  return { ...model, sessions: upsertRows(model.sessions, [{ ...current, ...patch }]) };
};

/** The prototype after "Grant": Codex grant active for 1h. */
const grantedModel = (): ReadModel =>
  withGrant(demoReadModel(), {
    id: ids.grant.supabaseCodex,
    state: 'active',
    issuedAt: NOW,
    expiresAt: NOW + HOUR,
    idleExpiresAt: NOW + HOUR,
    decidedBy: 'user',
    mfaVerified: true,
  });

describe('counts (prototype counters)', () => {
  const model = demoReadModel();
  it('needs you 02 · agents working 03 · grants active 02 · projects 05', () => {
    expect(padCount(needsYouCount(model))).toBe('02');
    expect(padCount(workingCount(model))).toBe('03');
    expect(padCount(activeGrants(model, NOW).length)).toBe('02');
    expect(padCount(projectCount(model))).toBe('05');
    expect(
      homeCounters(model, NOW, {
        needsYou: 'Needs you',
        agentsWorking: 'Agents working',
        grantsActive: 'Grants active',
        projects: 'Projects',
      }),
    ).toEqual([
      { n: '02', label: 'Needs you' },
      { n: '03', label: 'Agents working' },
      { n: '02', label: 'Grants active' },
      { n: '05', label: 'Projects' },
    ]);
  });
  it('locked 02 → 01 after the Codex grant; grants active 03', () => {
    expect(padCount(lockedCount(model, ids.project.acmeShop, NOW))).toBe('02');
    const granted = grantedModel();
    expect(padCount(lockedCount(granted, ids.project.acmeShop, NOW))).toBe('01');
    expect(padCount(activeGrants(granted, NOW).length)).toBe('03');
  });
  it('archived and removed rows are excluded', () => {
    const archived = withSession(model, { id: ids.session.codex, archivedAt: NOW });
    expect(needsYouCount(archived)).toBe(1);
    const removedProject = {
      ...model.projects.byId[ids.project.sideApi],
      removedAt: NOW,
    } as ReadModel['projects']['byId'][string];
    expect(projectCount({ ...model, projects: upsertRows(model.projects, [removedProject]) })).toBe(4);
  });
});

describe('targetDerivedState', () => {
  const model = demoReadModel();
  it('Vercel prod is open · 58m left with the grant id and open-until', () => {
    expect(targetDerivedState(model, ids.target.vercelProd, NOW)).toEqual({
      kind: 'open',
      label: 'open · 58m left',
      openUntil: NOW + 58 * MIN,
      grantId: ids.grant.vercelProdClaude,
    });
  });
  it('Vercel preview is persistent via its always grant; GitHub via its always policy', () => {
    expect(targetDerivedState(model, ids.target.vercelPreview, NOW)).toEqual({
      kind: 'persistent',
      label: 'persistent',
      grantId: ids.grant.vercelPreviewAlways,
    });
    expect(targetDerivedState(model, ids.target.github, NOW)).toEqual({
      kind: 'persistent',
      label: 'persistent',
    });
  });
  it('Supabase prod and AWS are locked; Supabase opens after the grant (59m)', () => {
    expect(targetDerivedState(model, ids.target.supabaseProd, NOW).label).toBe('locked');
    expect(targetDerivedState(model, ids.target.awsProd, NOW).label).toBe('locked');
    expect(targetDerivedState(grantedModel(), ids.target.supabaseProd, NOW + MIN).label).toBe(
      'open · 59m left',
    );
  });
  it('unconnected when there is no credential or the target is unknown; expired from health', () => {
    const t = model.targets.byId[ids.target.awsProd];
    const unconnected = {
      ...model,
      targets: upsertRows(model.targets, [{ ...(t as NonNullable<typeof t>), credentialRef: null }]),
    };
    expect(targetDerivedState(unconnected, ids.target.awsProd, NOW)).toEqual({
      kind: 'unconnected',
      label: 'unconnected',
    });
    expect(targetDerivedState(model, idFrom<'TargetId'>('nope') as TargetId, NOW).kind).toBe('unconnected');
    expect(targetDerivedState(errorReadModel(), ids.target.awsProd, NOW)).toEqual({
      kind: 'expired',
      label: 'expired',
    });
  });
  it('a grant past its open-until is not live; a live session grant without expiry does not open a target', () => {
    const stale = withGrant(model, { id: ids.grant.vercelProdClaude, expiresAt: NOW - 1 });
    expect(targetDerivedState(stale, ids.target.vercelProd, NOW).kind).toBe('locked');
    expect(liveGrantsOnTarget(stale, ids.target.vercelProd, NOW)).toEqual([]);
    const sessionScoped = withGrant(model, {
      id: ids.grant.vercelProdClaude,
      duration: 'session',
      expiresAt: null,
      idleExpiresAt: null,
    });
    expect(targetDerivedState(sessionScoped, ids.target.vercelProd, NOW).kind).toBe('locked');
  });
  it('picks the earliest open-until across several live grants', () => {
    const second = {
      ...(model.grants.byId[ids.grant.vercelProdClaude] as Grant),
      id: idFrom<'GrantId'>('g2'),
      expiresAt: NOW + 10 * MIN,
      idleExpiresAt: null,
    };
    const third = { ...second, id: idFrom<'GrantId'>('g3'), expiresAt: NOW + 90 * MIN };
    const many = { ...model, grants: upsertRows(model.grants, [second, third]) };
    expect(targetDerivedState(many, ids.target.vercelProd, NOW)).toMatchObject({
      label: 'open · 10m left',
      grantId: 'g2',
    });
  });
  it('targetRows: policy labels, prod flag and actions', () => {
    const table = targetRows(model, ids.project.acmeShop, NOW);
    expect(table.map((r) => [r.name, r.env, r.policyLabel, r.state.label, r.action])).toEqual([
      ['Vercel', 'prod', 'Ask · MFA', 'open · 58m left', 'Revoke'],
      ['Vercel', 'preview', 'Always allow', 'persistent', 'Edit'],
      ['Supabase', 'prod', 'Ask each time', 'locked', 'Edit'],
      ['AWS acme-prod', 'prod', 'Ask · MFA', 'locked', 'Edit'],
      ['GitHub acme/shop', 'scm', 'Always allow', 'persistent', 'Edit'],
    ]);
    expect(table.map((r) => r.prod)).toEqual([true, false, true, true, false]);
    const t = model.targets.byId[ids.target.awsProd] as NonNullable<(typeof model.targets.byId)[string]>;
    const unconnected = { ...model, targets: upsertRows(model.targets, [{ ...t, credentialRef: null }]) };
    expect(targetRows(unconnected, ids.project.acmeShop, NOW)[3]?.action).toBe('Connect');
  });
});

describe('boardColumns', () => {
  const model = demoReadModel();
  const cols = boardColumns(model, NOW);
  it('needs-you 02 · working 04 (incl. idle) · done 02, labels and flags', () => {
    expect(cols.map((c) => [c.key, c.label, c.count, c.hot, c.spawn, c.empty])).toEqual([
      ['needs-you', 'Needs you', '02', true, false, false],
      ['working', 'Working', '04', false, true, false],
      ['done', 'Done', '02', false, false, false],
    ]);
  });
  it('cards carry agent, age, project · branch, note and CTA', () => {
    const needs = cols[0]?.items.map((c) => [c.agent, c.age, c.project, c.branch, c.note, c.cta]);
    expect(needs).toEqual([
      ['Codex', '3m', 'acme-shop', 'test/flaky', 'Requesting Supabase prod · read + write', 'Review grant'],
      ['Claude', '9m', 'blog-v2', 'feat/mdx', 'Plan ready · 4 files. Waiting for approval.', 'Review plan'],
    ]);
    expect(cols[1]?.items.map((c) => [c.agent, c.age, c.cta])).toEqual([
      ['Claude', '14m', 'Open'],
      ['Gemini', '—', 'Open'],
      ['Gemini', '31m', 'Open'],
      ['shell', '1h', 'Open'],
    ]);
    expect(cols[2]?.items.map((c) => [c.agent, c.age, c.note, c.cta])).toEqual([
      ['Cursor', '1d', 'PR #212 opened, merged yesterday', 'Archive'],
      ['Claude', '2d', '2 commits pushed', 'Archive'],
    ]);
    expect(cols[0]?.items[0]).toMatchObject({
      needs: true,
      paused: false,
      askId: ids.ask.codexGrant,
      askKind: 'grant',
      state: 'needs-you',
    });
  });
  it('empty columns carry the spec §10 copy', () => {
    const empty = boardColumns({ ...model, sessions: { byId: {}, ids: [] } }, NOW);
    expect(empty.map((c) => [c.count, c.empty, c.emptyText])).toEqual([
      ['00', true, 'Nothing waiting on you.'],
      ['00', true, 'No agents running. Spawn one below, or ask in the palette.'],
      ['00', true, 'Finished sessions land here for 7 days.'],
    ]);
  });
  it('needs-you with a decision/question ask → Review; paused → paused note in Working; null note → empty', () => {
    const codex = model.sessions.byId[ids.session.codex] as Session;
    const ask = model.pendingAsks.byId[ids.ask.codexGrant] as NonNullable<
      (typeof model.pendingAsks.byId)[string]
    >;
    const decision = {
      ...model,
      pendingAsks: upsertRows(model.pendingAsks, [
        {
          ...ask,
          kind: 'decision' as const,
          grantId: null,
          payload: { kind: 'decision' as const, prompt: '?', options: ['Yes'] },
        },
      ]),
    };
    expect(boardCard(decision, codex, NOW).cta).toBe('Review');
    const noAsk = { ...model, pendingAsks: { byId: {}, ids: [] } };
    expect(boardCard(noAsk, codex, NOW)).toMatchObject({ cta: 'Review', askId: null, askKind: null });
    const paused = boardCard(model, { ...codex, state: 'paused', pausedReason: 'cli-missing' }, NOW);
    expect(paused).toMatchObject({ note: 'paused', paused: true, needs: false, cta: 'Open' });
    expect(
      boardColumns(
        withSession(model, { id: ids.session.codex, state: 'paused', pausedReason: 'cli-missing' }),
        NOW,
      )[1]?.count,
    ).toBe('05');
    expect(boardCard(model, { ...codex, state: 'working', note: null }, NOW).note).toBe('');
  });
});

describe('sessionTabs', () => {
  const model = demoReadModel();
  it('acme-shop: Claude · Codex(!) · Gemini in spawn order, Codex active', () => {
    const tabs = sessionTabs(model, ids.project.acmeShop, ids.session.codex);
    expect(tabs.visible.map((t) => [t.label, t.active, t.needs, t.dot])).toEqual([
      ['Claude', false, false, 'text'],
      ['Codex', true, true, 'accent'],
      ['Gemini', false, false, 'line'],
    ]);
    expect(tabs.overflow).toEqual([]);
    expect(tabs.activeId).toBe(ids.session.codex);
  });
  it('unknown active falls back to the first tab; empty project has none', () => {
    expect(sessionTabs(model, ids.project.acmeShop, null).activeId).toBe(ids.session.claude);
    expect(sessionTabs(model, ids.project.acmeShop, ids.session.blog).activeId).toBe(ids.session.claude);
    expect(sessionTabs(model, ids.project.sideApi, null)).toEqual({
      visible: [],
      overflow: [],
      activeId: null,
    });
  });
  it('a 4th session overflows; when active it takes slot 3 and displaces the third', () => {
    const claude = model.sessions.byId[ids.session.claude] as Session;
    const fourth: Session = {
      ...claude,
      id: idFrom<'SessionId'>('sess-4') as SessionId,
      agent: 'cursor',
      startedAt: NOW,
      state: 'working',
    };
    const fifth: Session = {
      ...fourth,
      id: idFrom<'SessionId'>('sess-5') as SessionId,
      agent: 'shell',
      startedAt: NOW + 1,
    };
    const many = { ...model, sessions: upsertRows(model.sessions, [fourth, fifth]) };
    const inactive = sessionTabs(many, ids.project.acmeShop, ids.session.claude);
    expect(inactive.visible.map((t) => t.label)).toEqual(['Claude', 'Codex', 'Gemini']);
    expect(inactive.overflow.map((t) => t.label)).toEqual(['Cursor', 'shell']);
    const active = sessionTabs(many, ids.project.acmeShop, fifth.id);
    expect(active.visible.map((t) => [t.label, t.active])).toEqual([
      ['Claude', false],
      ['Codex', false],
      ['shell', true],
    ]);
    expect(active.overflow.map((t) => t.label)).toEqual(['Gemini', 'Cursor']);
  });
  it('when fewer than 3 are visible the active overflow tab is appended without displacing', () => {
    const codex = model.sessions.byId[ids.session.codex] as Session;
    const only = { ...model, sessions: { byId: { [codex.id]: codex }, ids: [codex.id] } };
    expect(sessionTabs(only, ids.project.acmeShop, codex.id).visible).toHaveLength(1);
  });
});

describe('chat', () => {
  const model = demoReadModel();
  it('meta lines', () => {
    expect(chatMeta(model, ids.session.codex, NOW)).toBe('codex · test/flaky · 3m · waiting on you');
    expect(chatMeta(model, ids.session.claude, NOW)).toBe('claude · fix/checkout · 14m');
    expect(chatMeta(model, ids.session.gemini, NOW)).toBe('gemini · main · —');
    expect(chatMeta(model, idFrom<'SessionId'>('nope') as SessionId, NOW)).toBe('');
  });
  it('chat meta appends "$cost · n turns" once a stream session reports usage (discrepancy #54)', () => {
    expect(usageLabel({ costUsd: 0, numTurns: 0 })).toBeNull();
    expect(usageLabel({ costUsd: 0.1234, numTurns: 3 })).toBe('$0.12 · 3 turns');
    // No dollars and no tokens reported (ACP agents): turns alone, never a made-up "$0.00".
    expect(usageLabel({ costUsd: 0, numTurns: 1 })).toBe('1 turn');
    expect(usageLabel({ costUsd: 0.005, numTurns: 0 })).toBe('$0.01 · 0 turns');
    // Codex on a ChatGPT plan counts tokens, not dollars (discrepancy #83).
    expect(usageLabel({ costUsd: 0, numTurns: 1, tokensUsed: 14574 })).toBe('14.6k tokens · 1 turn');
    expect(usageLabel({ costUsd: 0, numTurns: 3, tokensUsed: 14574 })).toBe('14.6k tokens · 3 turns');
    expect(formatCost(2)).toBe('$2.00');
    const used = withSession(model, { id: ids.session.claude, costUsd: 0.1234, numTurns: 3 });
    expect(chatMeta(used, ids.session.claude, NOW)).toBe('claude · fix/checkout · 14m · $0.12 · 3 turns');
    const waiting = withSession(model, { id: ids.session.codex, costUsd: 1, numTurns: 12 });
    expect(chatMeta(waiting, ids.session.codex, NOW)).toBe(
      'codex · test/flaky · 3m · waiting on you · $1.00 · 12 turns',
    );
  });
  it('queued label and composer placeholder', () => {
    expect(queuedLabel(model, ids.session.codex)).toBeNull();
    const ask = model.pendingAsks.byId[ids.ask.codexGrant] as NonNullable<
      (typeof model.pendingAsks.byId)[string]
    >;
    const queued = {
      ...model,
      pendingAsks: upsertRows(model.pendingAsks, [{ ...ask, id: idFrom<'AskId'>('ask-q'), position: 1 }]),
    };
    expect(queuedLabel(queued, ids.session.codex)).toBe('+1 queued');
    expect(composerPlaceholder(model, ids.session.codex)).toBe('Message Codex…');
    expect(composerPlaceholder(model, idFrom<'SessionId'>('nope') as SessionId)).toBe('Message …');
  });
});

describe('common', () => {
  const model = demoReadModel();
  it('project branch = most recent session worktree, else main, else —', () => {
    expect(projectBranch(model, ids.project.acmeShop)).toBe('fix/checkout');
    expect(projectBranch(model, ids.project.blogV2)).toBe('feat/mdx');
    expect(projectBranch(model, ids.project.sideApi)).toBe('main');
    const noSessions = { ...model, sessions: { byId: {}, ids: [] } };
    expect(projectBranch(noSessions, ids.project.acmeShop)).toBe('main');
    expect(projectBranch({ ...noSessions, worktrees: { byId: {}, ids: [] } }, ids.project.acmeShop)).toBe(
      '—',
    );
  });
  it('plain folder (repo.defaultBranch null, main worktree on no branch): not git, branch — / null', () => {
    const repo = model.repos.byId[ids.repo.sideApi];
    const main = model.worktrees.byId[ids.worktree.sideMain];
    if (repo === undefined || main === undefined) throw new Error('fixture');
    const plain = {
      ...model,
      repos: {
        ...model.repos,
        byId: { ...model.repos.byId, [repo.id]: { ...repo, defaultBranch: null, remotes: [] } },
      },
      worktrees: {
        ...model.worktrees,
        byId: { ...model.worktrees.byId, [main.id]: { ...main, branch: null } },
      },
    };
    expect(projectHasGit(model, ids.project.sideApi)).toBe(true);
    expect(projectHasGit(plain, ids.project.sideApi)).toBe(false);
    expect(projectHasGit(plain, idFrom<'ProjectId'>('nope') as ProjectId)).toBe(false);
    expect(mainWorktreeOf(plain, ids.project.sideApi)?.id).toBe(main.id);
    expect(projectBranch(plain, ids.project.sideApi)).toBe('—');
    expect(projectBranchOrNull(plain, ids.project.sideApi)).toBeNull();
    expect(projectBranchOrNull(model, ids.project.sideApi)).toBe('main');
    expect(projectBranchOrNull(model, ids.project.acmeShop)).toBe('fix/checkout');
    expect(repoHasGit(null)).toBe(false);
    expect(repoHasGit({ defaultBranch: 'main' })).toBe(true);
  });
  it('unknown ids render as —', () => {
    expect(branchOf(model, { worktreeId: idFrom<'WorktreeId'>('nope') as WorktreeId })).toBe('—');
    expect(projectNameOf(model, idFrom<'ProjectId'>('nope') as ProjectId)).toBe('—');
  });
  it('byRecentActivity: newest first, nulls last, equal → 0', () => {
    const list = [
      { lastActivityAt: null },
      { lastActivityAt: 1 },
      { lastActivityAt: 5 },
      { lastActivityAt: null },
    ];
    expect(list.sort(byRecentActivity).map((s) => s.lastActivityAt)).toEqual([5, 1, null, null]);
    expect(byRecentActivity({ lastActivityAt: 3 }, { lastActivityAt: 3 })).toBe(0);
    expect(byRecentActivity({ lastActivityAt: null }, { lastActivityAt: 3 })).toBe(1);
    expect(byRecentActivity({ lastActivityAt: 3 }, { lastActivityAt: null })).toBe(-1);
  });
  it('project settings fall back to defaults', () => {
    expect(projectSettingsOfOrDefault(model, ids.project.acmeShop).defaultAgent).toBe('claude');
    expect(projectSettingsOfOrDefault(model, ids.project.blogV2).branchPrefix).toBe('agent/');
    expect(rows(model.sessions)).toHaveLength(8);
  });
});
