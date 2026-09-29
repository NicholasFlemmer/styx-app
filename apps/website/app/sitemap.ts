import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';
import { legal } from '@/lib/legal';
import { COMPETITORS } from '@/lib/compare';
import { dayOf } from '@/lib/dates';

export const dynamic = 'force-static';

/**
 * Written once at build time and served as a plain file. Each URL carries the date its content last changed —
 * never the build time, which would tell Google every page changed on every deploy, and teach it to ignore the
 * dates altogether.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const compared = COMPETITORS.map((c) => dayOf(c.checked));
  const latest = new Date(Math.max(...compared.map((d) => d.getTime())));
  return [
    { url: `${site.url}/`, lastModified: dayOf(site.updated), changeFrequency: 'monthly', priority: 1 },
    { url: `${site.url}/compare`, lastModified: latest, changeFrequency: 'monthly', priority: 0.6 },
    ...COMPETITORS.map((c, i) => ({
      url: `${site.url}/compare/${c.slug}`,
      lastModified: compared[i] ?? latest,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
    {
      url: `${site.url}/privacy`,
      lastModified: dayOf(legal.effective),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${site.url}/terms`,
      lastModified: dayOf(legal.effective),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ];
}
