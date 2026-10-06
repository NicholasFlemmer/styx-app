import { notFound } from 'next/navigation';
import { pageMarkdown, source } from '@/lib/docs';

// Every docs page as plain Markdown (/md/docs/<slug>; the docs home is /md/docs/index): "Copy page as Markdown",
// "Open in Claude", and agents that would rather read text than HTML.
export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug.length === 1 && slug[0] === 'index' ? [] : slug);
  if (!page) notFound();
  return new Response(await pageMarkdown(page), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}

export function generateStaticParams() {
  return source.getPages().map((p) => ({ slug: p.slugs.length === 0 ? ['index'] : p.slugs }));
}
