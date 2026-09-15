import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SKILL_HOST_DIRS, SkillsService, parseFrontmatter } from './skills-service';
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
    expect(skills).toEqual([
      { name: 'alpha', directory: 'alpha', description: 'first', scope: 'global', host: 'claude' },
    ]);
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

    const installed = await svc.install({
      directory: 'pdf',
      scope: 'global',
      hosts: ['claude'],
      projectId: null,
    });
    expect(installed).toEqual([
      { name: 'pdf', directory: 'pdf', description: 'fills forms', scope: 'global', host: 'claude' },
    ]);
    const path = join(h, '.claude', 'skills', 'pdf', 'SKILL.md');
    expect(readFileSync(path, 'utf8')).toBe(md);
    expect(await svc.list(null)).toHaveLength(1);

    await svc.remove({ directory: 'pdf', scope: 'global', host: 'claude', projectId: null });
    expect(existsSync(path)).toBe(false);
    expect(await svc.list(null)).toEqual([]);
  });

  it('refuses a directory name that would escape the skills root', async () => {
    const h = home();
    const svc = new SkillsService({ repos, fetch: vi.fn(), home: h });
    for (const bad of ['../evil', '../../etc', 'a/b', '/abs', '.', '..', '']) {
      await expect(
        svc.install({ directory: bad, scope: 'global', hosts: ['claude'], projectId: null }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      await expect(
        svc.remove({ directory: bad, scope: 'global', host: 'claude', projectId: null }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
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
    expect(rows).toEqual([
      { name: 'pdf', directory: 'pdf', description: 'fills forms', scope: 'catalogue', host: null },
    ]);
  });
});

describe('SkillsService across agent CLIs', () => {
  const md = (name: string) => `---\nname: ${name}\ndescription: about ${name}\n---\n# ${name}`;
  const writeAt = (root: string, segments: string[], dir: string, body: string) => {
    mkdirSync(join(root, ...segments, dir), { recursive: true });
    writeFileSync(join(root, ...segments, dir, 'SKILL.md'), body, 'utf8');
  };
  const catalogueFetch = vi.fn(async (url: string) => {
    const m = /\/skills\/([^/]+)\/SKILL\.md$/.exec(url);
    return m?.[1] === undefined
      ? new Response('not found', { status: 404 })
      : new Response(md(m[1]), { status: 200 });
  });

  it('SKILL_HOST_DIRS: every CLI has its own root, the shared `.agents` dir is a fifth', () => {
    expect(Object.keys(SKILL_HOST_DIRS)).toEqual(['claude', 'codex', 'gemini', 'cursor', 'agents']);
    for (const [host, dirs] of Object.entries(SKILL_HOST_DIRS)) {
      expect(dirs.global).toEqual([`.${host}`, 'skills']);
      expect(dirs.project).toEqual([`.${host}`, 'skills']);
    }
  });

  it('Codex honours $CODEX_HOME for its global dir; everyone else is relative to home', async () => {
    const h = home();
    const codexHome = mkdtempSync(join(tmpdir(), 'styx-codex-home-'));
    const svc = new SkillsService({
      repos,
      fetch: catalogueFetch as never,
      home: h,
      env: { CODEX_HOME: codexHome },
    });
    await svc.install({ directory: 'pdf', scope: 'global', hosts: ['codex', 'gemini'], projectId: null });
    expect(existsSync(join(codexHome, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(h, '.codex', 'skills', 'pdf'))).toBe(false);
    expect(existsSync(join(h, '.gemini', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect((await svc.list(null)).map((s) => s.host)).toEqual(['codex', 'gemini']);
    // An empty CODEX_HOME means "unset".
    const plain = new SkillsService({
      repos,
      fetch: catalogueFetch as never,
      home: h,
      env: { CODEX_HOME: '' },
    });
    await plain.install({ directory: 'xlsx', scope: 'global', hosts: ['codex'], projectId: null });
    expect(existsSync(join(h, '.codex', 'skills', 'xlsx', 'SKILL.md'))).toBe(true);
  });

  it('installing for two hosts writes two files and returns one summary per host', async () => {
    const h = home();
    const svc = new SkillsService({ repos, fetch: catalogueFetch as never, home: h });
    const out = await svc.install({
      directory: 'pdf',
      scope: 'global',
      hosts: ['claude', 'cursor', 'claude'],
      projectId: null,
    });
    expect(out).toEqual([
      { name: 'pdf', directory: 'pdf', description: 'about pdf', scope: 'global', host: 'claude' },
      { name: 'pdf', directory: 'pdf', description: 'about pdf', scope: 'global', host: 'cursor' },
    ]);
    expect(readFileSync(join(h, '.claude', 'skills', 'pdf', 'SKILL.md'), 'utf8')).toBe(md('pdf'));
    expect(readFileSync(join(h, '.cursor', 'skills', 'pdf', 'SKILL.md'), 'utf8')).toBe(md('pdf'));
    // One fetch for the text, however many hosts.
    expect(catalogueFetch.mock.calls.filter((c) => c[0].includes('/pdf/'))).toHaveLength(1);
  });

  it('remove takes one host: the other CLI keeps its copy', async () => {
    const h = home();
    const svc = new SkillsService({ repos, fetch: catalogueFetch as never, home: h });
    await svc.install({ directory: 'pdf', scope: 'global', hosts: ['claude', 'codex'], projectId: null });
    await svc.remove({ directory: 'pdf', scope: 'global', host: 'codex', projectId: null });
    expect(existsSync(join(h, '.codex', 'skills', 'pdf'))).toBe(false);
    expect(existsSync(join(h, '.claude', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect(await svc.list(null)).toEqual([
      { name: 'pdf', directory: 'pdf', description: 'about pdf', scope: 'global', host: 'claude' },
    ]);
  });

  it('lists every host dir plus the shared `.agents` dir, for the user and the project, sorted by name then host', async () => {
    const h = home();
    const project = mkdtempSync(join(tmpdir(), 'styx-skills-project-'));
    writeAt(h, ['.claude', 'skills'], 'pdf', md('pdf'));
    writeAt(h, ['.cursor', 'skills'], 'pdf', md('pdf'));
    writeAt(h, ['.agents', 'skills'], 'sql-review', md('sql-review'));
    writeAt(project, ['.codex', 'skills'], 'release-notes', md('release-notes'));
    writeAt(project, ['.agents', 'skills'], 'pdf', md('pdf'));
    const projectRepos = {
      projects: { get: (id: string) => (id === 'p1' ? { path: project } : null) },
    } as unknown as Repos;
    const svc = new SkillsService({ repos: projectRepos, fetch: vi.fn(), home: h });
    const rows = await svc.list('p1');
    expect(rows.map((r) => [r.name, r.scope, r.host])).toEqual([
      ['pdf', 'project', 'agents'],
      ['pdf', 'global', 'claude'],
      ['pdf', 'global', 'cursor'],
      ['release-notes', 'project', 'codex'],
      ['sql-review', 'global', 'agents'],
    ]);
    // Without a project only the user's dirs are scanned.
    expect((await svc.list(null)).map((r) => [r.name, r.host])).toEqual([
      ['pdf', 'claude'],
      ['pdf', 'cursor'],
      ['sql-review', 'agents'],
    ]);
  });

  it('a project-scope install or remove without a project is rejected, and the shared dir is never an install target', async () => {
    const svc = new SkillsService({ repos, fetch: catalogueFetch as never, home: home() });
    await expect(
      svc.install({ directory: 'pdf', scope: 'project', hosts: ['claude'], projectId: null }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      svc.remove({ directory: 'pdf', scope: 'project', host: 'claude', projectId: null }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      svc.install({ directory: 'pdf', scope: 'global', hosts: [], projectId: null }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });
});
