import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_BLOB = 'https://github.com/NicholasFlemmer/styx-app/blob/main/';

/** Canonical repo guides that also have a docs page: links to them stay on the site. */
const DOCS_PAGE_FOR: Record<string, string> = {
  'docs/contributing/adding-an-agent.md': '/docs/contributing/add-an-agent',
  'docs/contributing/adding-a-target.md': '/docs/contributing/add-a-target',
};

/** Repo paths that exist on GitHub; any other relative link is left alone. */
const REPO_PATH =
  /^(apps|packages|docs|design|\.github|\.claude)\/|^(README|CLAUDE|CONTRIBUTING|SECURITY)\.md$|^LICENSE$/;

interface MdNode {
  type: string;
  url?: string;
  depth?: number;
  children?: MdNode[];
}

const repoRootFrom = (dir: string): string | null => {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d;
    if (path.dirname(d) === d) return null;
  }
};

/** Where a relative link written in `fromDir` should point on the website (null: leave it). */
export const rewriteRepoLink = (url: string, fromDir: string, repoRoot: string): string | null => {
  if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return null; // absolute, scheme, or same-page anchor
  const hashAt = url.indexOf('#');
  const file = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const rel = path.relative(repoRoot, path.resolve(fromDir, file)).split(path.sep).join('/');
  const page = DOCS_PAGE_FOR[rel];
  if (page !== undefined) return page + hash;
  if (!REPO_PATH.test(rel)) return null;
  return REPO_BLOB + rel + (file.endsWith('/') ? '/' : '') + hash;
};

/**
 * Makes `<include>` of a repo Markdown file (e.g. docs/contributing/adding-an-agent.md) read right on the site.
 * fumadocs-mdx runs its include step before any remarkPlugins and leaves each included file as a nested `root`
 * node, in document order. This pairs those nodes with the `<include>` paths in the page source, then inside each:
 * - drops the file's `# Title` (the page's frontmatter title is shown instead), and
 * - rewrites relative links, which were written relative to the included file: the two guides become their docs
 *   pages, other repo paths (apps/…, packages/…, docs/…, README.md, …) become GitHub links.
 */
export function remarkIncludedRepoLinks() {
  return (tree: MdNode, file: { path?: string; cwd?: string; value?: unknown }) => {
    if (file.path === undefined) return;
    const pageDir = path.dirname(path.resolve(file.cwd ?? '.', file.path));
    const specs = [...String(file.value ?? '').matchAll(/<include(?:\s[^>]*)?>([^<]+)<\/include>/g)].map(
      (m) => path.resolve(pageDir, (m[1] ?? '').trim().replace(/#[^/]*$/, '')),
    );
    let next = 0;
    const rewriteLinks = (node: MdNode, fromDir: string, root: string) => {
      if ((node.type === 'link' || node.type === 'definition') && node.url !== undefined) {
        node.url = rewriteRepoLink(node.url, fromDir, root) ?? node.url;
      }
      for (const child of node.children ?? []) rewriteLinks(child, fromDir, root);
    };
    const walk = (node: MdNode, isTop: boolean) => {
      if (!isTop && node.type === 'root') {
        const target = specs[next++];
        const fromDir = target === undefined ? null : path.dirname(target);
        const root = fromDir === null ? null : repoRootFrom(fromDir);
        if (node.children)
          node.children = node.children.filter((c) => !(c.type === 'heading' && c.depth === 1));
        if (fromDir !== null && root !== null) rewriteLinks(node, fromDir, root);
        return; // nested includes are not used in the docs
      }
      for (const child of node.children ?? []) walk(child, false);
    };
    walk(tree, true);
  };
}
