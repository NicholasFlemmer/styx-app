import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { copy, fill, type SkillHost, type SkillScope, type SkillSummary } from '@styx/core';
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
  /** Overridable so tests and fixtures never touch the real home. */
  home?: string;
  /** `$CODEX_HOME` and friends; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Where each agent CLI reads skills. Every CLI uses the same `SKILL.md` layout but its own roots; `agents` is the
 * shared `.agents/skills` convention that Codex, Gemini CLI and Cursor all read (Styx lists it, never writes it).
 * Global roots are relative to the home dir except Codex, which honours `$CODEX_HOME`.
 */
export const SKILL_HOST_DIRS: Record<SkillHost, { global: string[]; project: string[] }> = {
  claude: { global: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  codex: { global: ['.codex', 'skills'], project: ['.codex', 'skills'] },
  gemini: { global: ['.gemini', 'skills'], project: ['.gemini', 'skills'] },
  cursor: { global: ['.cursor', 'skills'], project: ['.cursor', 'skills'] },
  agents: { global: ['.agents', 'skills'], project: ['.agents', 'skills'] },
};
const HOSTS: readonly SkillHost[] = ['claude', 'codex', 'gemini', 'cursor', 'agents'];
/** Catalogue fetches run this many at a time (one request per skill directory). */
const CATALOGUE_CONCURRENCY = 6;

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

  private globalDir(host: SkillHost): string {
    const home = this.deps.home ?? homedir();
    const env = this.deps.env ?? process.env;
    if (host === 'codex') {
      const codexHome = env['CODEX_HOME'];
      return codexHome !== undefined && codexHome !== '' ? join(codexHome, 'skills') : join(home, ...SKILL_HOST_DIRS.codex.global);
    }
    return join(home, ...SKILL_HOST_DIRS[host].global);
  }

  private projectDir(host: SkillHost, projectId: string): string {
    const project = this.deps.repos.projects.get(projectId) ?? fail('not-found', 'project not found');
    return join(project.path, ...SKILL_HOST_DIRS[host].project);
  }

  private dirFor(host: SkillHost, scope: SkillScope, projectId: string | null): string {
    if (scope === 'global') return this.globalDir(host);
    if (projectId === null) fail('invalid-input', 'a project scope needs a project');
    return this.projectDir(host, projectId);
  }

  /** Every skill any agent CLI would discover for this project: each host's own dirs plus the shared `.agents` ones. */
  async list(projectId: string | null): Promise<SkillSummary[]> {
    const out: SkillSummary[] = [];
    for (const host of HOSTS) {
      out.push(...(await this.scan(this.globalDir(host), 'global', host)));
      if (projectId !== null) out.push(...(await this.scan(this.projectDir(host, projectId), 'project', host)));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.host!.localeCompare(b.host!));
  }

  private async scan(dir: string, scope: SkillScope, host: SkillHost): Promise<SkillSummary[]> {
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
        host,
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
    // One SKILL.md per directory, a few at a time: the catalogue has ~20 entries and serial fetches took seconds.
    const results: (SkillSummary | null)[] = new Array(dirs.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < dirs.length) {
        const i = next++;
        const d = dirs[i]!;
        const md = await this.fetchSkillMd(d.name).catch(() => null);
        if (md === null) continue; // not a skill directory
        const meta = parseFrontmatter(md);
        results[i] = {
          name: meta.name ?? d.name,
          directory: d.name,
          description: meta.description ?? '',
          scope: 'catalogue',
          host: null,
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CATALOGUE_CONCURRENCY, dirs.length) }, worker));
    return results.filter((r): r is SkillSummary => r !== null);
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

  /**
   * Installs one catalogue skill for each chosen agent, into that agent's own skills dir (never the shared
   * `.agents` dir, which belongs to the user). Only SKILL.md is written: a skill's other files are not fetched blind.
   */
  async install(input: {
    directory: string;
    scope: SkillScope;
    hosts: readonly Exclude<SkillHost, 'agents'>[];
    projectId: string | null;
  }): Promise<SkillSummary[]> {
    if (!SAFE_NAME.test(input.directory)) fail('invalid-input', 'bad skill name');
    if (input.scope === 'catalogue') fail('invalid-input', 'catalogue is not an install target');
    if (input.hosts.length === 0) fail('invalid-input', copy.skills.pickHost);
    const text = await this.fetchSkillMd(input.directory);
    const meta = parseFrontmatter(text);
    const out: SkillSummary[] = [];
    for (const host of [...new Set(input.hosts)]) {
      const root = this.dirFor(host, input.scope, input.projectId);
      const dir = join(root, input.directory);
      // Belt and braces over SAFE_NAME: never write outside the skills root.
      if (!dir.startsWith(root + sep)) fail('invalid-input', 'bad skill name');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), text, 'utf8');
      logger.info('skills: installed', { directory: input.directory, scope: input.scope, host });
      out.push({
        name: meta.name ?? input.directory,
        directory: input.directory,
        description: meta.description ?? '',
        scope: input.scope,
        host,
      });
    }
    return out;
  }

  async remove(input: {
    directory: string;
    scope: SkillScope;
    host: SkillHost;
    projectId: string | null;
  }): Promise<void> {
    if (!SAFE_NAME.test(input.directory)) fail('invalid-input', 'bad skill name');
    if (input.scope === 'catalogue') fail('invalid-input', 'nothing to remove from the catalogue');
    const root = this.dirFor(input.host, input.scope, input.projectId);
    const dir = join(root, input.directory);
    if (!dir.startsWith(root + sep)) fail('invalid-input', 'bad skill name');
    await rm(dir, { recursive: true, force: true });
    logger.info('skills: removed', { directory: input.directory, scope: input.scope, host: input.host });
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
