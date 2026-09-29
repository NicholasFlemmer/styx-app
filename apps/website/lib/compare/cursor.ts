import type { Competitor } from './types';

export const cursor: Competitor = {
  slug: 'cursor',
  name: 'Cursor',
  url: 'https://cursor.com',
  what: 'An AI code editor whose Agents Window runs many of its own agents in parallel, locally and in the cloud.',
  title: 'Styx vs Cursor: an ADE next to an AI code editor',
  description:
    'Cursor is an AI editor with its own agents; Styx runs Claude Code, Codex, Gemini and Cursor side by side. How they differ, and when you want both.',
  intro:
    'Cursor is an AI code editor with its own agent, and its Agents Window runs many of them at once. Styx is not an editor: it runs Claude Code, Codex, Gemini CLI and Cursor’s agent side by side across your projects, and sits on top of whichever editor you use, Cursor included.',
  summary: [
    'Cursor is a full AI editor; Styx is a place to run and supervise agents from several companies.',
    'Cursor runs its own agent, locally and in cloud VMs, on paid plans.',
    'Styx runs Claude Code, Codex, Gemini CLI and Cursor’s agent next to each other.',
    'Styx gates production access; many people use both.',
  ],
  cells: {
    runsOn: 'Mac, Windows, Linux; web and iOS for cloud agents',
    agents: 'Cursor’s own agent, with several model providers',
    price: 'Free tier; Pro $20, Pro+ $60, Ultra $200/month; Teams per user',
    isolation: 'Git worktrees locally; a VM and branch per cloud agent',
    scope: 'Agents Window spans many repositories',
    review: 'Diffs, commits and pull requests; Bugbot reviews code',
    editor: 'It is the editor',
    secrets: 'Cloud agent secrets set in its dashboard',
    production: 'Enterprise controls for auto-run and network; no deploy approval',
    audit: 'Audit logs on Enterprise',
    deploy: 'Not part of its docs',
    cloud: 'Cloud agents in isolated VMs, billed at API rates',
    team: 'Team billing, shared context, SSO, analytics',
    issues: 'Start agents from Linear, GitHub, Slack or its API',
  },
  ahead: [
    {
      title: 'A full editor',
      text: 'Cursor is a complete IDE with language servers. Styx does not try to be one.',
    },
    {
      title: 'Cloud agents',
      text: 'Its agents keep working in cloud VMs and can move between cloud and your machine.',
    },
    {
      title: 'Start from anywhere',
      text: 'Agents can start from Slack, Linear, GitHub, the web, iOS or its API.',
    },
    { title: 'Code review', text: 'Bugbot reviews pull requests automatically.' },
  ],
  styxPoints: ['agents', 'keys', 'editor'],
  choose: {
    them: 'you want one AI editor with its own agent and cloud machines',
    styx: 'you use more than one agent, or several projects, and want them in one place with production kept behind an approval; Styx opens files back in Cursor',
  },
  faq: [
    {
      q: 'Can I use Styx with Cursor?',
      a: 'Yes. Styx runs Cursor’s agent alongside Claude Code, Codex and Gemini CLI, and can import your Cursor recents, keybindings and theme and open files back in Cursor.',
    },
    {
      q: 'Is Styx a Cursor alternative?',
      a: 'Not as an editor. Styx is for running and supervising agents; you keep writing code in the editor you like, which can be Cursor.',
    },
  ],
  sources: [
    { label: 'Cursor pricing', url: 'https://cursor.com/pricing' },
    { label: 'Cursor pricing help', url: 'https://cursor.com/help/account-and-billing/pricing' },
    { label: 'Cursor cloud agents', url: 'https://cursor.com/docs/cloud-agent' },
    { label: 'Cursor 3', url: 'https://cursor.com/blog/cursor-3' },
  ],
  checked: '29 September 2026',
};
