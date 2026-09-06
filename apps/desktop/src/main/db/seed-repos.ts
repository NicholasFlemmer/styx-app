import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtures, type Worktree } from '@styx/core';
import { ExecaGitRunner, GitService, worktreeLocation, type GitRunner } from '../services/git';
import { logger } from '../services/logger';
import type { Repos } from './repos';
import type { FixtureName } from './seed';

const { ids } = fixtures;

/** The prototype's acme-shop files (Workspace tree / hunk bar / Diff review). Root-level like the core fixture hunks. */
const ACME_MAIN: Record<string, string> = {
  'README.md': '# acme-shop\n\nDemo repo materialised by Styx (`STYX_FIXTURE=demo`).\n',
  'app.ts': "import { checkout } from './checkout'\n\nexport { checkout }\n",
  'cart.ts': 'export const sum = (items) => items.reduce((t, i) => t + i.price, 0)\n',
  'checkout.ts': [
    "import { sum } from './cart'",
    '',
    'export async function checkout(cart) {',
    '  const total = sum(cart.items)',
    '  const receipt = await pay(total)',
    '  return receipt',
    '}',
    '',
  ].join('\n'),
  'pay.ts': 'export async function pay(total) {\n  return { total, ok: true }\n}\n',
  'orders.test.ts': [
    "import { checkout } from './checkout'",
    '',
    "test('orders total', async () => {",
    '  const r = await checkout({ items: [{ price: 2 }, { price: 3 }] })',
    '  expect(r.total).toBe(5)',
    '})',
    '',
  ].join('\n'),
  '.styx/project.json': `${JSON.stringify({ version: 1, name: 'acme-shop', agents: { default: 'claude', mayRequestTargets: true } }, null, 2)}\n`,
};

/** fix/checkout working tree: the three pending hunks (checkout.ts ×2, validate.ts) + the new test file. */
const FIX_CHECKOUT: Record<string, string> = {
  'checkout.ts': [
    "import { sum } from './cart'",
    "import { validate } from './validate'",
    '',
    'export async function checkout(cart) {',
    '  validate(cart)',
    '  const total = sum(cart.items)',
    '  const receipt = await pay(total)',
    '  audit(receipt)',
    '  return receipt',
    '}',
    '',
  ].join('\n'),
  'validate.ts': [
    'export class CartError extends Error {}',
    '',
    'export function validate(cart) {',
    '  if (!cart.items.length) throw new CartError("empty")',
    '  for (const item of cart.items) {',
    '    if (typeof item.price !== "number") throw new CartError("price")',
    '    if (item.price < 0) throw new CartError("negative")',
    '  }',
    '}',
    '',
  ].join('\n'),
  'checkout.test.ts': [
    "import { checkout } from './checkout'",
    '',
    "test('checkout validates', async () => {",
    '  await expect(checkout({ items: [] })).rejects.toThrow()',
    '})',
    '',
    "test('checkout pays the total', async () => {",
    '  const r = await checkout({ items: [{ price: 2 }] })',
    '  expect(r.ok).toBe(true)',
    '})',
    '',
  ].join('\n'),
};

const TEST_FLAKY: Record<string, string> = {
  'orders.test.ts': [
    "import { checkout } from './checkout'",
    '',
    "test('orders total', async () => {",
    '  const r = await checkout({ items: [{ price: 2 }, { price: 3 }] })',
    '  expect(r.total).toBe(5)',
    '  expect(r.ok).toBe(true)',
    '})',
    '',
    "test('orders retry once', async () => {",
    '  const r = await checkout({ items: [{ price: 1 }] })',
    '  expect(r.total).toBe(1)',
    '})',
    '',
  ].join('\n'),
};

const FEAT_PROMO: Record<string, string> = {
  'promo.ts': 'export const applyPromo = (total, code) => (code === "SAVE10" ? total * 0.9 : total)\n',
};

const BLOG_MAIN: Record<string, string> = {
  'README.md': '# blog-v2\n',
  'app.ts': 'export const render = (post) => `<article>${post.body}</article>`\n',
  'posts/hello.md': '# Hello\n\nFirst post.\n',
};

const FEAT_MDX: Record<string, string> = {
  'app.ts':
    "import { compile } from './mdx.config'\n\nexport const render = (post) => `<article>${compile(post.body)}</article>`\n",
  'mdx.config.ts': 'export const compile = (src: string) => src\n',
};

interface RepoSpec {
  projectId: string;
  name: string;
  main: Record<string, string>;
  /** Branch → files written in its worktree (uncommitted) and whether the branch is merged into main first. */
  branches: {
    branch: string;
    files: Record<string, string>;
    merged?: boolean;
    commitFiles?: Record<string, string>;
  }[];
}

const specs = (fixture: FixtureName): RepoSpec[] => [
  {
    projectId: ids.project.acmeShop,
    name: 'acme-shop',
    main: ACME_MAIN,
    branches: [
      { branch: 'feat/promo', files: {}, merged: true, commitFiles: FEAT_PROMO },
      {
        branch: 'fix/checkout',
        files: FIX_CHECKOUT,
        // error fixture: a committed edit to checkout.ts that main also changes → merge-tree conflict.
        ...(fixture === 'error'
          ? { commitFiles: { 'checkout.ts': ACME_MAIN['checkout.ts']!.replace("'./cart'", "'./cart.js'") } }
          : {}),
      },
      { branch: 'test/flaky', files: TEST_FLAKY },
    ],
  },
  {
    projectId: ids.project.blogV2,
    name: 'blog-v2',
    main: BLOG_MAIN,
    branches: [{ branch: 'feat/mdx', files: FEAT_MDX }],
  },
  {
    projectId: ids.project.infraTools,
    name: 'infra-tools',
    main: { 'README.md': '# infra-tools\n', 'main.tf': 'terraform {}\n' },
    branches: [],
  },
  {
    projectId: ids.project.clientX,
    name: 'client-x',
    main: { 'README.md': '# client-x\n', 'index.ts': 'export {}\n' },
    branches: [],
  },
  {
    projectId: ids.project.sideApi,
    name: 'side-api',
    main: { 'README.md': '# side-api\n', 'server.ts': 'export const port = 3000\n' },
    branches: [],
  },
];

export interface SeedReposOptions {
  repos: Repos;
  userData: string;
  fixture: FixtureName;
  git?: GitRunner;
}

export interface SeedReposResult {
  root: string;
  created: string[];
  paths: Record<string, string>;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, text);
  }
}

/**
 * Materialises real git repos for the fixture projects under `<userData>/demo-repos/<name>` and points the seeded
 * project/worktree rows at them, so `fs.*`, `worktree.diff`, hunks and terminals work on the demo. Idempotent: an
 * existing repo is reused (only the DB rows are re-pointed). The `error` fixture commits conflicting edits to
 * `checkout.ts` on `fix/checkout` and `main`.
 */
export async function seedDemoRepos(opts: SeedReposOptions): Promise<SeedReposResult> {
  const runner = opts.git ?? new ExecaGitRunner();
  const git = new GitService(runner);
  const root = join(opts.userData, 'demo-repos');
  await mkdir(root, { recursive: true });
  const created: string[] = [];
  const paths: Record<string, string> = {};
  const commitEnv = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Styx', '-c', 'user.email=styx@localhost'];
  const run = (args: string[], cwd: string) => runner.run([...commitEnv, ...args], cwd);

  for (const spec of specs(opts.fixture)) {
    const repoPath = join(root, spec.name);
    const fresh = !existsSync(join(repoPath, '.git'));
    if (fresh) {
      await mkdir(repoPath, { recursive: true });
      await git.init(repoPath, 'main');
      await writeFiles(repoPath, spec.main);
      await run(['add', '-A'], repoPath);
      await run(['commit', '-q', '-m', 'init'], repoPath);
      for (const b of spec.branches) {
        const wtPath = worktreeLocation(repoPath, b.branch);
        await mkdir(join(wtPath, '..'), { recursive: true });
        await git.worktreeAdd(repoPath, { branch: b.branch, base: 'main', path: wtPath });
        if (b.commitFiles) {
          await writeFiles(wtPath, b.commitFiles);
          await run(['add', '-A'], wtPath);
          await run(['commit', '-q', '-m', `${b.branch}: changes`], wtPath);
        }
        if (b.merged) await run(['merge', '-q', '--no-ff', '-m', `Merge ${b.branch}`, b.branch], repoPath);
        await writeFiles(wtPath, b.files);
      }
      if (opts.fixture === 'error' && spec.name === 'acme-shop') {
        // main moves on the same line fix/checkout changed → conflict in checkout.ts.
        await writeFiles(repoPath, {
          'checkout.ts': ACME_MAIN['checkout.ts']!.replace("'./cart'", "'./cart/index'"),
        });
        await run(['add', '-A'], repoPath);
        await run(['commit', '-q', '-m', 'main: move cart module'], repoPath);
      }
      created.push(repoPath);
    }
    paths[spec.projectId] = repoPath;

    // --- re-point the seeded rows -------------------------------------------
    const project = opts.repos.projects.get(spec.projectId);
    if (project)
      opts.repos.projects.upsert({ ...project, path: repoPath }, opts.repos.projects.settings(project.id));
    const mainHead = await git.headCommit(repoPath);
    for (const wt of opts.repos.worktrees.byProject(spec.projectId)) {
      const branch = spec.branches.find((b) => b.branch === wt.branch);
      let next: Worktree;
      const wtBranch = wt.branch;
      if (wt.isMain || wtBranch === null)
        next = { ...wt, path: repoPath, baseCommit: mainHead, headCommit: mainHead };
      else if (branch) {
        const wtPath = worktreeLocation(repoPath, wtBranch);
        const head = await git.headCommit(wtPath);
        const base =
          (await runner.run(['merge-base', 'main', wtBranch], repoPath, { reject: false })).stdout.trim() ||
          mainHead;
        next = { ...wt, path: wtPath, baseCommit: base, headCommit: head };
      } else next = { ...wt, path: worktreeLocation(repoPath, wtBranch) };
      opts.repos.worktrees.upsert(next);
    }
  }
  logger.info('demo repos', { root, created: created.length, fixture: opts.fixture });
  return { root, created, paths };
}
