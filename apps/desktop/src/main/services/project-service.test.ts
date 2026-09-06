import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures, type ProjectFileV1 } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../test-support';
import type { RecentFolder } from './ide-import-service';
import {
  HOME_DEPTH,
  HOME_SKIP_DIRS,
  ProjectService,
  ROOT_DEPTH,
  STALE_MS,
  advisoryRules,
  byLastActivity,
  isSuggested,
  mergeCandidates,
  policyDiff,
  policyHashOf,
  policySummaryOf,
  projectFileRules,
  scanRoots,
  walkForRepos,
} from './project-service';

const { ids } = fixtures;
const NOW = fixtures.DEMO_NOW;
const DAY = 24 * 3_600_000;

describe('project.scan merge + suggestion logic', () => {
  it.each([
    ['remote + fresh', 'git@github.com:a/b.git', NOW - DAY, true],
    ['remote + stale', 'git@github.com:a/b.git', NOW - STALE_MS - DAY, true],
    ['no remote + fresh', null, NOW - 30 * DAY, true],
    ['no remote + stale (> 1 year)', null, NOW - STALE_MS - DAY, false],
    ['no remote + unknown mtime', null, null, false],
    ['no remote + exactly a year', null, NOW - STALE_MS, true],
  ])('%s → suggested=%s', (_label, remote, mtime, expected) => {
    expect(isSuggested(remote, mtime, NOW)).toBe(expected);
  });

  it('merges filesystem hits with IDE recents; scan wins on overlap, known projects drop, sorted by path', () => {
    const known = new Set(['/h/code/known']);
    expect(
      mergeCandidates(
        ['/h/code/zeta', '/h/code/alpha', '/h/code/known'],
        ['/h/work/ide-only', '/h/code/alpha', '/h/code/known'],
        known,
      ),
    ).toEqual([
      { path: '/h/code/alpha', source: 'scan' },
      { path: '/h/code/zeta', source: 'scan' },
      { path: '/h/work/ide-only', source: 'ide-recent' },
    ]);
    expect(mergeCandidates([], [], known)).toEqual([]);
  });
});

/** `home/<rel>` as a repo: a `.git` dir, or a `.git` file for worktrees. */
const repoAt = (home: string, rel: string, worktree = false): string => {
  const dir = join(home, ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  if (worktree) writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  else mkdirSync(join(dir, '.git'));
  return dir;
};

describe('walkForRepos (project.scan roots, skips, budget)', () => {
  it('finds repos under the code roots (depth 3), $HOME (depth 2) and the extra roots; skips system dirs, dot-dirs, node_modules, nested repos', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const found = [
      repoAt(home, 'code/alpha'),
      repoAt(home, 'code/org/team/beta'), // depth 3 under ~/code
      repoAt(home, 'AmrodOrders'), // directly under $HOME
      repoAt(home, 'clients/c21'), // depth 2 under $HOME
      repoAt(home, 'Desktop/scratch/gmaps-scraper'),
      repoAt(home, 'Documents/a/b/deep'), // depth 3 under ~/Documents
      repoAt(home, 'Downloads/wt', true), // worktree: `.git` is a file
    ];
    const hidden = [
      repoAt(home, 'code/alpha/vendor-sub'), // inside a repo: never descended into
      repoAt(home, 'too/deep/for/home'), // depth 4 under $HOME, not under a root
      repoAt(home, 'Documents/a/b/c/toodeep'), // depth 4 under ~/Documents
      repoAt(home, 'Library/Caches/lib-repo'),
      repoAt(home, 'Applications/app-repo'),
      repoAt(home, '.Trash/gone'),
      repoAt(home, '.config/dotrepo'),
      repoAt(home, 'node_modules/dep'),
      repoAt(home, 'Desktop/node_modules/dep2'),
      repoAt(home, 'Music/mix'),
    ];
    const r = await walkForRepos(scanRoots(home, 'darwin'));
    expect(r.truncated).toBe(false);
    expect([...r.repos].sort()).toEqual([...found].sort());
    for (const h of hidden) expect(r.repos).not.toContain(h);
    // The extra roots are walked at ROOT_DEPTH and `$HOME` last at HOME_DEPTH with its skip list.
    const roots = scanRoots(home, 'darwin');
    expect(roots.at(-1)).toEqual({ path: home, depth: HOME_DEPTH, skip: HOME_SKIP_DIRS });
    expect(roots.find((x) => x.path === join(home, 'Desktop'))?.depth).toBe(ROOT_DEPTH);
    expect(roots.some((x) => x.path === 'C:\\dev')).toBe(false);
    expect(scanRoots(home, 'win32').some((x) => x.path === 'C:\\dev')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('missing roots are skipped, symlinked dirs are not followed, and each root is walked once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const a = repoAt(home, 'code/a');
    const { symlinkSync } = await import('node:fs');
    mkdirSync(join(home, 'Desktop'));
    symlinkSync(join(home, 'code'), join(home, 'Desktop', 'code-link'));
    const r = await walkForRepos([
      { path: join(home, 'nope'), depth: 3 },
      { path: join(home, 'code'), depth: 3 },
      { path: home, depth: 2 },
    ]);
    expect(r.repos).toEqual([a]);
    // home, code, a (repo, counted), Desktop — the symlink is skipped and ~/code is not re-walked from $HOME.
    expect(r.visited).toBe(4);
    rmSync(home, { recursive: true, force: true });
  });

  it('stops at the directory budget and at the time budget, reporting truncation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    for (let i = 0; i < 6; i++) repoAt(home, `code/r${i}`);
    const byDirs = await walkForRepos([{ path: join(home, 'code'), depth: 3 }], { maxDirs: 3 });
    expect(byDirs.truncated).toBe(true);
    expect(byDirs.visited).toBe(3);
    expect(byDirs.repos.length).toBe(2);
    let tick = 0;
    const byTime = await walkForRepos(
      [{ path: join(home, 'code'), depth: 3 }],
      { maxMs: 5 },
      () => (tick += 4),
    );
    expect(byTime.truncated).toBe(true);
    expect(byTime.repos.length).toBeLessThan(6);
    const full = await walkForRepos([{ path: join(home, 'code'), depth: 3 }]);
    expect(full.truncated).toBe(false);
    expect(full.repos.length).toBe(6);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('ProjectService.scan / clone', () => {
  const service = (t: ReturnType<typeof makeTestApp>, home: string, ideRecents: RecentFolder[] = []) =>
    new ProjectService({
      repos: t.app.repos,
      publisher: t.app.publisher,
      clock: t.clock,
      git: t.app.git,
      platform: 'darwin',
      home,
      templatesDir: null,
      ideRecents: async () => ideRecents,
    });

  it('scan merges IDE recents without ide.import, drops known projects, sorts by last activity desc', async () => {
    const t = makeTestApp({ fixture: 'empty' });
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const older = repoAt(home, 'code/older');
    const newer = repoAt(home, 'STYX');
    const recent = repoAt(home, 'elsewhere/from-ide'); // only reachable through IDE recents (depth 2 → it is, so use depth 3)
    const ideOnly = repoAt(home, 'x/y/z/ide-only');
    const known = repoAt(home, 'code/known');
    utimesSync(join(older, '.git'), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    utimesSync(join(newer, '.git'), new Date(NOW - DAY), new Date(NOW - DAY));
    utimesSync(join(recent, '.git'), new Date(NOW - 3 * DAY), new Date(NOW - 3 * DAY));
    utimesSync(join(ideOnly, '.git'), new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));
    utimesSync(join(known, '.git'), new Date(NOW), new Date(NOW));
    t.app.repos.projects.upsert({
      ...fixtures.demoFixture().projects[0]!,
      id: 'known' as never,
      path: known,
    });
    // A folder the IDE opened (no `.git`) is listed as-is with `hasGit: false`, dated by when it was opened; a path
    // that does not exist is dropped.
    const plain = join(home, 'notes');
    mkdirSync(plain);
    const svc = service(t, home, [
      { path: ideOnly, openedAt: null },
      { path: plain, openedAt: NOW - 5 * DAY },
      { path: join(home, 'gone'), openedAt: NOW },
    ]);
    const rows = await svc.scan(true);
    expect(rows.map((r) => [r.path, r.source, r.hasGit])).toEqual([
      [newer, 'scan', true],
      [ideOnly, 'ide-recent', true],
      [recent, 'scan', true],
      [plain, 'ide-recent', false],
      [older, 'scan', true],
    ]);
    expect(rows.find((r) => r.path === plain)).toMatchObject({
      remote: null,
      branch: null,
      lastModifiedAt: NOW - 5 * DAY,
      suggested: true,
    });
    expect((await svc.scan(false)).map((r) => r.path)).toEqual([newer, recent, older]);
    expect(
      [
        { path: 'b', lastModifiedAt: null },
        { path: 'a', lastModifiedAt: 1 },
        { path: 'c', lastModifiedAt: 2 },
        { path: 'a2', lastModifiedAt: null },
      ]
        .map((x) => ({
          ...x,
          remote: null,
          branch: null,
          hasGit: true,
          source: 'scan' as const,
          suggested: true,
        }))
        .sort(byLastActivity)
        .map((x) => x.path),
    ).toEqual(['c', 'a', 'a2', 'b']);
    rmSync(home, { recursive: true, force: true });
  });

  it('clone reports cloning → done with the project id, adds the project, and refuses a non-empty destination', async () => {
    const t = makeTestApp({ fixture: 'empty' });
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const src = join(home, 'src-repo');
    mkdirSync(src);
    await t.app.git.init(src);
    writeFileSync(join(src, 'README.md'), '# hi\n');
    await t.app.git.add(src, ['README.md']);
    await t.app.git.commit(src, 'init');
    const svc = service(t, home);
    const project = await svc.clone(src, '~/code/cloned');
    expect(project.path).toBe(join(home, 'code', 'cloned'));
    expect(t.app.repos.projects.byPath(project.path)?.id).toBe(project.id);
    t.app.publisher.flush();
    expect(t.win.events('project.cloneProgress')).toEqual([
      { url: src, dest: project.path, phase: 'cloning', message: null, projectId: null },
      { url: src, dest: project.path, phase: 'done', message: null, projectId: project.id },
    ]);
    await expect(svc.clone(src, join(home, 'code', 'cloned'))).rejects.toThrow(/already exists/);
    await expect(svc.clone(join(home, 'missing-src'), join(home, 'code', 'other'))).rejects.toThrow();
    t.app.publisher.flush();
    const phases = t.win.events('project.cloneProgress').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['cloning', 'done', 'cloning', 'error', 'cloning', 'error']);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('plain folders: add without git, gitInit upgrades', () => {
  const service = (t: ReturnType<typeof makeTestApp>, home: string) =>
    new ProjectService({
      repos: t.app.repos,
      publisher: t.app.publisher,
      clock: t.clock,
      git: t.app.git,
      platform: 'darwin',
      home,
      templatesDir: null,
      activity: t.app.activity,
    });

  it('add accepts any directory: a folder without .git gets a repo row with defaultBranch null and one main worktree on no branch', async () => {
    const t = makeTestApp({ fixture: 'empty' });
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const folder = join(home, 'notes');
    mkdirSync(folder);
    writeFileSync(join(folder, 'todo.md'), '- ship\n');
    const svc = service(t, home);
    const project = await svc.add(folder);
    expect(project).toMatchObject({ name: 'notes', path: folder, hasProjectFile: false });
    const repo = t.app.repos.repos.byProject(project.id);
    expect(repo).toMatchObject({ defaultBranch: null, remotes: [], ahead: 0, behind: 0 });
    const main = t.app.repos.worktrees.mainOf(project.id);
    expect(main).toMatchObject({
      branch: null,
      path: folder,
      isMain: true,
      owner: { kind: 'user' },
      baseCommit: null,
      headCommit: null,
    });
    expect(t.app.repos.worktrees.byProject(project.id)).toHaveLength(1);
    // Adding the same folder again returns the existing project; a file is refused, a missing path is not found.
    expect((await svc.add(folder)).id).toBe(project.id);
    await expect(svc.add(join(folder, 'todo.md'))).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('is not a directory'),
    });
    await expect(svc.add(join(home, 'nope'))).rejects.toMatchObject({ code: 'not-found' });
    rmSync(home, { recursive: true, force: true });
  });

  it('gitInit runs git init -b main + an empty commit and reconciles the repo row and main worktree onto main', async () => {
    const t = makeTestApp({ fixture: 'empty' });
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const folder = join(home, 'notes');
    mkdirSync(folder);
    writeFileSync(join(folder, 'todo.md'), '- ship\n');
    const svc = service(t, home);
    const project = await svc.add(folder);
    await svc.gitInit(project.id);
    expect(await t.app.git.isRepo(folder)).toBe(true);
    expect(await t.app.git.currentBranch(folder)).toBe('main');
    const head = await t.app.git.headCommit(folder);
    expect(head).not.toBeNull();
    expect(await t.app.git.untrackedFiles(folder)).toEqual(['todo.md']); // nothing in the folder was committed
    expect(t.app.repos.repos.byProject(project.id)).toMatchObject({ defaultBranch: 'main', remotes: [] });
    expect(t.app.repos.worktrees.mainOf(project.id)).toMatchObject({
      branch: 'main',
      path: folder,
      baseCommit: head,
      headCommit: head,
    });
    expect(t.app.repos.activity.recent(5).map((a) => a.what)).toContain('notes · git initialised on main');
    // Idempotent on a git repo: no new commit, rows unchanged.
    await svc.gitInit(project.id);
    expect(await t.app.git.headCommit(folder)).toBe(head);
    rmSync(home, { recursive: true, force: true });
  });

  it('describeRepos does not throw on non-git folders and marks them hasGit: false', async () => {
    const t = makeTestApp({ fixture: 'empty' });
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const plain = join(home, 'plain');
    mkdirSync(plain);
    const repo = repoAt(home, 'code/repo');
    const svc = service(t, home);
    const rows = await svc.describeRepos([
      { path: plain, source: 'ide-recent', openedAt: NOW - STALE_MS - DAY },
      { path: repo, source: 'scan' },
    ]);
    expect(rows.map((r) => [r.path, r.hasGit, r.suggested])).toEqual([
      [plain, false, false], // opened over a year ago → unchecked by default
      [repo, true, true], // no remote, but the `.git` entry is fresh (unreadable repo: still listed)
    ]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('project file policies.extra → projectRules', () => {
  const file: ProjectFileV1 = {
    version: 1,
    name: 'acme-shop',
    policies: {
      extra: [
        {
          id: 'sb-read',
          rule: {
            kind: 'auto-approve',
            match: { provider: ['supabase'] },
            scopes: ['read'],
            duration: 'session',
          },
          ruleText: 'Auto-approve Supabase reads',
        },
        {
          id: 'off',
          rule: { kind: 'ask', match: {}, scopes: ['delete'], requireMfa: true },
          ruleText: 'Always ask for deletes',
          enabled: false,
        },
      ],
    },
  };

  it('maps file rules to engine policies in file order with namespaced ids', () => {
    const rules = projectFileRules(file, NOW);
    expect(rules.map((r) => [r.id, r.ord, r.enabled, r.builtinKey])).toEqual([
      ['project:sb-read', 1, true, null],
      ['project:off', 2, false, null],
    ]);
    expect(projectFileRules({ version: 1, name: 'x' }, NOW)).toEqual([]);
  });

  it('an extra auto-approve rule in .styx/project.json auto-approves a matching request', async () => {
    const t = makeTestApp();
    const dir = mkdtempSync(join(tmpdir(), 'styx-pf-'));
    mkdirSync(join(dir, '.styx'));
    writeFileSync(join(dir, '.styx', 'project.json'), JSON.stringify(file));
    const project = t.app.repos.projects.get(ids.project.acmeShop);
    if (!project) throw new Error('fixture project');
    t.app.repos.projects.upsert({ ...project, path: dir });
    // Not yet accepted on this machine: the auto-approve rule reads as `ask` (H-1), same ids.
    expect(t.app.projects.projectRules(project.id).map((r) => [r.id, r.rule.kind])).toEqual([
      ['project:sb-read', 'ask'],
      ['project:off', 'ask'],
    ]);
    expect(t.app.projects.projectRules(project.id)).toBe(t.app.projects.projectRules(project.id)); // mtime cache
    await t.app.projects.acceptPolicies(project.id, (await t.app.projects.pendingPolicy(project.id)).hash);
    expect(t.app.projects.projectRules(project.id).map((r) => [r.id, r.rule.kind])).toEqual([
      ['project:sb-read', 'auto-approve'],
      ['project:off', 'ask'],
    ]);
    expect(t.app.projects.projectRules(project.id)).toBe(t.app.projects.projectRules(project.id)); // mtime cache

    const target = t.app.repos.targets.get(ids.target.supabaseProd);
    if (!target?.credentialRef) throw new Error('fixture target');
    // Supabase hands the agent the whole token, so on *prod* an auto rule still asks (+MFA); staging auto-issues.
    t.app.repos.targets.upsert({ ...target, env: 'staging' });
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
    const out = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['read'],
      reason: 'inspect schema',
      triggeredBy: 'mcp:request_access',
    });
    expect(out.kind).toBe('active');
    if (out.kind !== 'active') return;
    expect(out.decidedBy).toBe('policy');
    expect(out.grant.policyId).toBeNull(); // project rules are not `policies` rows; the audit cites the rule instead
    const requested = t.app.repos.audit
      .all()
      .find((e) => e.action === 'requested' && e.grantId === out.grant.id);
    expect(requested?.detail).toMatchObject({ projectRule: 'project:sb-read' });

    // A write on prod still forces MFA → ask, even with the file rule present.
    const write = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['write'],
      reason: 'migration',
      triggeredBy: 'mcp:request_access',
    });
    expect(write.kind).toBe('pending');
  });

  it('advisoryRules downgrades auto-approve to ask (same id), drops idle-expiry and keeps ask rules', () => {
    const rules = projectFileRules(
      {
        version: 1,
        name: 'x',
        policies: {
          extra: [
            {
              id: 'a',
              rule: { kind: 'auto-approve', match: { env: ['prod'] }, scopes: ['write'], duration: 'always' },
              ruleText: 'a',
            },
            { id: 'i', rule: { kind: 'idle-expiry', match: {}, idleMs: 24 * 3_600_000 }, ruleText: 'i' },
            {
              id: 'k',
              rule: { kind: 'ask', match: {}, scopes: ['delete'], requireMfa: true },
              ruleText: 'k',
            },
          ],
        },
      },
      NOW,
    );
    expect(advisoryRules(rules).map((r) => [r.id, r.rule])).toEqual([
      ['project:a', { kind: 'ask', match: { env: ['prod'] }, scopes: ['write'], requireMfa: false }],
      ['project:k', { kind: 'ask', match: {}, scopes: ['delete'], requireMfa: true }],
    ]);
  });

  it('policy summary / hash / diff cover policies.extra and targets[].policy only', () => {
    const base: ProjectFileV1 = {
      version: 1,
      name: 'x',
      targets: [
        { name: 'GitHub', provider: 'github', env: 'scm', authMethod: 'oauth', policy: 'always' },
        { name: 'Vercel', provider: 'vercel', env: 'prod', authMethod: 'oauth' },
      ],
      policies: {
        extra: [
          {
            id: 'r1',
            rule: { kind: 'ask', match: {}, scopes: ['delete'], requireMfa: true },
            ruleText: 'r1',
          },
        ],
      },
    };
    const s1 = policySummaryOf(base);
    expect(s1).toEqual({
      rules: [
        { id: 'r1', rule: { kind: 'ask', match: {}, scopes: ['delete'], requireMfa: true }, ruleText: 'r1' },
      ],
      targets: [
        { key: 'github/scm/GitHub', policy: 'always', config: {} },
        { key: 'vercel/prod/Vercel', policy: null, config: {} },
      ],
    });
    // Unrelated edits (settings, config) leave the hash alone; a policy edit changes it.
    expect(
      policyHashOf(
        policySummaryOf({ ...base, agents: { autoApproveEdits: true }, worktrees: { baseBranch: 'dev' } }),
      ),
    ).toBe(policyHashOf(s1));
    const next: ProjectFileV1 = {
      ...base,
      targets: [
        { name: 'GitHub', provider: 'github', env: 'scm', authMethod: 'oauth' },
        {
          name: 'Vercel',
          provider: 'vercel',
          env: 'prod',
          authMethod: 'oauth',
          policy: 'always',
          config: { teamSlug: 'evil' },
        },
      ],
      policies: {
        extra: [
          {
            id: 'r1',
            rule: { kind: 'ask', match: {}, scopes: ['delete'], requireMfa: false },
            ruleText: 'r1',
          },
          {
            id: 'r2',
            rule: { kind: 'auto-approve', match: {}, scopes: ['read'], duration: '1h' },
            ruleText: 'r2',
          },
        ],
      },
    };
    const s2 = policySummaryOf(next);
    expect(policyHashOf(s2)).not.toBe(policyHashOf(s1));
    expect(policyDiff(s1, s2)).toEqual({
      rules: { added: ['r2'], removed: [], changed: ['r1'] },
      targets: [
        { target: 'github/scm/GitHub', from: 'always', to: null },
        { target: 'vercel/prod/Vercel', from: null, to: 'always' },
      ],
      configChanged: ['vercel/prod/Vercel'],
    });
    expect(policyDiff(null, s1)).toEqual({
      rules: { added: ['r1'], removed: [], changed: [] },
      targets: [{ target: 'github/scm/GitHub', from: null, to: 'always' }],
      configChanged: [],
    });
    // Config alone (no policies) still gates: it steers where a connected credential points.
    expect(
      policyHashOf(
        policySummaryOf({
          ...base,
          policies: undefined,
          targets: [
            { name: 'V', provider: 'vercel', env: 'prod', authMethod: 'oauth', config: { project: 'a' } },
          ],
        }),
      ),
    ).not.toBe(
      policyHashOf(
        policySummaryOf({
          ...base,
          policies: undefined,
          targets: [
            { name: 'V', provider: 'vercel', env: 'prod', authMethod: 'oauth', config: { project: 'b' } },
          ],
        }),
      ),
    );
  });

  it('returns no rules when the project has no file', () => {
    const t = makeTestApp();
    expect(t.app.projects.projectRules(ids.project.blogV2)).toEqual([]);
    expect(t.app.projects.projectRules('nope')).toEqual([]);
  });
});

describe('project.create with createGithubRepo', () => {
  it('creates the repo through the GitHub target, adds origin, pushes, and audits `connected`', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const bare = mkdtempSync(join(tmpdir(), 'styx-bare-'));
    const fetchFake: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url === 'https://api.github.com/user') return Response.json({ login: 'me' });
      if (url === 'https://api.github.com/orgs/acme/repos')
        return Response.json(
          {
            full_name: 'acme/new-thing',
            clone_url: bare,
            html_url: 'https://github.com/acme/new-thing',
            default_branch: 'main',
          },
          { status: 201 },
        );
      return new Response('nope', { status: 404 });
    };
    const t = makeTestApp({ fetch: fetchFake });
    await t.app.git.init(bare);
    await t.app.git['git'].run(['config', 'receive.denyCurrentBranch', 'ignore'], bare);
    const gh = t.app.repos.targets.get(ids.target.github);
    if (!gh?.credentialRef) throw new Error('fixture github target');
    t.app.repos.targets.upsert({ ...gh, config: { ...gh.config, owner: 'acme' } });
    await t.vault.set(gh.credentialRef, JSON.stringify({ token: 'gh_test' }));

    const location = mkdtempSync(join(tmpdir(), 'styx-new-'));
    const project = await t.app.projects.create({
      name: 'new-thing',
      location,
      gitInit: true,
      template: null,
      copyTargetsFrom: null,
      createGithubRepo: true,
    });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'https://api.github.com/user'],
      ['POST', 'https://api.github.com/orgs/acme/repos'],
    ]);
    expect(calls[1]?.body).toEqual({ name: 'new-thing', private: true, auto_init: false });
    const remotes = await t.app.git.remotes(project.path);
    expect(remotes.map((r) => [r.name, r.url])).toEqual([['origin', bare]]);
    expect(await t.app.git.headCommit(bare)).toBe(await t.app.git.headCommit(project.path)); // initial push landed
    expect(t.app.repos.repos.byProject(project.id)?.remotes).toEqual([{ name: 'origin', url: bare }]);
    const entry = t.app.repos.audit.all().find((e) => e.action === 'connected' && e.projectId === project.id);
    expect(entry?.detail).toMatchObject({ repo: 'acme/new-thing' });
    expect(entry?.targetId).toBe(gh.id);
  });

  it('fails with provider-error when no GitHub target is connected', async () => {
    const t = makeTestApp({ fixture: 'empty' });
    const location = mkdtempSync(join(tmpdir(), 'styx-new-'));
    await expect(
      t.app.projects.create({
        name: 'lonely',
        location,
        gitInit: true,
        template: null,
        copyTargetsFrom: null,
        createGithubRepo: true,
      }),
    ).rejects.toMatchObject({ code: 'provider-error' });
  });

  it('project.templates lists built-ins plus styx-template repos in the target org', async () => {
    const fetchFake: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/search/repositories?q=topic%3Astyx-template%20org%3Aacme'))
        return Response.json({ items: [{ name: 'svc-template', full_name: 'acme/svc-template' }] });
      return new Response('nope', { status: 404 });
    };
    const t = makeTestApp({ fetch: fetchFake });
    const gh = t.app.repos.targets.get(ids.target.github);
    if (!gh?.credentialRef) throw new Error('fixture github target');
    t.app.repos.targets.upsert({ ...gh, config: { ...gh.config, owner: 'acme' } });
    await t.vault.set(gh.credentialRef, JSON.stringify({ token: 'gh_test' }));
    const r = await t.app.bus.dispatch(t.sender, 'project.templates', {});
    expect(r).toEqual({
      ok: true,
      value: {
        builtins: ['node', 'python', 'go', 'rust', 'static'],
        org: [{ name: 'svc-template', fullName: 'acme/svc-template' }],
      },
    });
    const none = makeTestApp({ fixture: 'empty' });
    expect(await none.app.bus.dispatch(none.sender, 'project.templates', {})).toMatchObject({
      ok: true,
      value: { org: [] },
    });
  });
});

describe('project file trust gate (H-1): reconcile, banner, accept, audit', () => {
  const fileWith = (policy: 'always' | 'ask' | 'ask-mfa'): ProjectFileV1 => ({
    version: 1,
    name: 'acme-shop',
    targets: [{ name: 'Vercel', provider: 'vercel', env: 'preview', authMethod: 'oauth', policy }],
  });

  it('reconcile does not copy targets[].policy until accepted; the banner is raised, then cleared and audited on accept', async () => {
    const t = makeTestApp();
    const dir = mkdtempSync(join(tmpdir(), 'styx-h1-'));
    mkdirSync(join(dir, '.styx'));
    writeFileSync(join(dir, '.styx', 'project.json'), JSON.stringify(fileWith('always')));
    const project = t.app.repos.projects.get(ids.project.acmeShop)!;
    t.app.repos.projects.upsert({ ...project, path: dir });
    const preview = t.app.repos.targets.get(ids.target.vercelPreview)!;
    t.app.repos.targets.upsert({ ...preview, policy: 'ask', policySource: 'app' });

    expect(await t.app.projects.reconcileProjectFile(project.id)).toEqual({ ok: true, error: null });
    expect(t.app.repos.targets.get(ids.target.vercelPreview)).toMatchObject({
      policy: 'ask',
      policySource: 'app',
      fromProjectFile: true,
    });
    const key = `project-policy:${project.id}`;
    expect(t.app.repos.notifications.byBannerKey(key)).toMatchObject({
      kind: 'info',
      state: 'shown',
      projectId: project.id,
    });
    const pending = await t.app.projects.pendingPolicy(project.id);
    expect(pending).toMatchObject({
      accepted: false,
      summary: { targets: [{ key: 'vercel/preview/Vercel', policy: 'always' }] },
    });
    expect(pending.diff).toEqual({
      rules: { added: [], removed: [], changed: [] },
      targets: [{ target: 'vercel/preview/Vercel', from: null, to: 'always' }],
      configChanged: [],
    });
    expect(t.win.events('banner.set')).toContainEqual({
      bannerKey: key,
      kind: 'project-policy',
      text: "acme-shop's .styx/project.json wants to change grant policies. Review in Settings.",
      cta: 'Review',
      action: { kind: 'review-project-policy', projectId: project.id, hash: pending.hash },
      sessionId: null,
      reason: null,
    });
    expect(t.app.repos.notifications.byBannerKey(key)?.meta).toBe(pending.hash);
    // The accept token must match what is on disk now (TOCTOU: a pull between review and click is not accepted unseen).
    await expect(t.app.projects.acceptPolicies(project.id, 'a'.repeat(64))).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(t.app.repos.targets.get(ids.target.vercelPreview)).toMatchObject({
      policy: 'ask',
      policySource: 'app',
    });
    // A restart re-emits the shown banner with the snapshot.
    const snap = await t.app.bus.dispatch(t.sender, 'store.snapshot', {});
    expect(snap.ok).toBe(true);
    expect(
      t.win.events('banner.set').filter((e) => (e as { bannerKey: string }).bannerKey === key).length,
    ).toBe(2);

    const auditBefore = t.app.repos.audit.all().length;
    await t.app.projects.acceptPolicies(project.id, pending.hash);
    expect(t.app.repos.targets.get(ids.target.vercelPreview)).toMatchObject({
      policy: 'always',
      policySource: 'project',
    });
    expect(t.app.repos.notifications.byBannerKey(key)).toMatchObject({ state: 'resolved' });
    expect(t.win.events('banner.clear')).toContainEqual({ bannerKey: key });
    const rows = t.app.repos.audit.all().slice(auditBefore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'policy-changed',
      actorKind: 'you',
      projectId: project.id,
      triggeredBy: 'settings',
      detail: {
        file: '.styx/project.json',
        hash: pending.hash,
        rules: { added: [], removed: [], changed: [] },
        targets: [{ target: 'vercel/preview/Vercel', from: null, to: 'always' }],
        configChanged: [],
      },
    });
    expect(t.app.audit.verifyChain()).toMatchObject({ ok: true });

    // The file changes the policy again → untrusted again: the row keeps the accepted value, the banner returns.
    writeFileSync(join(dir, '.styx', 'project.json'), JSON.stringify(fileWith('ask-mfa')));
    await t.app.projects.reconcileProjectFile(project.id);
    expect(t.app.repos.targets.get(ids.target.vercelPreview)).toMatchObject({
      policy: 'always',
      policySource: 'project',
    });
    expect(t.app.repos.notifications.byBannerKey(key)).toMatchObject({ state: 'shown' });
    expect((await t.app.projects.pendingPolicy(project.id)).accepted).toBe(false);
    await t.app.projects.acceptPolicies(project.id, (await t.app.projects.pendingPolicy(project.id)).hash);
    expect((await t.app.projects.pendingPolicy(project.id)).accepted).toBe(true);
    expect(t.app.repos.targets.get(ids.target.vercelPreview)).toMatchObject({
      policy: 'ask-mfa',
      policySource: 'project',
    });
    const last = t.app.repos.audit.all().at(-1);
    expect(last?.detail).toMatchObject({
      targets: [{ target: 'vercel/preview/Vercel', from: 'always', to: 'ask-mfa' }],
    });

    // Removing the file clears the banner; a file without policy content never prompts.
    writeFileSync(
      join(dir, '.styx', 'project.json'),
      JSON.stringify({ version: 1, name: 'acme-shop', agents: { default: 'codex' } }),
    );
    await t.app.projects.reconcileProjectFile(project.id);
    expect(t.app.repos.notifications.byBannerKey(key)).toMatchObject({ state: 'resolved' });
    expect(t.app.projects.projectPolicyTrusted(project.id)).toBe(true);
    rmSync(join(dir, '.styx'), { recursive: true });
    expect(await t.app.projects.reconcileProjectFile(project.id)).toEqual({ ok: true, error: null });
    await expect(t.app.projects.acceptPolicies(project.id, 'a'.repeat(64))).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(t.app.projects.pendingPolicy(project.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('an untrusted file never re-points a connected target through config; unconnected rows take it for the Connect flow', async () => {
    const t = makeTestApp();
    const dir = mkdtempSync(join(tmpdir(), 'styx-h1-'));
    mkdirSync(join(dir, '.styx'));
    const file: ProjectFileV1 = {
      version: 1,
      name: 'acme-shop',
      targets: [
        {
          name: 'Vercel',
          provider: 'vercel',
          env: 'preview',
          authMethod: 'oauth',
          config: { projectId: 'evil' },
        },
        {
          name: 'New',
          provider: 'vercel',
          env: 'staging',
          authMethod: 'oauth',
          config: { projectId: 'prefill' },
        },
      ],
    };
    writeFileSync(join(dir, '.styx', 'project.json'), JSON.stringify(file));
    const project = t.app.repos.projects.get(ids.project.acmeShop)!;
    t.app.repos.projects.upsert({ ...project, path: dir });
    const before = t.app.repos.targets.get(ids.target.vercelPreview)!;
    await t.app.projects.reconcileProjectFile(project.id);
    expect(t.app.repos.targets.get(ids.target.vercelPreview)?.config).toEqual(before.config);
    expect(t.app.repos.targets.byProject(project.id).find((x) => x.name === 'New')?.config).toEqual({
      projectId: 'prefill',
    });
    const r = await t.app.bus.dispatch(t.sender, 'project.policy.pending', { projectId: project.id });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.diff.configChanged).toEqual(['vercel/preview/Vercel', 'vercel/staging/New']);
    await t.app.bus.dispatch(t.sender, 'project.policy.accept', {
      projectId: project.id,
      hash: r.value.hash,
    });
    expect(t.app.repos.targets.get(ids.target.vercelPreview)?.config).toEqual({
      ...before.config,
      projectId: 'evil',
    });
  });

  it('a new file target starts with the app default policy while untrusted', async () => {
    const t = makeTestApp();
    const dir = mkdtempSync(join(tmpdir(), 'styx-h1-'));
    mkdirSync(join(dir, '.styx'));
    const file: ProjectFileV1 = {
      version: 1,
      name: 'acme-shop',
      targets: [{ name: 'Extra', provider: 'github', env: 'scm', authMethod: 'oauth', policy: 'always' }],
    };
    writeFileSync(join(dir, '.styx', 'project.json'), JSON.stringify(file));
    const project = t.app.repos.projects.get(ids.project.acmeShop)!;
    t.app.repos.projects.upsert({ ...project, path: dir });
    await t.app.projects.reconcileProjectFile(project.id);
    const extra = t.app.repos.targets.byProject(project.id).find((x) => x.name === 'Extra');
    expect(extra).toMatchObject({
      policy: 'ask',
      policySource: 'app',
      fromProjectFile: true,
      credentialRef: null,
    });
    const bad = await t.app.bus.dispatch(t.sender, 'project.policy.accept', {
      projectId: project.id,
      hash: 'nope',
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    const { hash } = await t.app.projects.pendingPolicy(project.id);
    expect(
      await t.app.bus.dispatch(t.sender, 'project.policy.accept', { projectId: project.id, hash }),
    ).toEqual({ ok: true, value: {} });
    expect(t.app.repos.targets.get(extra!.id)).toMatchObject({ policy: 'always', policySource: 'project' });
  });
});
