import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { remarkIncludedRepoLinks } from './lib/remark-included-repo-links';

/**
 * The docs collection (heystyx.com/docs). Pages are MDX under content/docs, ordered by each folder's meta.json.
 * The processed Markdown is kept for "Copy page as Markdown", /md/docs/… and /llms-full.txt.
 */
export const docs = defineDocs({
  dir: 'content/docs',
  docs: { postprocess: { includeProcessedMarkdown: true } },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: { themes: { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' } },
    remarkPlugins: [remarkIncludedRepoLinks],
  },
});
