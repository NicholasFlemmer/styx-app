import desktop from '../../desktop/package.json';

/**
 * Site facts and links. Anything that does not exist yet (release URLs, a source repository) defaults
 * to a page anchor so the page never links into the void; fill these in when the artefacts exist.
 */
export const site = {
  name: 'Styx',
  title: 'Styx: every project, every agent, every key, one window',
  description:
    'The desktop app where your work converges: every repo you touch, the AI agents building in them, and every login they need to ship. One window for all of it, and nothing crosses into production without you. Mac now, Windows soon.',
  url: process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3100',
  version: desktop.version,
  links: {
    downloadMac: process.env['NEXT_PUBLIC_DOWNLOAD_MAC'] ?? '#download',
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
