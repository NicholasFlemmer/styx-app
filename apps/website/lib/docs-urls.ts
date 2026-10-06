import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const CONTENT = join(process.cwd(), 'content', 'docs');

/**
 * Every docs page's URL, from the MDX files under content/docs (index.mdx is its folder). Read straight from disk so
 * the sitemap (and its test) don't need the compiled collection.
 */
export function docsUrls(dir: string = CONTENT): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.mdx'))
    .map((f) =>
      `/docs/${f
        .replace(/\\/g, '/')
        .replace(/\.mdx$/, '')
        .replace(/(^|\/)index$/, '')}`.replace(/\/$/, ''),
    )
    .sort();
}
