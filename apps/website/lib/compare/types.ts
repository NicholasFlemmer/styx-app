/**
 * Comparison pages (/compare/<slug>): one data file per product, one template. Facts about another product come
 * from its own site and docs as of `checked`, with the sources listed on the page; "Not part of its docs" means
 * we could not find it there, and the page says so. Where they are ahead, `ahead` says it plainly.
 */

export const ROWS = [
  ['runsOn', 'Runs on'],
  ['agents', 'Agents'],
  ['price', 'Price'],
  ['isolation', 'Each agent isolated'],
  ['scope', 'Scope of one window'],
  ['review', 'Review'],
  ['editor', 'Your editor'],
  ['secrets', 'Secrets'],
  ['production', 'Production access'],
  ['audit', 'Audit log'],
  ['deploy', 'Deploy targets'],
  ['cloud', 'Cloud workspaces'],
  ['team', 'Team collaboration'],
  ['issues', 'Issue tracker'],
] as const;

export type RowKey = (typeof ROWS)[number][0];

export interface Competitor {
  slug: string;
  name: string;
  url: string;
  /** One sentence: what it is, in their terms. */
  what: string;
  /** The search title, ≤60 characters, used as is. */
  title: string;
  /** The search snippet, ≤155 characters. */
  description: string;
  /** The page's opening paragraph: what the two have in common and where they part. */
  intro: string;
  /** The short version: three or four bullets. */
  summary: readonly string[];
  cells: Record<RowKey, string>;
  /** Genuine ways it is ahead of or broader than Styx. */
  ahead: readonly { title: string; text: string }[];
  /** The Styx sections that matter most against this product, by key. */
  styxPoints: readonly StyxPoint[];
  choose: { them: string; styx: string };
  faq: readonly { q: string; a: string }[];
  sources: readonly { label: string; url: string }[];
  checked: string;
}

export type StyxPoint = 'projects' | 'keys' | 'editor' | 'local' | 'agents';
