import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ComparePage } from '@/components/ComparePage';
import { COMPETITORS, competitor } from '@/lib/compare';

export const dynamicParams = false;

export const generateStaticParams = () => COMPETITORS.map((c) => ({ slug: c.slug }));

type Props = { params: Promise<{ slug: string }> };

export const generateMetadata = async ({ params }: Props): Promise<Metadata> => {
  const c = competitor((await params).slug);
  if (c === undefined) return {};
  return {
    title: { absolute: c.title },
    description: c.description,
    alternates: { canonical: `/compare/${c.slug}` },
    openGraph: { title: `Styx vs ${c.name}`, description: c.description, url: `/compare/${c.slug}` },
  };
};

export default async function Page({ params }: Props) {
  const c = competitor((await params).slug);
  if (c === undefined) notFound();
  return <ComparePage c={c} />;
}
