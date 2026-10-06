import desktop from '../../desktop/package.json';

/**
 * Site facts and links. The Mac and Windows downloads come from the build's environment and default to the
 * Download section, so a local build never links into the void.
 */
export const site = {
  name: 'Styx',
  /** The search result's title (≤60 characters): what people type, not the slogan. */
  title: 'Styx: Claude Code, Codex and Cursor agents in one app',
  /** The search result's snippet (≤155 characters, or Google cuts it off). */
  description:
    'Run Claude Code, Codex, Gemini and Cursor on every project from one free, open-source app. Mac, Windows, Linux. Nothing reaches production without your OK.',
  /** The brand line, for share cards where there is room for it. */
  tagline: 'Styx: every project, every agent, every key, one window',
  /** The category people search for (Warp's term, June 2025); used as a label, never as the headline. */
  category: 'agentic development environment (ADE)',
  shareDescription:
    'The desktop app where your work converges: every repo you touch, the AI coding agents building in them, and every login they need to ship. Nothing crosses into production without you. Free and open source, for Mac, with Windows and Linux in beta.',
  email: 'hello@heystyx.com',
  /** When the home page's words last changed (the sitemap's lastmod). Bump it with a copy change, not a deploy. */
  updated: '6 October 2026',
  /** When the founder video on /story last changed (the sitemap's lastmod for it). */
  storyUpdated: '29 September 2026',
  /** When the 21-second demo on /demo last changed. */
  demoUpdated: '30 September 2026',
  /** When the launch article last changed. */
  launchUpdated: '6 October 2026',
  /** When the article on keeping agents away from production (/blog/keeping-agents-away-from-production) last changed. */
  productionPostUpdated: '7 October 2026',
  /** When the docs (content/docs) last changed: the sitemap's date for every docs page. Bump with a docs change. */
  docsUpdated: '6 October 2026',
  url: process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3100',
  version: desktop.version,
  links: {
    downloadMac: process.env['NEXT_PUBLIC_DOWNLOAD_MAC'] ?? '/#download',
    downloadWin: process.env['NEXT_PUBLIC_DOWNLOAD_WIN'] ?? '/#download',
    /** Linux (beta) has no heystyx.com/download route: the AppImage and .deb are on the latest GitHub release. */
    downloadLinux: 'https://github.com/NicholasFlemmer/styx-app/releases/latest',
    /** The source (Apache-2.0), its community and the two contributor guides the site points people to. */
    github: 'https://github.com/NicholasFlemmer/styx-app',
    discussions: 'https://github.com/NicholasFlemmer/styx-app/discussions',
    addAgent: '/docs/contributing/add-an-agent',
    addTarget: '/docs/contributing/add-a-target',
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
  { id: 'design', label: 'Design' },
  { id: 'ship', label: 'Shipping' },
  { id: 'security', label: 'Security' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'download', label: 'Download' },
  { id: 'source', label: 'Open source' },
] as const;

export type SectionId = (typeof sections)[number]['id'];
