import { describe, expect, it } from 'vitest';
import { copy } from '../copy';
import { DEMO_NOW, demoReadModel, emptyReadModel, ids } from '../fixtures/demo';
import type { AskPayload, PendingAsk, Session } from '../model/session';
import { rows, upsertRows, type ReadModel } from '../read-model';
import { askQuestion, oneNeeds, oneProjects, oneRecord, oneTasks } from './one';

const NOW = DEMO_NOW;

const withSession = (m: ReadModel, id: Session['id'], patch: Partial<Session>): ReadModel => {
  const s = m.sessions.byId[id];
  if (s === undefined) throw new Error('fixture');
  return { ...m, sessions: upsertRows(m.sessions, [{ ...s, ...patch }]) };
};

/** Replace every open ask of a session with one carrying `payload`. */
const withAsk = (m: ReadModel, sessionId: Session['id'], payload: AskPayload): ReadModel => {
  const base = rows(m.pendingAsks)[0];
  if (base === undefined) throw new Error('fixture');
  const others = rows(m.pendingAsks).filter((a) => a.sessionId !== sessionId);
  const ask: PendingAsk = {
    ...base,
    id: 'ask-test' as PendingAsk['id'],
    sessionId,
    kind: payload.kind,
    payload,
    state: 'open',
    position: 0,
    createdAt: NOW - 60_000,
  };
  return { ...m, pendingAsks: upsertRows({ byId: {}, ids: [] }, [...others, ask]) };
};

describe('oneTasks', () => {
  it('lists the demo tasks, whose move it is first, in plain words', () => {
    expect(oneTasks(demoReadModel(), NOW).map((t) => [t.project, t.state, t.line])).toEqual([
      ['acme-shop', 'your-turn', 'Waiting for you'],
      ['blog-v2', 'your-turn', 'Asks you: Plan ready · 4 files.'],
      ['acme-shop', 'working', 'Working · 14m'],
      ['infra-tools', 'working', 'Working · 31m'],
      ['client-x', 'working', 'Working · 1h'],
      ['acme-shop', 'idle', copy.one.status.idle],
      ['acme-shop', 'landed', 'Live · 1d'],
      ['side-api', 'finished', copy.one.status.finished],
    ]);
    expect(oneTasks(emptyReadModel(), NOW)).toEqual([]);
  });

  it('narrows to one project, names a task without a message, and marks design tasks', () => {
    const m = withSession(demoReadModel(), ids.session.claude, { kind: 'design', firstMessage: null });
    const acme = oneTasks(m, NOW, ids.project.acmeShop);
    expect(new Set(acme.map((t) => t.project))).toEqual(new Set(['acme-shop']));
    const claude = acme.find((t) => t.sessionId === ids.session.claude);
    expect(claude?.kind).toBe('design');
    expect(claude?.title).toBe('Claude, no task yet');
  });

  it('leaves out archived tasks, background tasks and removed projects', () => {
    let m = withSession(demoReadModel(), ids.session.claude, { archivedAt: NOW });
    m = withSession(m, ids.session.codex, { purpose: 'merge' });
    const p = m.projects.byId[ids.project.sideApi];
    if (p === undefined) throw new Error('fixture');
    m = { ...m, projects: upsertRows(m.projects, [{ ...p, removedAt: NOW }]) };
    const sessions = oneTasks(m, NOW).map((t) => t.sessionId);
    expect(sessions).not.toContain(ids.session.claude);
    expect(sessions).not.toContain(ids.session.codex);
    expect(sessions).not.toContain(ids.session.side);
  });

  it('says paused, and ready to go live for finished work with something to land', () => {
    const paused = withSession(demoReadModel(), ids.session.gemini, { state: 'paused' });
    expect(oneTasks(paused, NOW).find((t) => t.sessionId === ids.session.gemini)?.line).toBe(
      copy.one.status.paused,
    );
    // Finished work on its own branch, unmerged, with changes: ready to go live.
    const m = demoReadModel();
    const ready = rows(m.sessions).find((s) =>
      oneTasks({ ...m, sessions: upsertRows(m.sessions, [{ ...s, state: 'done' }]) }, NOW).some(
        (t) => t.sessionId === s.id && t.state === 'ready',
      ),
    );
    expect(ready).toBeDefined();
    if (ready === undefined) return;
    const done = withSession(m, ready.id, { state: 'done' });
    expect(oneTasks(done, NOW).find((t) => t.sessionId === ready.id)?.line).toBe(copy.one.status.ready);
  });
});

describe('askQuestion', () => {
  it.each<[AskPayload, string | null]>([
    [{ kind: 'grant', grantId: ids.grant.supabaseCodex }, null],
    [{ kind: 'plan', summary: 'Plan ready', files: [] }, 'Plan ready'],
    [{ kind: 'decision', prompt: 'Ship it?', options: ['Yes'] }, 'Ship it?'],
    [{ kind: 'question', prompt: 'Which branch?' }, 'Which branch?'],
    [
      {
        kind: 'questions',
        questions: [{ key: 'a', header: null, prompt: 'First?', multiSelect: false, options: [] }],
      },
      'First?',
    ],
    [{ kind: 'questions', questions: [] } as unknown as AskPayload, null],
  ])('%j → %s', (payload, want) => {
    expect(askQuestion({ payload })).toBe(want);
  });
});

describe('oneNeeds', () => {
  it('gathers access requests and questions, newest first', () => {
    expect(oneNeeds(demoReadModel(), NOW).map((n) => [n.kind, n.project, n.big])).toEqual([
      ['access', 'acme-shop', 'Supabase prod'],
      ['access', 'infra-tools', 'AWS acme-prod'],
      ['question', 'blog-v2', 'Plan ready · 4 files.'],
      ['access', 'blog-v2', 'Vercel'],
    ]);
    // Production write asks for OS authentication; production read does not.
    const access = oneNeeds(demoReadModel(), NOW).flatMap((n) =>
      n.kind === 'access' ? [[n.big, n.osAuth]] : [],
    );
    expect(access).toEqual([
      ['Supabase prod', true],
      ['AWS acme-prod', false],
      ['Vercel', false],
    ]);
  });

  it('asks nothing for a grant ask (it shows as access) and offers work ready to go live', () => {
    const grantAsk = withAsk(demoReadModel(), ids.session.blog, {
      kind: 'grant',
      grantId: ids.grant.supabaseCodex,
    });
    expect(oneNeeds(grantAsk, NOW).filter((n) => n.kind === 'question')).toEqual([]);
    const m = demoReadModel();
    const readyModel = rows(m.sessions)
      .map((s) => ({ ...m, sessions: upsertRows(m.sessions, [{ ...s, state: 'done' as const }]) }))
      .find((x) => oneNeeds(x, NOW).some((n) => n.kind === 'live'));
    expect(readyModel).toBeDefined();
    const live =
      readyModel === undefined ? undefined : oneNeeds(readyModel, NOW).find((n) => n.kind === 'live');
    expect(live?.big).toBe(copy.one.needs.live);
  });

  it('a your-turn task with no open ask asks nothing extra', () => {
    const noAsks = { ...demoReadModel(), pendingAsks: { byId: {}, ids: [] } };
    expect(oneNeeds(noAsks, NOW).every((n) => n.kind !== 'question')).toBe(true);
  });
});

describe('oneRecord', () => {
  it('says the audit log as sentences, newest first, and keeps today only when asked', () => {
    const all = oneRecord(demoReadModel(), NOW);
    expect(all[0]?.sentence).toBe('Claude used deploy token (auto: policy #1) · vercel-prod');
    expect(all.map((l) => l.sentence[0])).toEqual(all.map((l) => l.sentence[0]?.toUpperCase()));
    expect(oneRecord(demoReadModel(), NOW, 0, true).length).toBeLessThanOrEqual(all.length);
    expect(oneRecord(demoReadModel(), NOW + 3 * 86_400_000, 120, true)).toEqual([]);
  });

  it('leaves no dangling separator when a line has no target', () => {
    const m = demoReadModel();
    const e = rows(m.auditEntries)[0];
    if (e === undefined) throw new Error('fixture');
    const bare = { ...m, auditEntries: upsertRows({ byId: {}, ids: [] }, [{ ...e, targetLabel: '' }]) };
    expect(oneRecord(bare, NOW)[0]?.sentence.endsWith('·')).toBe(false);
  });
});

describe('oneProjects', () => {
  it('lists projects with their tasks, what needs the person and their apps', () => {
    expect(oneProjects(demoReadModel(), NOW).map((p) => [p.name, p.tasks, p.needs, p.apps.length])).toEqual([
      ['acme-shop', 4, 1, 5],
      ['blog-v2', 1, 1, 3],
      ['infra-tools', 1, 0, 2],
      ['client-x', 1, 0, 2],
      ['side-api', 1, 0, 1],
    ]);
    expect(oneProjects(demoReadModel(), NOW)[0]?.apps.some((a) => a.prod)).toBe(true);
  });

  it('marks a project without a repo, and leaves out removed projects', () => {
    const m = demoReadModel();
    const p = m.projects.byId[ids.project.clientX];
    if (p === undefined) throw new Error('fixture');
    const noRepo = { ...m, repos: { byId: {}, ids: [] } };
    expect(oneProjects(noRepo, NOW).every((x) => !x.hasCode)).toBe(true);
    const removed = { ...m, projects: upsertRows(m.projects, [{ ...p, removedAt: NOW }]) };
    expect(oneProjects(removed, NOW).map((x) => x.name)).not.toContain('client-x');
    expect(oneProjects(emptyReadModel(), NOW)).toEqual([]);
  });
});
