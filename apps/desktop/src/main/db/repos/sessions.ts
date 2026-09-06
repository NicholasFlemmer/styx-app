import { sessionSchema, type Session } from '@styx/core';
import type { Db } from '../open';
import { asBool, asNum, asStr, asTime, placeholders, toBit, toTime, type Raw } from './mappers';

const COLS = `id, project_id, worktree_id, agent, runner, model, state, paused_reason, note, first_message, auto_approve_edits, may_request_targets,
  notify_when_needs_me, pid, exit_code, started_at, last_activity_at, ended_at, archived_at, permission_mode, effort, cli_session_id, cost_usd, num_turns`;

export const sessionFromRow = (r: Raw): Session =>
  sessionSchema.parse({
    id: String(r['id']),
    projectId: String(r['project_id']),
    worktreeId: String(r['worktree_id'] ?? ''),
    agent: String(r['agent']),
    runner: String(r['runner']),
    model: asStr(r['model']),
    permissionMode: String(r['permission_mode'] ?? 'default'),
    effort: asStr(r['effort']),
    cliSessionId: asStr(r['cli_session_id']),
    costUsd: Number(r['cost_usd'] ?? 0),
    numTurns: Number(r['num_turns'] ?? 0),
    state: String(r['state']),
    pausedReason: asStr(r['paused_reason']),
    note: r['note'] === '' ? null : asStr(r['note']),
    firstMessage: asStr(r['first_message']),
    toggles: {
      autoApproveEdits: asBool(r['auto_approve_edits']),
      mayRequestTargets: asBool(r['may_request_targets']),
      notifyWhenNeedsMe: asBool(r['notify_when_needs_me']),
    },
    pid: asNum(r['pid']),
    exitCode: asNum(r['exit_code']),
    startedAt: Number(r['started_at']),
    lastActivityAt: asTime(r['last_activity_at']),
    endedAt: asNum(r['ended_at']),
    archivedAt: asNum(r['archived_at']),
  });

/** `sessions` table. `broker_token_hash` is not part of the entity and never leaves main. */
export class SessionsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly byProjectStmt;
  private readonly delStmt;
  private readonly tokenHashStmt;
  private readonly setTokenHashStmt;
  private readonly liveStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO sessions (${COLS}) VALUES (${placeholders(24)})
       ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, worktree_id = excluded.worktree_id, agent = excluded.agent, runner = excluded.runner, model = excluded.model,
         state = excluded.state, paused_reason = excluded.paused_reason, note = excluded.note, first_message = excluded.first_message, auto_approve_edits = excluded.auto_approve_edits,
         may_request_targets = excluded.may_request_targets, notify_when_needs_me = excluded.notify_when_needs_me, pid = excluded.pid, exit_code = excluded.exit_code,
         started_at = excluded.started_at, last_activity_at = excluded.last_activity_at, ended_at = excluded.ended_at, archived_at = excluded.archived_at,
         permission_mode = excluded.permission_mode, effort = excluded.effort, cli_session_id = excluded.cli_session_id, cost_usd = excluded.cost_usd, num_turns = excluded.num_turns`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM sessions WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM sessions ORDER BY rowid ASC`);
    this.byProjectStmt = db.prepare(`SELECT ${COLS} FROM sessions WHERE project_id = ? ORDER BY rowid ASC`);
    this.delStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
    this.tokenHashStmt = db.prepare('SELECT broker_token_hash FROM sessions WHERE id = ?');
    this.setTokenHashStmt = db.prepare('UPDATE sessions SET broker_token_hash = ? WHERE id = ?');
    this.liveStmt = db.prepare(`SELECT ${COLS} FROM sessions WHERE state != 'done' AND archived_at IS NULL`);
  }

  upsert(s: Session): void {
    this.upsertStmt.run(
      s.id,
      s.projectId,
      s.worktreeId,
      s.agent,
      s.runner,
      s.model,
      s.state,
      s.pausedReason,
      s.note ?? '',
      s.firstMessage,
      toBit(s.toggles.autoApproveEdits),
      toBit(s.toggles.mayRequestTargets),
      toBit(s.toggles.notifyWhenNeedsMe),
      s.pid,
      s.exitCode,
      s.startedAt,
      toTime(s.lastActivityAt),
      s.endedAt,
      s.archivedAt,
      s.permissionMode,
      s.effort,
      s.cliSessionId,
      s.costUsd,
      s.numTurns,
    );
  }

  get(id: string): Session | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? sessionFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Session[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM sessions WHERE id IN (${placeholders(ids.length)})`)
        .all(...ids) as Raw[]
    ).map(sessionFromRow);
  }

  all(): Session[] {
    return (this.allStmt.all() as Raw[]).map(sessionFromRow);
  }

  byProject(projectId: string): Session[] {
    return (this.byProjectStmt.all(projectId) as Raw[]).map(sessionFromRow);
  }

  /** Not done and not archived. */
  live(): Session[] {
    return (this.liveStmt.all() as Raw[]).map(sessionFromRow);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }

  brokerTokenHash(id: string): string | null {
    const r = this.tokenHashStmt.get(id) as { broker_token_hash: string } | undefined;
    return r && r.broker_token_hash !== '' ? r.broker_token_hash : null;
  }

  setBrokerTokenHash(id: string, hash: string): void {
    this.setTokenHashStmt.run(hash, id);
  }
}
