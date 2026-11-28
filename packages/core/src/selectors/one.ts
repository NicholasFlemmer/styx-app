import { copy, fill } from '../copy';
import type { AuditId, GrantId, ProjectId, SessionId } from '../ids';
import { AGENT_LABEL } from '../model/common';
import type { PendingAsk, Session } from '../model/session';
import { formatMoney, launchCap, type TaskResult } from '../model/task-result';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { auditRows } from './audit';
import { headAskOf, isReadyToLand, projectNameOf, repoOf } from './common';
import { formatAge } from './format';
import { inboxRows } from './inbox';
import { taskOf } from './lanes';

/**
 * "One place for the work" mode (ADR-0033): the same read model, said in plain words. Tasks are lanes, Needs your
 * OK is grant requests + open questions + work ready to go live, the record is the audit log. Pure.
 */

export type OneTaskKind = 'code' | 'design' | 'campaign' | 'report';

export type OneTaskState = 'your-turn' | 'working' | 'idle' | 'paused' | 'ready' | 'landed' | 'finished';

export interface OneTask {
  sessionId: SessionId;
  projectId: ProjectId;
  project: string;
  title: string;
  /** What the task makes: code (a build lane), a design, a campaign or a report. */
  kind: OneTaskKind;
  state: OneTaskState;
  /** One plain sentence: "Asks you: …", "Working · 2m", "Done · ready to go live". */
  line: string;
  /** The AI working on it, for the small colour square. */
  agent: Session['agent'];
  at: number;
}

const RANK: Record<OneTaskState, number> = {
  'your-turn': 0,
  ready: 1,
  working: 2,
  idle: 3,
  paused: 4,
  landed: 5,
  finished: 6,
};

/** The question an open ask puts to the person, in one line; null for a grant ask (Needs your OK shows those). */
export const askQuestion = (ask: Pick<PendingAsk, 'payload'>): string | null => {
  const p = ask.payload;
  switch (p.kind) {
    case 'grant':
      return null;
    case 'plan':
      return p.summary;
    case 'decision':
    case 'question':
      return p.prompt;
    case 'questions':
      return p.questions[0]?.prompt ?? null;
  }
};

/** The task's state, and when it went live for a landed one. */
const stateOf = (model: ReadModel, s: Session): [OneTaskState, number] => {
  switch (s.state) {
    case 'needs-you':
      return ['your-turn', 0];
    case 'working':
      return ['working', 0];
    case 'idle':
      return ['idle', 0];
    case 'paused':
      return ['paused', 0];
    case 'done': {
      if (isReadyToLand(model, s)) return ['ready', 0];
      const merged = model.worktrees.byId[s.worktreeId]?.mergedAt ?? null;
      return merged === null ? ['finished', 0] : ['landed', merged];
    }
  }
};

const lineOf = (model: ReadModel, s: Session, state: OneTaskState, landedAt: number, now: number): string => {
  if (state === 'your-turn') {
    const ask = headAskOf(model, s.id);
    const q = ask === null ? null : askQuestion(ask);
    return q === null
      ? copy.one.status['your-turn']
      : fill(copy.one.status.asks, { question: q.slice(0, 140) });
  }
  if (state === 'landed') return fill(copy.one.status.landed, { age: formatAge(landedAt, now) });
  return fill(copy.one.status[state], { age: formatAge(s.lastActivityAt ?? s.startedAt, now) });
};

/** Every task the person started (background tasks excluded), whose move it is first, newest first within. */
export const oneTasks = (model: ReadModel, now: number, projectId: ProjectId | null = null): OneTask[] =>
  rows(model.sessions)
    .filter(
      (s) =>
        s.archivedAt === null &&
        !s.purpose &&
        (projectId === null || s.projectId === projectId) &&
        model.projects.byId[s.projectId]?.removedAt == null,
    )
    .map((s): OneTask => {
      const [state, landedAt] = stateOf(model, s);
      // A campaign or report names itself; anything else is named by what was asked.
      const title = model.taskResults[s.id]?.body.title ?? taskOf(s);
      return {
        sessionId: s.id,
        projectId: s.projectId,
        project: projectNameOf(model, s.projectId),
        title: title === '' ? fill(copy.lanes.nav.untitled, { agent: AGENT_LABEL[s.agent] }) : title,
        kind: s.kind === undefined || s.kind === null || s.kind === 'build' ? 'code' : s.kind,
        state,
        line: lineOf(model, s, state, landedAt, now),
        agent: s.agent,
        at: s.lastActivityAt ?? s.startedAt,
      };
    })
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at);

export type OneNeed =
  | {
      kind: 'access';
      key: string;
      grantId: GrantId;
      sessionId: SessionId | null;
      projectId: ProjectId;
      project: string;
      title: string;
      /** The consequence, in big type: the target. */
      big: string;
      prod: boolean;
      /** Production write, deploy or delete: approving asks for Touch ID (or Windows Hello, polkit). */
      osAuth: boolean;
      reason: string;
      age: string;
      at: number;
    }
  | {
      kind: 'question';
      key: string;
      sessionId: SessionId;
      projectId: ProjectId;
      project: string;
      title: string;
      big: string;
      age: string;
      at: number;
    }
  | {
      /** A campaign whose launch plan waits for the person's OK. */
      kind: 'launch';
      key: string;
      sessionId: SessionId;
      projectId: ProjectId;
      project: string;
      title: string;
      big: string;
      age: string;
      at: number;
    }
  | {
      kind: 'live';
      key: string;
      sessionId: SessionId;
      projectId: ProjectId;
      project: string;
      title: string;
      big: string;
      age: string;
      at: number;
    };

/** Everything waiting on the person: access requests, questions, and finished work ready to go live. Newest first. */
export const oneNeeds = (model: ReadModel, now: number): OneNeed[] => {
  const out: OneNeed[] = [];
  for (const r of inboxRows(model, now))
    out.push({
      kind: 'access',
      key: `grant:${r.grantId}`,
      grantId: r.grantId,
      sessionId: r.sessionId,
      projectId: r.projectId,
      project: r.project,
      title: fill(copy.one.needs.access, { agent: r.agent, scope: r.scope, target: r.target }),
      big: r.target,
      prod: r.prod,
      osAuth: r.prod && r.scopes.some((x) => x !== 'read'),
      reason: r.reason,
      age: r.age,
      at: r.requestedAt,
    });
  for (const t of oneTasks(model, now)) {
    if (t.state === 'your-turn') {
      const ask = headAskOf(model, t.sessionId);
      const q = ask === null ? null : askQuestion(ask);
      if (ask === null || q === null) continue;
      out.push({
        kind: 'question',
        key: `ask:${ask.id}`,
        sessionId: t.sessionId,
        projectId: t.projectId,
        project: t.project,
        title: fill(copy.one.needs.question, { task: t.title }),
        big: q.slice(0, 200),
        age: formatAge(ask.createdAt, now),
        at: ask.createdAt,
      });
    } else if (t.state === 'ready')
      out.push({
        kind: 'live',
        key: `live:${t.sessionId}`,
        sessionId: t.sessionId,
        projectId: t.projectId,
        project: t.project,
        title: t.title,
        big: copy.one.needs.live,
        age: formatAge(t.at, now),
        at: t.at,
      });
  }
  // Campaigns whose launch waits for the person: the money in big type.
  for (const r of Object.values(model.taskResults)) {
    const session = model.sessions.byId[r.id];
    if (session === undefined || r.body.kind !== 'campaign' || r.body.launch === undefined) continue;
    if (resultStatus(r, now) !== 'waiting') continue;
    const plan = r.body.launch;
    out.push({
      kind: 'launch',
      key: `launch:${r.id}`,
      sessionId: session.id,
      projectId: session.projectId,
      project: projectNameOf(model, session.projectId),
      title: fill(copy.one.needs.launch, { title: r.body.title }),
      big: fill(copy.one.needs.launchBig, { cap: formatMoney(launchCap(plan), plan.currency) }),
      age: formatAge(r.updatedAt, now),
      at: r.updatedAt,
    });
  }
  return out.sort((a, b) => b.at - a.at);
};

export interface OneRecordLine {
  id: AuditId;
  time: string;
  /** "Claude used deploy token on vercel-prod" */
  sentence: string;
  at: number;
}

/** "you granted …" opens a sentence as "You granted …". */
const capital = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1);

const startOfDay = (now: number, offsetMinutes: number): number => {
  const local = now + offsetMinutes * 60_000;
  return local - (local % 86_400_000) - offsetMinutes * 60_000;
};

/** The audit log as sentences, newest first; `todayOnly` keeps what happened since midnight. */
export const oneRecord = (
  model: ReadModel,
  now: number,
  utcOffsetMinutes = 0,
  todayOnly = false,
): OneRecordLine[] => {
  const since = todayOnly ? startOfDay(now, utcOffsetMinutes) : 0;
  return auditRows(model, now, utcOffsetMinutes)
    .filter((r) => r.time >= since)
    .map((r) => ({
      id: r.id,
      time: r.t,
      sentence: capital(
        [r.who, r.what, r.target === '' ? '' : `· ${r.target}`].filter((x) => x !== '').join(' '),
      ),
      at: r.time,
    }));
};

export interface OneProject {
  projectId: ProjectId;
  name: string;
  path: string;
  hasCode: boolean;
  tasks: number;
  needs: number;
  ready: number;
  /** Apps (targets) connected for this project, by display name. */
  apps: { id: string; name: string; prod: boolean }[];
  at: number;
}

/** Every live project with what is going on in it. */
export const oneProjects = (model: ReadModel, now: number): OneProject[] => {
  const tasks = oneTasks(model, now);
  return rows(model.projects)
    .filter((p) => p.removedAt == null)
    .map((p): OneProject => {
      const mine = tasks.filter((t) => t.projectId === p.id);
      return {
        projectId: p.id,
        name: p.name,
        path: p.path,
        hasCode: repoOf(model, p.id) !== null,
        tasks: mine.length,
        needs: mine.filter((t) => t.state === 'your-turn').length,
        ready: mine.filter((t) => t.state === 'ready').length,
        apps: rows(model.targets)
          .filter((t) => t.projectId === p.id)
          .map((t) => ({ id: t.id, name: t.name, prod: t.env === 'prod' })),
        at: Math.max(0, ...mine.map((t) => t.at)),
      };
    })
    .sort((a, b) => b.needs - a.needs || b.at - a.at);
};

/** Where a campaign or report stands, first thing on its card (mockup styx-one-results.html, frame 7). */
export type ResultStatus =
  'draft' | 'waiting' | 'launching' | 'live' | 'paused' | 'ended' | 'ready' | 'weekly';

const RESULT_DAY = 86_400_000;

export const resultStatus = (r: TaskResult, now: number): ResultStatus => {
  if (r.body.kind === 'report') return r.weekly ? 'weekly' : 'ready';
  if (r.launchApprovedAt === null || r.approved === null)
    return r.body.launch === undefined ? 'draft' : 'waiting';
  if (r.pausedAt !== null) return 'paused';
  if (now > r.launchApprovedAt + (r.approved.plan.days + 1) * RESULT_DAY) return 'ended';
  return r.campaignId === null ? 'launching' : 'live';
};

/** What needs the person sorts first, then what is running, then the rest, newest first within. */
const STATUS_RANK: Record<ResultStatus, number> = {
  waiting: 0,
  live: 1,
  launching: 2,
  paused: 3,
  weekly: 4,
  ready: 5,
  draft: 6,
  ended: 7,
};

export interface OneResult {
  id: string;
  projectId: string;
  project: string;
  kind: 'campaign' | 'report';
  title: string;
  status: ResultStatus;
  /** One plain line: the plan's money, or the report's answer. */
  line: string;
  at: number;
}

/** Every campaign and report whose task is still here, by what needs the person. */
export const oneResults = (model: ReadModel, now: number): OneResult[] =>
  Object.values(model.taskResults)
    .filter((r) => model.sessions.byId[r.id] !== undefined)
    .map((r): OneResult => {
      const plan = r.approved?.plan ?? (r.body.kind === 'campaign' ? r.body.launch : undefined);
      return {
        id: r.id,
        projectId: r.projectId,
        project: projectNameOf(model, r.projectId as ProjectId),
        kind: r.body.kind,
        title: r.body.title,
        status: resultStatus(r, now),
        line:
          r.body.kind === 'report'
            ? r.body.headline
            : plan === undefined
              ? fill(copy.one.results.adsN, { n: r.body.ads.length })
              : fill(copy.one.results.planLine, {
                  perDay: formatMoney(plan.perDay, plan.currency),
                  days: plan.days,
                  cap: formatMoney(launchCap(plan), plan.currency),
                }),
        at: r.updatedAt,
      };
    })
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.at - a.at);
