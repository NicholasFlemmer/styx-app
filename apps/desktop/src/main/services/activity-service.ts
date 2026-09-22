import { newId, type ActivityRow, type AuditEntry, type ProjectId, type SessionId } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';

const VERB: Partial<Record<AuditEntry['action'], (e: AuditEntry) => string>> = {
  requested: (e) => `requested ${e.targetLabel ?? 'access'} ${(e.scope ?? []).join(' + ')}`,
  granted: (e) =>
    `granted ${e.targetLabel ?? 'access'} · ${(e.scope ?? []).join(' + ')} · ${e.duration ?? ''}`.trim(),
  denied: (e) => `denied ${e.targetLabel ?? 'access'}`,
  used: (e) => `used ${e.targetLabel ?? 'a target'}${e.triggeredBy ? ` · ${e.triggeredBy}` : ''}`,
  revoked: (e) =>
    `revoked ${e.agent ?? 'agent'} → ${e.targetLabel ?? 'target'}${e.detail['reason'] ? ` (${String(e.detail['reason'])})` : ''}`,
  expired: (e) =>
    `revoked ${e.agent ?? 'agent'} → ${e.targetLabel ?? 'target'} (${String(e.detail['reason'] ?? 'expired')})`,
  'opened-pr': (e) => `opened PR #${String(e.detail['prNumber'] ?? '')}`,
  'merged-pr': (e) => `merged PR #${String(e.detail['prNumber'] ?? '')}`,
  connected: (e) => `connected ${e.targetLabel ?? 'target'}`,
  disconnected: (e) => `removed ${e.targetLabel ?? 'target'}`,
};

/** Appends Home feed rows (`activity.append` delta). Audit rows and session lifecycle both land here. */
export class ActivityService {
  constructor(
    private readonly repos: Repos,
    private readonly publisher: Publisher,
    private readonly clock: Clock,
  ) {}

  append(row: Omit<ActivityRow, 'id' | 'at'> & { at?: number }): ActivityRow {
    const full: ActivityRow = {
      id: `activity-${newId<'ActivityId'>()}`,
      at: row.at ?? this.clock.now(),
      who: row.who,
      what: row.what,
      projectId: row.projectId,
      sessionId: row.sessionId,
    };
    this.repos.activity.insert(full);
    this.publisher.activityAppend([full]);
    return full;
  }

  fromAudit(e: AuditEntry): void {
    const verb = VERB[e.action];
    if (!verb) return;
    const project = e.projectId ? this.repos.projects.get(e.projectId) : null;
    const what = project ? `${project.name} · ${verb(e)}` : verb(e);
    this.append({
      at: e.time,
      who: e.actorLabel,
      what,
      projectId: (e.projectId ?? null) as ProjectId | null,
      sessionId: (e.sessionId ?? null) as SessionId | null,
    });
  }
}
