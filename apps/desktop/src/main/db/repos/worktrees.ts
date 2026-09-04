import { worktreeSchema, type Worktree } from '@styx/core';
import type { Db } from '../open';
import { asBool, asNum, asStr, placeholders, toBit, type Raw } from './mappers';

const COLS = `w.id, w.repo_id, r.project_id, w.branch, w.path, w.is_main, w.owner_kind, w.owner_session_id, w.base_commit, w.head_commit, w.added, w.removed, w.files_changed,
  w.pr_number, w.pr_state, w.pr_url, w.conflict_file, w.conflict_against, w.merged_at, w.created_at, w.archived_at`;
const SELECT = `SELECT ${COLS} FROM worktrees w JOIN repos r ON r.id = w.repo_id`;

export const worktreeFromRow = (r: Raw): Worktree => {
  const prNumber = asNum(r['pr_number']);
  const conflictFile = asStr(r['conflict_file']);
  return worktreeSchema.parse({
    id: String(r['id']),
    repoId: String(r['repo_id']),
    projectId: String(r['project_id']),
    branch: String(r['branch']),
    path: String(r['path']),
    isMain: asBool(r['is_main']),
    owner:
      r['owner_kind'] === 'session' && r['owner_session_id']
        ? { kind: 'session', sessionId: String(r['owner_session_id']) }
        : { kind: 'user' },
    baseCommit: asStr(r['base_commit']),
    headCommit: asStr(r['head_commit']),
    changes: { added: Number(r['added']), removed: Number(r['removed']), files: Number(r['files_changed']) },
    pr:
      prNumber === null
        ? null
        : { number: prNumber, state: String(r['pr_state'] ?? 'open'), url: asStr(r['pr_url']) },
    conflict:
      conflictFile === null ? null : { file: conflictFile, against: String(r['conflict_against'] ?? 'main') },
    mergedAt: asNum(r['merged_at']),
    createdAt: Number(r['created_at']),
    archivedAt: asNum(r['archived_at']),
  });
};

/** `worktrees` table; `projectId` comes from the owning repo. */
export class WorktreesRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly byRepoStmt;
  private readonly byProjectStmt;
  private readonly bySessionStmt;
  private readonly delStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO worktrees (id, repo_id, branch, path, is_main, owner_kind, owner_session_id, base_commit, head_commit, added, removed, files_changed,
         pr_number, pr_state, pr_url, conflict_file, conflict_against, merged_at, created_at, archived_at) VALUES (${placeholders(20)})
       ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, branch = excluded.branch, path = excluded.path, is_main = excluded.is_main, owner_kind = excluded.owner_kind,
         owner_session_id = excluded.owner_session_id, base_commit = excluded.base_commit, head_commit = excluded.head_commit, added = excluded.added, removed = excluded.removed,
         files_changed = excluded.files_changed, pr_number = excluded.pr_number, pr_state = excluded.pr_state, pr_url = excluded.pr_url, conflict_file = excluded.conflict_file,
         conflict_against = excluded.conflict_against, merged_at = excluded.merged_at, created_at = excluded.created_at, archived_at = excluded.archived_at`,
    );
    this.getStmt = db.prepare(`${SELECT} WHERE w.id = ?`);
    this.allStmt = db.prepare(`${SELECT} ORDER BY w.created_at ASC, w.rowid ASC`);
    this.byRepoStmt = db.prepare(`${SELECT} WHERE w.repo_id = ? ORDER BY w.created_at ASC`);
    this.byProjectStmt = db.prepare(`${SELECT} WHERE r.project_id = ? ORDER BY w.created_at ASC`);
    this.bySessionStmt = db.prepare(`${SELECT} WHERE w.owner_kind = 'session' AND w.owner_session_id = ?`);
    this.delStmt = db.prepare('DELETE FROM worktrees WHERE id = ?');
  }

  upsert(w: Worktree): void {
    this.upsertStmt.run(
      w.id,
      w.repoId,
      w.branch,
      w.path,
      toBit(w.isMain),
      w.owner.kind,
      w.owner.kind === 'session' ? w.owner.sessionId : null,
      w.baseCommit,
      w.headCommit,
      w.changes.added,
      w.changes.removed,
      w.changes.files,
      w.pr?.number ?? null,
      w.pr?.state ?? null,
      w.pr?.url ?? null,
      w.conflict?.file ?? null,
      w.conflict?.against ?? null,
      w.mergedAt,
      w.createdAt,
      w.archivedAt,
    );
  }

  get(id: string): Worktree | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? worktreeFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Worktree[] {
    if (ids.length === 0) return [];
    return (
      this.db.prepare(`${SELECT} WHERE w.id IN (${placeholders(ids.length)})`).all(...ids) as Raw[]
    ).map(worktreeFromRow);
  }

  all(): Worktree[] {
    return (this.allStmt.all() as Raw[]).map(worktreeFromRow);
  }

  byRepo(repoId: string): Worktree[] {
    return (this.byRepoStmt.all(repoId) as Raw[]).map(worktreeFromRow);
  }

  byProject(projectId: string): Worktree[] {
    return (this.byProjectStmt.all(projectId) as Raw[]).map(worktreeFromRow);
  }

  mainOf(projectId: string): Worktree | null {
    return this.byProject(projectId).find((w) => w.isMain) ?? null;
  }

  ownedBySession(sessionId: string): Worktree | null {
    const r = this.bySessionStmt.get(sessionId) as Raw | undefined;
    return r ? worktreeFromRow(r) : null;
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
