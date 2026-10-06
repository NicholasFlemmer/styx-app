import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';

/** heystyx.com/docs: every page under content/docs, as a tree for the sidebar and pages by slug. */
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});

export type DocsPage = NonNullable<ReturnType<typeof source.getPage>>;

/** The public repo, for "Edit this page on GitHub". */
export const DOCS_REPO = 'https://github.com/NicholasFlemmer/styx-app';

export const editUrl = (page: DocsPage): string =>
  `${DOCS_REPO}/blob/main/apps/website/content/docs/${page.path}`;

/** The page as plain Markdown, for "Copy page as Markdown" and /llms-full.txt. */
export async function pageMarkdown(page: DocsPage): Promise<string> {
  const body = await page.data.getText('processed');
  return `# ${page.data.title}\n\n${page.data.description ? `${page.data.description}\n\n` : ''}${body}`;
}

/** Where a page's Markdown is served: /md/docs/<slug> (the docs home is /md/docs/index). */
export const markdownUrl = (page: DocsPage): string =>
  `/md/docs/${page.slugs.length === 0 ? 'index' : page.slugs.join('/')}`;
