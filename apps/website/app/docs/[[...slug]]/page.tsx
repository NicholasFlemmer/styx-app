import { findNeighbour } from 'fumadocs-core/page-tree';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CopyMarkdown } from '@/components/docs/CopyMarkdown';
import { getMDXComponents } from '@/components/docs/mdx';
import { Toc } from '@/components/docs/Toc';
import { editUrl, markdownUrl, source } from '@/lib/docs';
import { sectionOf } from '@/lib/docs-nav';
import styles from '../docs.module.css';

interface Props {
  params: Promise<{ slug?: string[] }>;
}

const ISSUE = 'https://github.com/NicholasFlemmer/styx-app/issues/new';

export default async function DocsPage({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const tree = source.getPageTree();
  const MDX = page.data.body;
  const { previous, next } = findNeighbour(tree, page.url);
  const section = sectionOf(tree, page.url);
  const md = markdownUrl(page);
  const claude = `https://claude.ai/new?q=${encodeURIComponent(`Read https://heystyx.com${md} and help me with Styx.`)}`;
  return (
    <>
      <main id="content" className={styles.main}>
        {section ? (
          <p className={styles.crumb}>
            <a href="/docs">Docs</a> / {section}
          </p>
        ) : null}
        <h1 className={styles.h1}>{page.data.title}</h1>
        {page.data.description ? <p className={styles.lede}>{page.data.description}</p> : null}
        <div className={styles.meta}>
          <CopyMarkdown url={md} className={styles.metaBtn} />
        </div>
        <article className={styles.prose}>
          <MDX components={getMDXComponents()} />
        </article>
        <nav className={styles.next} aria-label="Previous and next">
          {previous ? (
            <a href={previous.url}>
              <small>Previous</small>
              <b>{previous.name}</b>
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a href={next.url} data-side="next">
              <small>Next</small>
              <b>{next.name}</b>
            </a>
          ) : null}
        </nav>
        <p className={styles.feedback}>
          Something wrong or missing on this page?{' '}
          <a
            href={`${ISSUE}?title=${encodeURIComponent(`Docs: ${page.data.title}`)}&body=${encodeURIComponent(`Page: https://heystyx.com${page.url}\n\n`)}`}
          >
            Tell us on GitHub
          </a>{' '}
          or <a href={editUrl(page)}>edit it yourself</a>.
        </p>
      </main>
      <Toc
        items={page.data.toc}
        tools={
          <>
            <a href={editUrl(page)}>Edit this page on GitHub</a>
            <CopyMarkdown url={md} />
            <a href={claude}>Open in Claude</a>
            <a href={md}>View as Markdown</a>
          </>
        }
      />
    </>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return {
    title: page.slugs.length === 0 ? 'Docs' : `${page.data.title} · Docs`,
    description: page.data.description,
    alternates: { canonical: page.url },
  };
}
