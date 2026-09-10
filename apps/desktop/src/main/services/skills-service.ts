import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { copy, fill, type SkillScope, type SkillSummary } from '@styx/core';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import { logger } from './logger';

/**
 * Where the catalogue comes from. Pinned deliberately: an installed skill is instruction text an agent will
 * follow while holding this project's grants, so the source is not user-configurable in this version.
 */
const CATALOGUE_REPO = 'anthropics/skills';
/**
 * The skills live under `skills/`, not at the repo root — the root holds `.claude-plugin`, `spec` and
 * `template`, none of which are installable. Scanning the root found one bogus entry and nothing useful.
 */
const CATALOGUE_PATH = 'skills';
const CATALOGUE_API = `https://api.github.com/repos/${CATALOGUE_REPO}/contents/${CATALOGUE_PATH}`;
const CATALOGUE_RAW = `https://raw.githubusercontent.com/${CATALOGUE_REPO}/main/${CATALOGUE_PATH}`;

/** Directory name rules: a skill directory is created from this, so it must not escape the skills root. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface SkillsServiceDeps {
  repos: Repos;
  fetch: typeof fetch;
  /** Overridable so tests never touch the real ~/.claude. */
  home?: string;
}

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

  private globalDir(): string {
    return join(this.deps.home ?? homedir(), '.claude', 'skills');
  }

  private projectDir(projectId: string): string {
    const project = this.deps.repos.projects.get(projectId) ?? fail('not-found', 'project not found');
    return join(project.path, '.claude', 'skills');
  }

  private dirFor(scope: SkillScope, projectId: string | null): string {
    if (scope === 'global') return this.globalDir();
    if (projectId === null) fail('invalid-input', 'a project scope needs a project');
    return this.projectDir(projectId);
  }

  /** Every skill Claude Code would discover for this project: the user's own, plus the project's committed ones. */
  async list(projectId: string | null): Promise<SkillSummary[]> {
    const out: SkillSummary[] = [];
    out.push(...(await this.scan(this.globalDir(), 'global')));
    if (projectId !== null) out.push(...(await this.scan(this.projectDir(projectId), 'project')));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async scan(dir: string, scope: SkillScope): Promise<SkillSummary[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: SkillSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const text = await readFile(join(dir, e.name, 'SKILL.md'), 'utf8').catch(() => null);
      if (text === null) continue; // a directory without SKILL.md is not a skill
      const meta = parseFrontmatter(text);
      out.push({
        name: meta.name ?? e.name,
        directory: e.name,
        description: meta.description ?? '',
        scope,
      });
    }
    return out;
  }

  /** The pinned catalogue's top-level skill directories. Network failures surface as an error, never as "empty". */
  async catalogue(): Promise<SkillSummary[]> {
    const res = await this.deps
      .fetch(CATALOGUE_API, { headers: { accept: 'application/vnd.github+json' } })
      .catch((e: Error) => fail('provider-error', fill(copy.skills.catalogueFailed, { error: e.message })));
    if (!res.ok) fail('provider-error', fill(copy.skills.catalogueFailed, { error: `HTTP ${res.status}` }));
    const rows = (await res.json()) as { name: string; type: string }[];
    const dirs = rows.filter((r) => r.type === 'dir' && SAFE_NAME.test(r.name));
    const out: SkillSummary[] = [];
    for (const d of dirs) {
      const md = await this.fetchSkillMd(d.name).catch(() => null);
      if (md === null) continue; // not a skill directory
      const meta = parseFrontmatter(md);
      out.push({
        name: meta.name ?? d.name,
        directory: d.name,
        description: meta.description ?? '',
        scope: 'catalogue',
      });
    }
    return out;
  }

  /**
   * The skill's own text, so it can be read before installing. This is the security affordance: a SKILL.md is
   * instructions an agent will follow, so installing one unread is installing unread instructions.
   */
  async preview(directory: string): Promise<{ text: string }> {
    if (!SAFE_NAME.test(directory)) fail('invalid-input', 'bad skill name');
    return { text: await this.fetchSkillMd(directory) };
  }

  private async fetchSkillMd(directory: string): Promise<string> {
    const url = `${CATALOGUE_RAW}/${directory}/SKILL.md`;
    const res = await this.deps
      .fetch(url)
      .catch((e: Error) => fail('provider-error', fill(copy.skills.catalogueFailed, { error: e.message })));
    if (!res.ok) fail('not-found', fill(copy.skills.noSkillMd, { name: directory }));
    return await res.text();
  }

  /** Installs one catalogue skill. Only SKILL.md is written: a skill's other files are not fetched blind. */
  async install(input: {
    directory: string;
    scope: SkillScope;
    projectId: string | null;
  }): Promise<SkillSummary> {
    if (!SAFE_NAME.test(input.directory)) fail('invalid-input', 'bad skill name');
    if (input.scope === 'catalogue') fail('invalid-input', 'catalogue is not an install target');
    const text = await this.fetchSkillMd(input.directory);
    const meta = parseFrontmatter(text);
    const root = this.dirFor(input.scope, input.projectId);
    const dir = join(root, input.directory);
    // Belt and braces over SAFE_NAME: never write outside the skills root.
    if (!dir.startsWith(root + sep)) fail('invalid-input', 'bad skill name');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), text, 'utf8');
    logger.info('skills: installed', { directory: input.directory, scope: input.scope });
    return {
      name: meta.name ?? input.directory,
      directory: input.directory,
      description: meta.description ?? '',
      scope: input.scope,
    };
  }

  async remove(input: { directory: string; scope: SkillScope; projectId: string | null }): Promise<void> {
    if (!SAFE_NAME.test(input.directory)) fail('invalid-input', 'bad skill name');
    if (input.scope === 'catalogue') fail('invalid-input', 'nothing to remove from the catalogue');
    const root = this.dirFor(input.scope, input.projectId);
    const dir = join(root, input.directory);
    if (!dir.startsWith(root + sep)) fail('invalid-input', 'bad skill name');
    await rm(dir, { recursive: true, force: true });
    logger.info('skills: removed', { directory: input.directory, scope: input.scope });
  }
}

/**
 * The YAML frontmatter Claude Code reads: `name` and `description`. Written by hand rather than pulling a YAML
 * dependency for two keys, but it must handle what real skills actually use — quoted scalars and folded blocks
 * (`description: >` with an indented body), both of which appear in the wild.
 */
export const parseFrontmatter = (text: string): { name: string | null; description: string | null } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (m === null) return { name: null, description: null };
  const lines = (m[1] ?? '').split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = (kv[1] ?? '').toLowerCase();
    let value = (kv[2] ?? '').trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      // Folded / literal block: take the indented lines that follow.
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        body.push(next.trim());
        i = j;
      }
      value = body.join(' ').trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return { name: out['name'] ?? null, description: out['description'] ?? null };
};
