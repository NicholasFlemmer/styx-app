import { policySchema, type Policy } from '@styx/core';
import type { Db } from '../open';
import { asBool, asJson, asStr, asTime, placeholders, toBit, toJson, toTime, type Raw } from './mappers';

const COLS =
  'id, ord, rule_json, rule_text, enabled, builtin_key, match_count_today, match_count_week, counters_reset_at, created_at';

export const policyFromRow = (r: Raw): Policy =>
  policySchema.parse({
    id: String(r['id']),
    ord: Number(r['ord']),
    rule: asJson<unknown>(r['rule_json'], {}),
    ruleText: String(r['rule_text']),
    enabled: asBool(r['enabled']),
    builtinKey: asStr(r['builtin_key']),
    matchCountToday: Number(r['match_count_today']),
    matchCountWeek: Number(r['match_count_week']),
    countersResetAt: asTime(r['counters_reset_at']),
    createdAt: Number(r['created_at']),
  });

/** `policies` table (app-level rules, ordered by `ord`, unique). */
export class PoliciesRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly delStmt;
  private readonly maxOrdStmt;
  private readonly setOrdStmt;
  private readonly bumpStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO policies (${COLS}) VALUES (${placeholders(10)})
       ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, rule_json = excluded.rule_json, rule_text = excluded.rule_text, enabled = excluded.enabled, builtin_key = excluded.builtin_key,
         match_count_today = excluded.match_count_today, match_count_week = excluded.match_count_week, counters_reset_at = excluded.counters_reset_at, created_at = excluded.created_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM policies WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM policies ORDER BY ord ASC`);
    this.delStmt = db.prepare('DELETE FROM policies WHERE id = ?');
    this.maxOrdStmt = db.prepare('SELECT COALESCE(MAX(ord), 0) AS m FROM policies');
    this.setOrdStmt = db.prepare('UPDATE policies SET ord = ? WHERE id = ?');
    this.bumpStmt = db.prepare(
      'UPDATE policies SET match_count_today = match_count_today + 1, match_count_week = match_count_week + 1 WHERE id = ?',
    );
  }

  upsert(p: Policy): void {
    this.upsertStmt.run(
      p.id,
      p.ord,
      toJson(p.rule),
      p.ruleText,
      toBit(p.enabled),
      p.builtinKey,
      p.matchCountToday,
      p.matchCountWeek,
      toTime(p.countersResetAt),
      p.createdAt,
    );
  }

  get(id: string): Policy | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? policyFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Policy[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM policies WHERE id IN (${placeholders(ids.length)}) ORDER BY ord ASC`)
        .all(...ids) as Raw[]
    ).map(policyFromRow);
  }

  all(): Policy[] {
    return (this.allStmt.all() as Raw[]).map(policyFromRow);
  }

  nextOrd(): number {
    return Number((this.maxOrdStmt.get() as { m: number }).m) + 1;
  }

  /** Re-numbers `ord` 1..n in the given order (unlisted policies keep their relative order after). Unique index is satisfied via a two-pass update. */
  reorder(ids: readonly string[]): void {
    const tx = this.db.transaction((order: readonly string[]) => {
      const all = this.all();
      const listed = order.filter((id) => all.some((p) => p.id === id));
      const rest = all.filter((p) => !listed.includes(p.id)).map((p) => p.id);
      const final = [...listed, ...rest];
      final.forEach((id, i) => this.setOrdStmt.run(-(i + 1), id));
      final.forEach((id, i) => this.setOrdStmt.run(i + 1, id));
    });
    tx(ids);
  }

  bumpMatch(id: string): void {
    this.bumpStmt.run(id);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
