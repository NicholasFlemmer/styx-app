import type { Competitor } from './types';

export const emdash: Competitor = {
  slug: 'emdash',
  name: 'Emdash',
  url: 'https://emdash.com',
  what: 'A free, open-source agentic development environment that runs dozens of coding agents in parallel, on any OS.',
  title: 'Styx vs Emdash: comparing two ADEs for coding agents',
  description:
    'Styx and Emdash both run coding agents in parallel worktrees. How they differ: open source, platforms, agent count, issue trackers and production access.',
  intro:
    'Styx and Emdash are both agentic development environments: several coding agents at once, each on its own branch in its own worktree, with diffs to review before anything merges. Emdash is open source and casts the widest net; Styx is narrower and puts its effort into what agents may touch.',
  summary: [
    'Both run coding agents in parallel, one git worktree per task.',
    'Emdash is open source, runs on Mac, Windows and Linux, and supports 34 CLI agents.',
    'Emdash pulls tasks from Linear, Jira, GitHub, Notion and Asana.',
    'Styx gates production access with expiring, approved grants and an audit log.',
  ],
  cells: {
    runsOn: 'Mac, Windows, Linux',
    agents: '34 CLI agents, incl. Claude Code, Codex, Cursor, Amp, Copilot',
    price: 'Free and open source; Cloud and Enterprise prices not published',
    isolation: 'One git worktree per task, with its own branch and terminal',
    scope: 'Not part of its docs',
    review: 'Side-by-side diffs, commit, push, pull requests, GitHub Actions checks',
    editor: 'Built-in file browser and editor in each task',
    secrets: 'Not part of its docs',
    production: 'Not part of its docs',
    audit: 'Not part of its docs',
    deploy: 'Not part of its docs',
    cloud: 'SSH to your own servers; temporary cloud workspaces',
    team: 'Enterprise tier, by contact',
    issues: 'Linear, Jira, GitHub, Notion, Asana',
  },
  ahead: [
    { title: 'Open source', text: 'Emdash’s code is public. Styx is not open source.' },
    { title: 'Every platform', text: 'It ships for Windows and Linux as well as the Mac.' },
    { title: 'More agents', text: 'It supports 34 CLI agents; Styx supports four.' },
    {
      title: 'Issue intake',
      text: 'It pulls tasks with their context from Linear, Jira, GitHub, Notion and Asana.',
    },
  ],
  styxPoints: ['keys', 'projects', 'editor'],
  choose: {
    them: 'you want open source, Windows or Linux, the longest list of agents, or tasks straight from your issue tracker',
    styx: 'you are on a Mac, work across several projects, and want agents to ask before they touch anything live',
  },
  faq: [
    {
      q: 'Is Styx an Emdash alternative?',
      a: 'Yes. Both run coding agents in parallel, each in its own git worktree. Emdash is open source, cross-platform and supports more agents; Styx adds every project in one window and a gate on production access.',
    },
    {
      q: 'Is Styx open source like Emdash?',
      a: 'No. Styx is free to use but its source is not public.',
    },
  ],
  sources: [
    { label: 'emdash.com', url: 'https://emdash.com' },
    { label: 'Emdash docs', url: 'https://emdash.com/docs' },
    { label: 'Emdash Cloud', url: 'https://emdash.com/cloud' },
    { label: 'Emdash on GitHub', url: 'https://github.com/generalaction/emdash' },
  ],
  checked: '29 September 2026',
};
