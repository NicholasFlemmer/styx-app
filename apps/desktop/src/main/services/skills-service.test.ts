import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillsService, parseFrontmatter } from './skills-service';
import type { Repos } from '../db/repos';

const home = () => mkdtempSync(join(tmpdir(), 'styx-skills-'));

const writeSkill = (root: string, dir: string, body: string) => {
  mkdirSync(join(root, '.claude', 'skills', dir), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', dir, 'SKILL.md'), body, 'utf8');
};

const repos = { projects: { get: () => null } } as unknown as Repos;

describe('skill frontmatter', () => {
  it('reads a plain scalar', () => {
    expect(parseFrontmatter('---\nname: foo\ndescription: does a thing\n---\nbody')).toEqual({
      name: 'foo',
      description: 'does a thing',
    });
  });

  it('reads a quoted scalar, keeping punctuation that would break a naive split', () => {
    const md = '---\nname: ui-ux\ndescription: "Design: 67 styles, 96 palettes. Use when asked."\n---';
    expect(parseFrontmatter(md).description).toBe('Design: 67 styles, 96 palettes. Use when asked.');
  });

  it('reads a folded block, which real skills on disk actually use', () => {
    const md = [
      '---',
      'name: seo-plan',
      'description: >',
      '  Strategic SEO planning for new or existing websites. Industry-specific',
      '  templates, competitive analysis, content strategy.',
      '---',
      '# body',
    ].join('\n');
    expect(parseFrontmatter(md)).toEqual({
      name: 'seo-plan',
      description:
        'Strategic SEO planning for new or existing websites. Industry-specific templates, competitive analysis, content strategy.',
    });
  });

  it('returns nulls for a file with no frontmatter rather than throwing', () => {
    expect(parseFrontmatter('# just a heading')).toEqual({ name: null, description: null });
  });
});

describe('SkillsService', () => {
  it('lists installed skills, ignoring directories with no SKILL.md', async () => {
    const h = home();
    writeSkill(h, 'alpha', '---\nname: alpha\ndescription: first\n---');
    mkdirSync(join(h, '.claude', 'skills', 'not-a-skill'), { recursive: true });
    const svc = new SkillsService({ repos, fetch: vi.fn(), home: h });
    const skills = await svc.list(null);
    expect(skills).toEqual([{ name: 'alpha', directory: 'alpha', description: 'first', scope: 'global' }]);
  });

  it('an empty skills directory is not an error', async () => {
    const svc = new SkillsService({ repos, fetch: vi.fn(), home: home() });
    await expect(svc.list(null)).resolves.toEqual([]);
  });

  it('installs a catalogue skill by writing its SKILL.md, and removes it again', async () => {
    const h = home();
    const md = '---\nname: pdf\ndescription: fills forms\n---\n# PDF';
    const fetchMock = vi.fn(async () => new Response(md, { status: 200 }));
    const svc = new SkillsService({ repos, fetch: fetchMock as never, home: h });

    const installed = await svc.install({ directory: 'pdf', scope: 'global', projectId: null });
    expect(installed).toMatchObject({ name: 'pdf', directory: 'pdf', scope: 'global' });
    const path = join(h, '.claude', 'skills', 'pdf', 'SKILL.md');
    expect(readFileSync(path, 'utf8')).toBe(md);
    expect(await svc.list(null)).toHaveLength(1);

    await svc.remove({ directory: 'pdf', scope: 'global', projectId: null });
    expect(existsSync(path)).toBe(false);
    expect(await svc.list(null)).toEqual([]);
  });

  it('refuses a directory name that would escape the skills root', async () => {
    const h = home();
    const svc = new SkillsService({ repos, fetch: vi.fn(), home: h });
    for (const bad of ['../evil', '../../etc', 'a/b', '/abs', '.', '..', '']) {
      await expect(
        svc.install({ directory: bad, scope: 'global', projectId: null }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      await expect(svc.remove({ directory: bad, scope: 'global', projectId: null })).rejects.toMatchObject({
        code: 'invalid-input',
      });
    }
  });

  it('preview returns the text so it can be read before installing, and never writes', async () => {
    const h = home();
    const md = '---\nname: pdf\ndescription: fills forms\n---\n# PDF';
    const svc = new SkillsService({
      repos,
      fetch: vi.fn(async () => new Response(md, { status: 200 })) as never,
      home: h,
    });
    expect((await svc.preview('pdf')).text).toBe(md);
    expect(existsSync(join(h, '.claude', 'skills', 'pdf'))).toBe(false);
  });

  it('a catalogue that cannot be reached is an error, never a silent empty list', async () => {
    const svc = new SkillsService({
      repos,
      fetch: vi.fn(async () => new Response('nope', { status: 503 })) as never,
      home: home(),
    });
    await expect(svc.catalogue()).rejects.toMatchObject({ code: 'provider-error' });
  });

  it('lists the catalogue, skipping entries that are not skills', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.github.com'))
        return new Response(
          JSON.stringify([
            { name: 'pdf', type: 'dir' },
            { name: 'docs', type: 'dir' },
            { name: 'README.md', type: 'file' },
          ]),
          { status: 200 },
        );
      if (url.includes('/pdf/'))
        return new Response('---\nname: pdf\ndescription: fills forms\n---', { status: 200 });
      return new Response('not found', { status: 404 }); // docs has no SKILL.md
    });
    const svc = new SkillsService({ repos, fetch: fetchMock as never, home: home() });
    const rows = await svc.catalogue();
    expect(rows).toEqual([{ name: 'pdf', directory: 'pdf', description: 'fills forms', scope: 'catalogue' }]);
  });
});
