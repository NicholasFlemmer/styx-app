import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  DEFAULT_DESIGN_TOKENS,
  DESIGN_DIR,
  copy,
  designScreens,
  designTokensSchema,
  fill,
  parseDesignPath,
  screenName,
  taskOf,
  tokensCss,
  type Agent,
  type DesignFile,
  type DesignList,
  type DesignTokens,
  type Session,
  type SessionId,
} from '@styx/core';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { GitService } from './git';
import { logger } from './logger';
import type { SessionService } from './session-service';

/**
 * The design folder of a worktree, refusing links: the worktree is resolved for real, and neither `.styx` nor
 * `.styx/designs` may be a symlink (an agent could otherwise point the folder anywhere). Null when it is not a place
 * on disk (a fixture's `~/…` display path) or is linked away.
 */
const designDirOf = (worktreePath: string, create: boolean): string | null => {
  if (!isAbsolute(worktreePath) || !existsSync(worktreePath)) return null;
  const root = realpathSync(worktreePath);
  let cur = root;
  for (const part of DESIGN_DIR.split('/')) {
    cur = join(cur, part);
    if (!existsSync(cur) && !isLink(cur)) {
      if (!create) return cur === join(root, DESIGN_DIR) ? cur : null;
      mkdirSync(cur);
    }
    if (isLink(cur) || !lstatSync(cur).isDirectory()) return null;
  }
  return cur;
};

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Every part of `rel` below `dir` exists as itself, never as a link (or does not exist yet). */
const noLinksBelow = (dir: string, rel: string): boolean => {
  let cur = dir;
  for (const part of rel.split('/')) {
    cur = join(cur, part);
    if (isLink(cur)) return false;
  }
  return true;
};

/**
 * Writes a design file without following a link or writing through a hard link: opened `O_NOFOLLOW`, checked to be a
 * plain file with one name, then truncated and written.
 */
const writeOwned = (abs: string, content: string): void => {
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw new Error('not a plain design file');
    ftruncateSync(fd, 0);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
};

const readOwned = (abs: string): string => {
  const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a plain design file');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
};

/** A design's tokens and their CSS, written when a design task starts so screens can link them from the first turn. */
export const ensureDesignTokens = (worktreePath: string): void => {
  try {
    const dir = designDirOf(worktreePath, true);
    if (dir === null) return;
    const json = join(dir, 'tokens.json');
    if (!existsSync(json) && !isLink(json))
      writeOwned(json, `${JSON.stringify(DEFAULT_DESIGN_TOKENS, null, 2)}\n`);
    const css = join(dir, 'tokens.css');
    if (!existsSync(css) && !isLink(css))
      writeOwned(css, tokensCss(readTokens(dir) ?? DEFAULT_DESIGN_TOKENS));
  } catch (e) {
    logger.warn('design: could not seed tokens', { error: (e as Error).message });
  }
};

const readTokens = (dir: string): DesignTokens | null => {
  try {
    const parsed = designTokensSchema.safeParse(JSON.parse(readOwned(join(dir, 'tokens.json'))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Tidies a hand-edited screen: script elements and inline handlers out. Not a security boundary (an agent writes the
 * files directly); no script in a design runs because the canvas draws screens in frames without `allow-scripts`.
 */
export const stripScripts = (html: string): string =>
  html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

export interface DesignDeps {
  repos: Repos;
  git: Pick<GitService, 'commitOwnedPaths' | 'nextAgentBranch'>;
  sessions: Pick<SessionService, 'start' | 'tell' | 'sendMessage'>;
  transcript: { system(sessionId: SessionId, body: string): unknown };
}

/**
 * The Design tab's files (#140): screens under `.styx/designs` in a task's worktree, their tokens, hand edits from the
 * canvas, Build it, and telling a build task when the design it builds changes.
 */
export class DesignService {
  /** What each design task's screens looked like when its build tasks were last told, by path → mtime. */
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(private readonly deps: DesignDeps) {}

  private worktree(worktreeId: string) {
    return this.deps.repos.worktrees.get(worktreeId) ?? fail('not-found', 'worktree not found');
  }

  /** The worktree's design folder for reading; null when there is none (or it is linked away). */
  private dirOf(worktreeId: string, create = false): string | null {
    return designDirOf(this.worktree(worktreeId).path, create);
  }

  /**
   * A screen's absolute path, refused unless it is a screen file inside the design folder reached without a link (the
   * screen's folder and the file itself included).
   */
  private screenPath(worktreeId: string, path: string, create = false): string {
    if (parseDesignPath(path) === null) fail('invalid-input', 'not a design screen');
    const dir = this.dirOf(worktreeId, create) ?? fail('not-found', 'no design here');
    const abs = resolve(dir, path);
    if (!abs.startsWith(dir + sep) || !noLinksBelow(dir, path)) fail('invalid-input', 'outside the design');
    return abs;
  }

  private files(dir: string | null): DesignFile[] {
    if (dir === null || !existsSync(dir)) return [];
    const out: DesignFile[] = [];
    for (const screen of readdirSync(dir, { withFileTypes: true })) {
      if (!screen.isDirectory()) continue;
      for (const f of readdirSync(join(dir, screen.name), { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const path = `${screen.name}/${f.name}`;
        const parsed = parseDesignPath(path);
        if (parsed === null) continue;
        out.push({ path, ...parsed, mtime: statSync(join(dir, path)).mtimeMs });
      }
    }
    return out;
  }

  list(worktreeId: string): DesignList {
    const dir = this.dirOf(worktreeId);
    return {
      worktreeId,
      screens: designScreens(this.files(dir)),
      tokens: dir === null ? null : readTokens(dir),
    };
  }

  read(worktreeId: string, path: string): { html: string; css: string } {
    const abs = this.screenPath(worktreeId, path);
    if (!existsSync(abs)) fail('not-found', 'screen not found');
    // The canvas always gets the tokens as Styx would write them, never a file's own CSS.
    const dir = this.dirOf(worktreeId);
    const css = tokensCss((dir === null ? null : readTokens(dir)) ?? DEFAULT_DESIGN_TOKENS);
    return { html: readOwned(abs), css };
  }

  write(worktreeId: string, path: string, html: string): void {
    const abs = this.screenPath(worktreeId, path);
    writeOwned(abs, stripScripts(html));
    void this.changed(worktreeId, [path]);
  }

  setTokens(worktreeId: string, tokens: DesignTokens): void {
    const dir = this.dirOf(worktreeId, true) ?? fail('invalid-input', 'the design folder is linked away');
    writeOwned(join(dir, 'tokens.json'), `${JSON.stringify(tokens, null, 2)}\n`);
    writeOwned(join(dir, 'tokens.css'), tokensCss(tokens));
    void this.changed(worktreeId, ['tokens.json']);
  }

  /** The design task that owns a worktree, if any. */
  private designTaskOf(worktreeId: string): Session | null {
    return (
      this.deps.repos.sessions
        .all()
        .find((s) => s.worktreeId === worktreeId && s.kind === 'design' && s.archivedAt === null) ?? null
    );
  }

  private buildsOf(designId: string): Session[] {
    return this.deps.repos.sessions
      .all()
      .filter((s) => s.designSessionId === designId && s.state !== 'done' && s.archivedAt === null);
  }

  /** Commits the design folder in the design task's worktree (hooks off), so a build task can merge it. */
  private async commitDesign(worktreeId: string, message: string): Promise<boolean> {
    const wt = this.worktree(worktreeId);
    const project = this.deps.repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    return this.deps.git.commitOwnedPaths(wt.path, project.path, [DESIGN_DIR], message);
  }

  private snapshot(worktreeId: string): Map<string, number> {
    const dir = this.dirOf(worktreeId);
    const m = new Map(this.files(dir).map((f) => [f.path, f.mtime] as const));
    const tokens = dir === null ? null : join(dir, 'tokens.json');
    if (tokens !== null && existsSync(tokens)) m.set('tokens.json', lstatSync(tokens).mtimeMs);
    return m;
  }

  /**
   * After the design changed (a hand edit, Type and colour, or a design turn that wrote screens): commit it in the
   * design task's lane and tell each build task built from it what changed. Quiet when nothing is built from it.
   */
  async changed(worktreeId: string, hint: string[] = []): Promise<void> {
    const design = this.designTaskOf(worktreeId);
    if (design === null) return;
    const builds = this.buildsOf(design.id);
    const now = this.snapshot(worktreeId);
    const before = this.seen.get(design.id);
    this.seen.set(design.id, now);
    if (builds.length === 0) return;
    const paths = new Set(hint);
    if (before !== undefined) for (const [p, m] of now) if (before.get(p) !== m) paths.add(p);
    if (paths.size === 0) return;
    const what = [...paths]
      .map((p) => (p === 'tokens.json' ? copy.chat.design.tokens.title : screenName(p.split('/')[0] ?? p)))
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ');
    const wt = this.worktree(worktreeId);
    try {
      await this.commitDesign(worktreeId, `Design: ${what}`);
    } catch (e) {
      logger.warn('design: commit failed', { error: (e as Error).message });
    }
    for (const b of builds)
      this.deps.sessions.tell(b.id, fill(copy.agentPrompt.designChanged, { branch: wt.branch ?? '', what }));
    this.deps.transcript.system(design.id, fill(copy.chat.design.toldBuild, { n: builds.length, what }));
  }

  /** A design task's turn ended: if it changed screens, its build tasks hear about it. */
  onTurnSettled(sessionId: string): void {
    const s = this.deps.repos.sessions.get(sessionId);
    if (s === null || s.kind !== 'design') return;
    void this.changed(s.worktreeId).catch((e: Error) =>
      logger.warn('design: change check failed', { error: e.message }),
    );
  }

  /** Build it: a new build task branched from the design (linked), or this design task carrying on to build. */
  async handover(input: {
    sessionId: string;
    mode: 'new' | 'here';
    agent: Agent;
    screens: string[];
    tokens: boolean;
    note: string;
  }): Promise<SessionId> {
    const design = this.deps.repos.sessions.get(input.sessionId) ?? fail('not-found', 'task not found');
    const wt = this.worktree(design.worktreeId);
    const names = input.screens.map(screenName).join(', ');
    const message = fill(copy.agentPrompt.handover, {
      screens: names,
      task: taskOf(design) || copy.chat.design.handover.title,
      paths: input.screens.map((x) => `${x}/`).join(', '),
      tokens: input.tokens ? copy.agentPrompt.handoverTokens : '',
      note: input.note.trim() === '' ? '' : fill(copy.agentPrompt.handoverNote, { note: input.note.trim() }),
    });
    if (input.mode === 'here') {
      await this.deps.sessions.sendMessage(design.id, message);
      return design.id;
    }
    if (wt.branch === null) fail('invalid-input', 'the design is not on a branch');
    await this.commitDesign(design.worktreeId, `Design: ${names}`);
    const project = this.deps.repos.projects.get(design.projectId) ?? fail('not-found', 'project not found');
    const name = copy.agentProducts[input.agent].toLowerCase().split(' ')[0] ?? input.agent;
    const prefix = this.deps.repos.projects.settings(project.id).branchPrefix ?? 'agent/';
    const branch = await this.deps.git.nextAgentBranch(project.path, name, prefix);
    const { sessionId } = await this.deps.sessions.start({
      projectId: design.projectId,
      agent: input.agent,
      worktree: { kind: 'new', base: wt.branch, branch },
      firstMessage: message,
      toggles: design.toggles,
      model: null,
      kind: 'build',
      designSessionId: design.id,
    });
    this.seen.set(design.id, this.snapshot(design.worktreeId));
    this.deps.transcript.system(design.id, fill(copy.chat.design.handedOver, { branch }));
    return sessionId;
  }
}
