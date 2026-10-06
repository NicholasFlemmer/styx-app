import type { Competitor } from './types';

export const emdash: Competitor = {
  slug: 'emdash',
  name: 'Emdash',
  url: 'https://emdash.com',
  what: 'A free, open-source agentic development environment that runs dozens of coding agents in parallel, on any OS.',
  title: 'Styx vs Emdash: comparing two ADEs for coding agents',
  description:
    'Styx and Emdash both run coding agents in parallel worktrees. How they differ: agent count, issue trackers, cloud workspaces and production access.',
  intro:
    'Styx and Emdash are both agentic development environments: several coding agents at once, each on its own branch in its own worktree, with diffs to review before anything merges. Both are open source. Emdash casts the widest net; Styx is narrower and puts its effort into what agents may touch.',
  summary: [
    'Both run coding agents in parallel, one git worktree per task.',
    'Both are free and open source. Emdash supports 34 CLI agents; Styx supports four.',
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
    { title: 'Every platform', text: 'It ships for Windows and Linux as well as the Mac.' },
    { title: 'More agents', text: 'It supports 34 CLI agents; Styx supports four.' },
    {
      title: 'Issue intake',
      text: 'It pulls tasks with their context from Linear, Jira, GitHub, Notion and Asana.',
    },
  ],
  styxPoints: ['keys', 'projects', 'editor'],
  choose: {
    them: 'you want the longest list of agents, cloud workspaces, or tasks straight from your issue tracker',
    styx: 'you work across several projects and want agents to ask before they touch anything live',
  },
  faq: [
    {
      q: 'Is Styx an Emdash alternative?',
      a: 'Yes. Both run coding agents in parallel, each in its own git worktree. Emdash supports more agents and pulls tasks from issue trackers; Styx adds every project in one window and a gate on production access.',
    },
    {
      q: 'Is Styx open source like Emdash?',
      a: 'Yes. Styx is free and open source under the Apache License 2.0, and its code is on GitHub.',
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
