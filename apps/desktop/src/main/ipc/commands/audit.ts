import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** audit.* */
export function registerAuditCommands(bus: CommandBus, app: Container): void {
  const { repos, audit, publisher } = app;

  bus.register('audit.list', ({ cursor, limit, targetId, sessionId }) => {
    const entries = repos.audit.list({
      beforeSeq: cursor,
      limit,
      ...(targetId ? { targetId } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    const last = entries.at(-1);
    return { entries, nextCursor: entries.length === limit && last ? last.seq : null };
  });

  bus.register('audit.export', () => {
    const json = audit.exportJson();
    const row = audit.append({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'exported',
      triggeredBy: 'settings',
      detail: { entries: repos.audit.all().length },
    });
    publisher.upsert('auditEntries', [row.id]);
    return { json };
  });

  bus.register('audit.verifyChain', () => {
    const r = audit.verifyChain();
    return r.ok ? { ok: true, brokenAtSeq: null } : { ok: false, brokenAtSeq: r.brokenAtSeq };
  });
}
