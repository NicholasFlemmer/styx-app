import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Repos } from '../db/repos';
import {
  FIXTURE_CATALOGUE,
  fixtureCatalogueFetch,
  fixtureCatalogueText,
  fixtureSkillMarkdown,
  fixtureSkillsFetch,
  isCatalogueUrl,
} from './skills-fixture';
import { parseFrontmatter, SkillsService } from './skills-service';

const CONTENTS = 'https://api.github.com/repos/anthropics/skills/contents/skills';
const raw = (dir: string) =>
  `https://raw.githubusercontent.com/anthropics/skills/main/skills/${dir}/SKILL.md`;
const repos = { projects: { get: () => null } } as unknown as Repos;

describe('fixtureSkillsFetch', () => {
  it('lists the three canned skills plus the non-skill entries the service has to skip', async () => {
    const res = await fixtureSkillsFetch(CONTENTS);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { name: string; type: string }[];
    expect(rows.filter((r) => r.type === 'dir').map((r) => r.name)).toEqual([
      'pdf',
      'xlsx',
      'frontend-design',
      'template',
    ]);
    expect(rows.some((r) => r.type === 'file')).toBe(true);
  });

  it('serves each canned SKILL.md with the frontmatter the service reads', async () => {
    for (const skill of FIXTURE_CATALOGUE) {
      const res = await fixtureSkillsFetch(raw(skill.directory));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(parseFrontmatter(text)).toEqual({ name: skill.name, description: skill.description });
      expect(text).toContain(skill.body.trim());
      expect(fixtureCatalogueText(skill.directory)).toBe(text);
    }
  });

  it('answers 404 for unknown skills, other files, other paths and other hosts', async () => {
    for (const url of [
      raw('template'),
      raw('nope'),
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/other.md',
      'https://raw.githubusercontent.com/anthropics/skills/main/README.md',
      'https://api.github.com/repos/anthropics/skills/contents',
      'https://api.github.com/user',
      'https://api.vercel.com/v2/user',
    ]) {
      expect((await fixtureSkillsFetch(url)).status, url).toBe(404);
    }
    expect(fixtureCatalogueText('nope')).toBeNull();
  });

  it('accepts URL and Request inputs like the real fetch', async () => {
    expect((await fixtureSkillsFetch(new URL(CONTENTS))).status).toBe(200);
    expect((await fixtureSkillsFetch(new Request(raw('pdf')))).status).toBe(200);
  });

  it('drives the real SkillsService end to end without a network: catalogue, preview, install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-skills-fixture-'));
    const svc = new SkillsService({ repos, fetch: fixtureSkillsFetch, home });
    const rows = await svc.catalogue();
    expect(rows.map((r) => r.directory)).toEqual(['pdf', 'xlsx', 'frontend-design']);
    expect(rows.every((r) => r.scope === 'catalogue' && r.host === null)).toBe(true);
    expect((await svc.preview('xlsx')).text).toContain('# xlsx');
    await svc.install({ directory: 'xlsx', scope: 'global', hosts: ['codex'], projectId: null });
    expect(existsSync(join(home, '.codex', 'skills', 'xlsx', 'SKILL.md'))).toBe(true);
    await expect(svc.preview('template')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('fixtureSkillMarkdown', () => {
  it('writes name/description frontmatter and a default body from the description', () => {
    const md = fixtureSkillMarkdown({ name: 'sql-review', description: 'Review a migration.' });
    expect(parseFrontmatter(md)).toEqual({ name: 'sql-review', description: 'Review a migration.' });
    expect(md.endsWith('# sql-review\n\nReview a migration.\n')).toBe(true);
  });
});

describe('fixtureCatalogueFetch', () => {
  it('answers catalogue URLs from the fixture and hands everything else to the real fetch', async () => {
    const real = vi.fn(async () => new Response('real', { status: 200 }));
    const f = fixtureCatalogueFetch(real as unknown as typeof fetch);
    expect(((await (await f(CONTENTS)).json()) as unknown[]).length).toBe(5);
    expect((await f(raw('pdf'))).status).toBe(200);
    expect(real).not.toHaveBeenCalled();
    expect(await (await f('https://api.github.com/user')).text()).toBe('real');
    expect(real).toHaveBeenCalledTimes(1);
  });

  it('isCatalogueUrl covers exactly the two pinned shapes', () => {
    expect(isCatalogueUrl(CONTENTS)).toBe(true);
    expect(isCatalogueUrl(raw('pdf'))).toBe(true);
    expect(isCatalogueUrl('https://api.github.com/repos/anthropics/skills')).toBe(false);
    expect(isCatalogueUrl('https://raw.githubusercontent.com/other/repo/main/skills/pdf/SKILL.md')).toBe(
      false,
    );
  });
});
