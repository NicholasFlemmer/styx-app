import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../services/audit-service';
import { parseFrontmatter, SkillsService } from '../services/skills-service';
import { migrate } from './migrate';
import { Repos } from './repos';
import { seed, seedSkills } from './seed';

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

describe('seedSkills', () => {
  const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `styx-seed-${tag}-`));

  it('writes each fixture skill as SKILL.md where its agent CLI reads it: global rows under home, project rows under the project', () => {
    const home = tmp('home');
    const project = tmp('project');
    const written = seedSkills(fixtures.demoSkills(), { home, projectDir: project });
    expect(written).toEqual([
      join(home, '.claude', 'skills', 'pdf', 'SKILL.md'),
      join(project, '.claude', 'skills', 'release-notes', 'SKILL.md'),
      join(home, '.agents', 'skills', 'sql-review', 'SKILL.md'),
    ]);
    for (const [i, skill] of fixtures.demoSkills().entries()) {
      const text = readFileSync(written[i] ?? '', 'utf8');
      expect(parseFrontmatter(text)).toEqual({ name: skill.name, description: skill.description });
      expect(text).toContain(`# ${skill.name}`);
    }
  });

  it('the SkillsService lists exactly the fixture rows back from those files', async () => {
    const home = tmp('home');
    const project = tmp('project');
    seedSkills(fixtures.demoSkills(), { home, projectDir: project });
    const acme = fixtures.ids.project.acmeShop;
    const repos = {
      projects: { get: (id: string) => (id === acme ? { path: project } : null) },
    } as unknown as Repos;
    const svc = new SkillsService({ repos, fetch: vi.fn() as unknown as typeof fetch, home });
    expect(await svc.list(acme)).toEqual(fixtures.demoSkills());
  });

  it('skips project rows when there is no project dir, and never writes outside the two roots', () => {
    const home = tmp('home');
    const written = seedSkills(
      [
        ...fixtures.demoSkills(),
        { name: 'evil', directory: '../evil', description: 'escapes', scope: 'global', host: 'claude' },
        { name: 'cat', directory: 'cat', description: 'catalogue row', scope: 'catalogue', host: null },
      ],
      { home, projectDir: null },
    );
    expect(written).toEqual([
      join(home, '.claude', 'skills', 'pdf', 'SKILL.md'),
      join(home, '.agents', 'skills', 'sql-review', 'SKILL.md'),
    ]);
    expect(existsSync(join(home, '.claude', 'evil'))).toBe(false);
    expect(existsSync(join(home, 'evil'))).toBe(false);
  });

  it('seed() writes the skills when given a skillsHome, on every call, even when the DB is already seeded', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = new Repos(db, () => fixtures.DEMO_NOW);
    const home = tmp('home');
    expect(seed(repos, fixtures.demoFixture(), { skillsHome: home })).toEqual({ seeded: true });
    const pdf = join(home, '.claude', 'skills', 'pdf', 'SKILL.md');
    expect(existsSync(pdf)).toBe(true);
    // No project dir: the project row stays unwritten rather than landing in the fixture's fake project path.
    expect(existsSync(join(home, '.claude', 'skills', 'release-notes'))).toBe(false);
    const again = tmp('home');
    expect(seed(repos, fixtures.demoFixture(), { skillsHome: again })).toEqual({ seeded: false });
    expect(existsSync(join(again, '.agents', 'skills', 'sql-review', 'SKILL.md'))).toBe(true);
  });

  it('the empty fixture writes nothing', () => {
    const home = tmp('home');
    expect(seedSkills(fixtures.emptyFixture().skills, { home, projectDir: null })).toEqual([]);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});
