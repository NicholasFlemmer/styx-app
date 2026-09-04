import { targetSchema, type Target } from '@styx/core';
import type { Db } from '../open';
import { asBool, asJson, asNum, asStr, placeholders, toBit, toJson, type Raw } from './mappers';

const COLS = `id, project_id, provider, name, env, auth_method, policy, policy_source, credential_ref, config_json, health, health_checked_at, expired_at, from_project_file, created_at`;

export const targetFromRow = (r: Raw): Target =>
  targetSchema.parse({
    id: String(r['id']),
    projectId: String(r['project_id']),
    provider: String(r['provider']),
    name: String(r['name']),
    env: String(r['env']),
    authMethod: String(r['auth_method']),
    policy: String(r['policy']),
    policySource: String(r['policy_source']),
    credentialRef: asStr(r['credential_ref']),
    health: String(r['health']),
    healthCheckedAt: asNum(r['health_checked_at']),
    expiredAt: asNum(r['expired_at']),
    config: asJson<Record<string, unknown>>(r['config_json'], {}),
    fromProjectFile: asBool(r['from_project_file']),
    createdAt: Number(r['created_at']),
  });

/** `targets` table. `credential_ref` is a keychain reference, never a secret. */
export class TargetsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly byProjectStmt;
  private readonly delStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO targets (${COLS}) VALUES (${placeholders(15)})
       ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, provider = excluded.provider, name = excluded.name, env = excluded.env, auth_method = excluded.auth_method,
         policy = excluded.policy, policy_source = excluded.policy_source, credential_ref = excluded.credential_ref, config_json = excluded.config_json, health = excluded.health,
         health_checked_at = excluded.health_checked_at, expired_at = excluded.expired_at, from_project_file = excluded.from_project_file, created_at = excluded.created_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM targets WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM targets ORDER BY created_at ASC, rowid ASC`);
    this.byProjectStmt = db.prepare(
      `SELECT ${COLS} FROM targets WHERE project_id = ? ORDER BY created_at ASC, rowid ASC`,
    );
    this.delStmt = db.prepare('DELETE FROM targets WHERE id = ?');
  }

  upsert(t: Target): void {
    this.upsertStmt.run(
      t.id,
      t.projectId,
      t.provider,
      t.name,
      t.env,
      t.authMethod,
      t.policy,
      t.policySource,
      t.credentialRef,
      toJson(t.config),
      t.health,
      t.healthCheckedAt,
      t.expiredAt,
      toBit(t.fromProjectFile),
      t.createdAt,
    );
  }

  get(id: string): Target | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? targetFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Target[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM targets WHERE id IN (${placeholders(ids.length)})`)
        .all(...ids) as Raw[]
    ).map(targetFromRow);
  }

  all(): Target[] {
    return (this.allStmt.all() as Raw[]).map(targetFromRow);
  }

  byProject(projectId: string): Target[] {
    return (this.byProjectStmt.all(projectId) as Raw[]).map(targetFromRow);
  }

  /** Match by display name (case-insensitive), by slug ("supabase-prod"), or by `provider:env`. */
  resolve(projectId: string, query: string): Target | null {
    const q = query.trim().toLowerCase();
    const list = this.byProject(projectId);
    const slug = (t: Target) => `${t.provider}-${t.env}`;
    return (
      list.find((t) => t.name.toLowerCase() === q) ??
      list.find((t) => slug(t) === q || `${t.provider}:${t.env}` === q) ??
      list.find(
        (t) => `${t.name.toLowerCase()} ${t.env}` === q || `${t.name.toLowerCase()}-${t.env}` === q,
      ) ??
      list.find((t) => t.provider === q) ??
      null
    );
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}

/** Audit slug: "vercel-prod", "aws-acme-prod", "github". */
export const targetLabel = (t: Pick<Target, 'provider' | 'name' | 'env'>): string => {
  const name = t.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (t.env === 'scm') return t.provider;
  return name.startsWith(t.provider)
    ? `${name}${name === t.provider ? `-${t.env}` : ''}`
    : `${t.provider}-${name}`;
};
