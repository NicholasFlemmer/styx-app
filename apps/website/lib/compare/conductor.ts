import type { Competitor } from './types';

export const conductor: Competitor = {
  slug: 'conductor',
  name: 'Conductor',
  url: 'https://www.conductor.build/',
  what: 'A Mac app for running Claude Code, Codex and other agents in parallel, each in an isolated workspace.',
  title: 'Styx vs Conductor: Mac apps for running coding agents',
  description:
    'Styx and Conductor both run Claude Code and Codex in parallel on your Mac. How they differ: projects, production access, audit log, cloud and teams.',
  intro:
    'Styx and Conductor are both agentic development environments (ADEs): Mac apps for running several coding agents at once, each on its own branch, without them tripping over each other or you. If that is all you need, either will do it well. They differ in what surrounds the agents.',
  summary: [
    'Both run Claude Code, Codex and Cursor agents in parallel on a Mac, each in its own worktree.',
    'Styx puts every project in one window and makes agents ask before they touch production.',
    'Conductor has cloud workspaces, team collaboration and a Linear integration; Styx has none of those.',
    'Both are free to start and use your existing agent subscriptions.',
  ],
  cells: {
    runsOn: 'Mac',
    agents: 'Claude Code, Codex, Cursor, OpenCode',
    price: 'Free locally; Pro $50/month, Teams $60/user/month',
    isolation: 'Own workspace, worktree and branch',
    scope: 'Workspaces across the repositories you add',
    review: 'Diff viewer, pull requests, merge, checks',
    editor: 'Not part of its docs',
    secrets: 'Env vars and a .env in the project, readable by agents',
    production: 'Not part of its docs',
    audit: 'Not part of its docs',
    deploy: 'Not part of its docs',
    cloud: 'Yes, on Pro and above',
    team: 'Multiplayer on Pro; Teams plan',
    issues: 'Starts work from Linear issues',
  },
  ahead: [
    {
      title: 'Cloud workspaces',
      text: 'Agents can run on Conductor’s machines, so work carries on with your laptop closed. Styx runs everything on your Mac.',
    },
    {
      title: 'Teams',
      text: 'Conductor has live collaboration and an admin portal. Styx is for one person today.',
    },
    { title: 'Linear', text: 'Conductor can start a workspace straight from a Linear issue.' },
    { title: 'OpenCode', text: 'Conductor runs it; Styx runs Gemini CLI instead.' },
  ],
  styxPoints: ['projects', 'keys', 'editor'],
  choose: {
    them: 'you want agents running in the cloud, work as a team, or start tasks from Linear',
    styx: 'you work across several projects and want your agents near production without handing them the keys',
  },
  faq: [
    {
      q: 'Is Styx a Conductor alternative?',
      a: 'Yes. Both are Mac apps that run coding agents like Claude Code and Codex in parallel, each in its own git worktree. Styx adds every project in one window and a gate on production access; Conductor adds cloud workspaces and team collaboration.',
    },
    {
      q: 'Do I need new subscriptions to use either?',
      a: 'No. Both use the agent logins you already have, such as a Claude or ChatGPT subscription. Styx is free; Conductor is free for local use, with paid plans for cloud workspaces and teams.',
    },
    {
      q: 'Can I use both?',
      a: 'Yes. Both work on ordinary git worktrees and branches in your own repositories, so neither locks your work in.',
    },
  ],
  sources: [
    { label: 'conductor.build', url: 'https://www.conductor.build/' },
    { label: 'Conductor docs', url: 'https://www.conductor.build/docs/' },
    { label: 'Conductor pricing', url: 'https://www.conductor.build/pricing' },
    {
      label: 'Conductor environment variables',
      url: 'https://www.conductor.build/docs/reference/environment-variables',
    },
    {
      label: 'Conductor: using multiple repositories',
      url: 'https://docs.conductor.build/tips/using-multiple-repos',
    },
  ],
  checked: '29 September 2026',
};
