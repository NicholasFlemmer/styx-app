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
  url: process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3100',
  version: desktop.version,
  links: {
    downloadMac: process.env['NEXT_PUBLIC_DOWNLOAD_MAC'] ?? '/#download',
    /** Buy Me a Coffee (owner request): the footer's support band. */
    support: 'https://buymeacoffee.com/heystyx',
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
