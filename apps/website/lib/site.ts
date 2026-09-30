import desktop from '../../desktop/package.json';

/**
 * Site facts and links. Anything that does not exist yet (release URLs, a source repository) defaults
 * to a page anchor so the page never links into the void; fill these in when the artefacts exist.
 */
export const site = {
  name: 'Styx',
  /** The search result's title (≤60 characters): what people type, not the slogan. */
  title: 'Styx: Claude Code, Codex and Cursor agents in one Mac app',
  /** The search result's snippet (≤155 characters, or Google cuts it off). */
  description:
    'Run Claude Code, Codex, Gemini and Cursor across every project in one Mac app. See which agent needs you. Nothing reaches production without your OK.',
  /** The brand line, for share cards where there is room for it. */
  tagline: 'Styx: every project, every agent, every key, one window',
  /** The category people search for (Warp's term, June 2025); used as a label, never as the headline. */
  category: 'agentic development environment (ADE)',
  shareDescription:
    'The desktop app where your work converges: every repo you touch, the AI coding agents building in them, and every login they need to ship. Nothing crosses into production without you.',
  email: 'hello@heystyx.com',
  /** When the home page's words last changed (the sitemap's lastmod). Bump it with a copy change, not a deploy. */
  updated: '29 September 2026',
  /** When the founder video on /story last changed (the sitemap's lastmod for it). */
  storyUpdated: '29 September 2026',
  /** When the 21-second demo on /demo last changed. */
  demoUpdated: '30 September 2026',
  /** When the launch article last changed. */
  launchUpdated: '30 September 2026',
  url: process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3100',
  version: desktop.version,
  links: {
    downloadMac: process.env['NEXT_PUBLIC_DOWNLOAD_MAC'] ?? '/#download',
    /** Buy Me a Coffee (owner request): the footer's support band. */
    support: 'https://buymeacoffee.com/heystyx',
    /** Product Hunt (launch, 30 September 2026): the product page and its featured badge. */
    productHunt:
      'https://www.producthunt.com/products/styx-2?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-styx-2',
    productHuntPost:
      'https://www.producthunt.com/products/styx-2?embed=true&utm_source=embed&utm_medium=post_embed',
    productHuntBadge: (theme: 'light' | 'dark') =>
      `https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1260993&theme=${theme}`,
    productHuntIcon:
      'https://ph-files.imgix.net/15b1b98e-88e1-4feb-aaec-38cb220238a2.svg?auto=compress,format&codec=mozjpeg&cs=strip&fit=crop&h=80&w=80',
  },
} as const;

export const sections = [
  { id: 'how', label: 'How it works' },
  { id: 'access', label: 'Approvals' },
  { id: 'agents', label: 'Works with' },
  { id: 'repo', label: 'Your code' },
  { id: 'ship', label: 'Shipping' },
  { id: 'screens', label: 'Screens' },
  { id: 'security', label: 'Security' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'download', label: 'Download' },
] as const;

export type SectionId = (typeof sections)[number]['id'];
