import { newId, openUntil, type Policy } from '@styx/core';
import type { Container } from '../../container';
import { type CommandBus, fail } from '../bus';

/** grant.* · policy.* */
export function registerGrantCommands(bus: CommandBus, app: Container): void {
  const { grants, repos, publisher, audit, clock } = app;

  bus.register('grant.approve', async ({ grantId, duration, scope }) => {
    const g = await grants.approve(grantId, duration, scope);
    app.usageReports.record('grant.approved');
    return { grantId: g.id, expiresAt: openUntil(g) };
  });

  bus.register('grant.deny', ({ grantId }) => {
    grants.deny(grantId);
    return {};
  });

  bus.register('grant.revoke', ({ grantId, triggeredBy }) => {
    grants.revoke(grantId, triggeredBy, 'user');
    return {};
  });

  const auditPolicy = (policy: Policy, detail: Record<string, unknown>) => {
    const row = audit.append({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'policy-changed',
      policyId: policy.id,
      triggeredBy: 'settings',
      detail: { ruleText: policy.ruleText, ...detail },
    });
    publisher.upsert('auditEntries', [row.id]);
  };

  bus.register('policy.upsert', ({ policyId, rule, ruleText, enabled }) => {
    const existing = policyId ? repos.policies.get(policyId) : null;
    if (policyId && !existing) fail('not-found', `policy ${policyId} not found`);
    const policy: Policy = existing
      ? { ...existing, rule, ruleText, enabled }
      : {
          id: newId<'PolicyId'>(),
          ord: repos.policies.nextOrd(),
          rule,
          ruleText,
          enabled,
          builtinKey: null,
          matchCountToday: 0,
          matchCountWeek: 0,
          countersResetAt: clock.now(),
          createdAt: clock.now(),
        };
    repos.policies.upsert(policy);
    publisher.upsert('policies', [policy.id]);
    auditPolicy(policy, { op: existing ? 'update' : 'create' });
    return { policyId: policy.id };
  });

  bus.register('policy.toggle', ({ policyId, enabled }) => {
    const p = repos.policies.get(policyId) ?? fail('not-found', `policy ${policyId} not found`);
    repos.policies.upsert({ ...p, enabled });
    publisher.upsert('policies', [p.id]);
    auditPolicy(p, { op: 'toggle', enabled });
    return {};
  });

  bus.register('policy.reorder', ({ policyIds }) => {
    repos.policies.reorder(policyIds);
    const all = repos.policies.all();
    publisher.upsert(
      'policies',
      all.map((p) => p.id),
    );
    const row = audit.append({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'policy-changed',
      triggeredBy: 'settings',
      detail: { op: 'reorder', order: all.map((p) => p.id) },
    });
    publisher.upsert('auditEntries', [row.id]);
    return {};
  });

  bus.register('policy.remove', ({ policyId }) => {
    const p = repos.policies.get(policyId) ?? fail('not-found', `policy ${policyId} not found`);
    if (p.builtinKey !== null) fail('forbidden', 'builtin policies can be disabled, not removed');
    repos.policies.remove(p.id);
    publisher.remove('policies', [p.id]);
    auditPolicy(p, { op: 'remove' });
    return {};
  });

  bus.register('policy.export', () => ({
    json: `${JSON.stringify({ version: 1, exportedAt: clock.now(), policies: repos.policies.all() }, null, 2)}\n`,
  }));
}
