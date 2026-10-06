import type * as PageTree from 'fumadocs-core/page-tree';
import type { NavSection } from '@/components/docs/Sidebar';

const nameOf = (n: { name?: unknown }): string => (typeof n.name === 'string' ? n.name : String(n.name ?? ''));

/**
 * The sidebar's groups from the page tree: one per folder (its meta.json title), pages in meta.json order. Pages at
 * the root (the docs home) lead the first group.
 */
export function navSections(tree: PageTree.Root): NavSection[] {
  const loose: NavSection['items'] = [];
  const sections: NavSection[] = [];
  for (const node of tree.children) {
    if (node.type === 'page') loose.push({ name: nameOf(node), url: node.url });
    else if (node.type === 'folder')
      sections.push({
        title: nameOf(node),
        items: node.children
          .filter((c): c is PageTree.Item => c.type === 'page')
          .map((c) => ({ name: nameOf(c), url: c.url })),
      });
  }
  if (sections[0]) sections[0].items.unshift(...loose);
  else sections.push({ title: null, items: loose });
  return sections;
}

/** The folder (sidebar group) a page sits in, for the breadcrumb. */
export function sectionOf(tree: PageTree.Root, url: string): string | null {
  for (const node of tree.children)
    if (node.type === 'folder' && node.children.some((c) => c.type === 'page' && c.url === url)) return nameOf(node);
  return null;
}
