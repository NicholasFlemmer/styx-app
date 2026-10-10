import { fixtures, type GrantId, type Policy } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  askForGrant,
  autoApprovedToday,
  clockOffsetMinutes,
  inboxFooter,
  policiesInOrder,
  policyMeta,
} from './approvals-data';

const model = fixtures.demoReadModel();
const policies = policiesInOrder(model);

describe('approvals-data', () => {
  it('lists policies by ord', () => {
    expect(policies.map((p) => p.ord)).toEqual([1, 2, 3]);
  });

  it.each<[string, (p: Policy) => Policy, string]>([
    ['auto-approve reads matches today', (p) => p, 'matches 12 today'],
    ['ask reads matches today', (p) => ({ ...p, matchCountToday: 2 }), 'matches 2 today'],
    [
      'idle expiry reads revoked this week',
      (p) => ({ ...p, rule: { kind: 'idle-expiry', match: {}, idleMs: 1 }, matchCountWeek: 5 }),
      'revoked 5 this week',
    ],
  ])('policyMeta: %s', (_name, tweak, expected) => {
    const first = policies[0];
    if (first === undefined) throw new Error('fixture has no policies');
    expect(policyMeta(tweak(first))).toBe(expected);
  });

  it('counts auto-approve matches today even when the rule is off (prototype: 12)', () => {
    expect(autoApprovedToday(policies)).toBe(12);
    const matched = policies.filter((p) => p.rule.kind === 'auto-approve' && p.matchCountToday > 0);
    expect(inboxFooter(policies)).toBe(
      `auto-approved today: 12, by ${matched.map((p) => `policy #${p.ord}`).join(', ')}`,
    );
  });

  it('names no rules when nothing was auto-approved today (issue 11)', () => {
    const quiet = policies.map((p) => ({ ...p, matchCountToday: 0 }));
    expect(inboxFooter(quiet)).toBe('auto-approved today: 0');
  });

  it('finds the open grant ask behind an inbox row', () => {
    expect(askForGrant(model, fixtures.ids.grant.supabaseCodex)?.id).toBe(fixtures.ids.ask.codexGrant);
    expect(askForGrant(model, 'nope' as GrantId)).toBeNull();
  });

  it('uses UTC when the clock is frozen, local offset otherwise', () => {
    expect(clockOffsetMinutes(true, fixtures.DEMO_NOW)).toBe(0);
    expect(clockOffsetMinutes(false, fixtures.DEMO_NOW)).toBe(
      -new Date(fixtures.DEMO_NOW).getTimezoneOffset(),
    );
  });
});
