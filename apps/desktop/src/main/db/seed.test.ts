import Database from 'better-sqlite3';
import { fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../services/audit-service';
import { migrate } from './migrate';
import { Repos } from './repos';
import { seed } from './seed';

describe('seed', () => {
  it('seeds the demo fixture with a verifiable audit chain and is idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = new Repos(db, () => fixtures.DEMO_NOW);
    expect(seed(repos, fixtures.demoFixture())).toEqual({ seeded: true });
    const audit = new AuditService(db, () => fixtures.DEMO_NOW);
    expect(audit.verifyChain()).toMatchObject({ ok: true });
    audit.append({ actorKind: 'you', actorLabel: 'you', action: 'exported', triggeredBy: 'test' });
    expect(audit.verifyChain()).toMatchObject({ ok: true });
    expect(seed(repos, fixtures.demoFixture())).toEqual({ seeded: false });
  });
});
