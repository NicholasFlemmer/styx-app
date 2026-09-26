import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${site.url}/`, lastModified: now, changeFrequency: 'monthly', priority: 1 },
    { url: `${site.url}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${site.url}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
