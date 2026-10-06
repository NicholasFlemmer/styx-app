import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/docs';

// The search index, built once with the site and downloaded by the ⌘K dialog (components/docs/Search.tsx).
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);
