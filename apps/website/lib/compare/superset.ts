import type { Competitor } from './types';

export const superset: Competitor = {
  slug: 'superset',
  name: 'Superset',
  url: 'https://superset.sh',
  what: 'A desktop workspace that runs Claude Code, Codex and other CLI agents in parallel, each in its own worktree.',
  title: 'Styx vs Superset: two ADEs for parallel coding agents',
  description:
    'Styx and Superset both run coding agents in parallel git worktrees. How they differ: production access, audit log, automations, remote machines, teams.',
  intro:
    'Styx and Superset (superset.sh, not Apache Superset) are both agentic development environments: apps where several coding agents work at once, each in its own git worktree, while you watch, review and merge. Superset leans towards automation and teams; Styx towards every project in one window and keeping agents away from your keys.',
  summary: [
    'Both run Claude Code, Codex and other agents in parallel, one worktree each.',
    'Superset adds scheduled automations, remote machines, an iOS app and team plans.',
    'Styx makes agents ask before touching production and keeps an append-only log.',
    'Both are free to start; Superset Pro is $20 per user per month.',
  ],
  cells: {
    runsOn: 'Mac; experimental Linux build; iOS app',
    agents: 'Any CLI agent: Claude Code, Codex, Cursor, OpenCode, Amp, Gemini',
    price: 'Free for one user; Pro $20/user/month; Enterprise custom',
    isolation: 'One git worktree per workspace',
    scope: 'Several repositories, each its own project',
    review: 'Diff viewer; stage, commit, push, open pull requests',
    editor: 'Opens workspaces in VS Code, Cursor, Xcode or JetBrains',
    secrets: 'Setup scripts copy .env files into each worktree',
    production: 'Not part of its docs',
    audit: 'Enterprise plan lists audit logs; scope not described',
    deploy: 'Not part of its docs',
    cloud: 'Reaches your own machines remotely; no hosted execution',
    team: 'Pro: unlimited members; Enterprise: SSO and SCIM',
    issues: 'Linear (Pro), GitHub; Slack (Pro)',
  },
  ahead: [
    {
      title: 'Automations',
      text: 'Scheduled agent runs for jobs like issue triage, changelogs and dependency bumps.',
    },
    {
      title: 'Remote and mobile',
      text: 'Workspaces on other machines keep running, and you can check on them from its iOS app.',
    },
    { title: 'Scripting', text: 'A CLI, a TypeScript SDK and an MCP server let you drive agents from code.' },
    { title: 'Teams', text: 'Paid plans add organisations, SSO and SCIM. Styx is for one person today.' },
  ],
  styxPoints: ['keys', 'projects', 'local'],
  choose: {
    them: 'you want scheduled automations, agents on remote machines, or seats for a team',
    styx: 'your agents need to get near production and you want them asking first, with a record of every approval',
  },
  faq: [
    {
      q: 'Is Styx a Superset alternative?',
      a: 'Yes. Both run coding agents in parallel, each in its own git worktree, on your Mac. Superset adds automations, remote machines and team plans; Styx adds a gate on production access and an append-only audit log.',
    },
    {
      q: 'Is this Apache Superset?',
      a: 'No. This page is about Superset at superset.sh, the app for running coding agents, not the Apache data visualisation project.',
    },
  ],
  sources: [
    { label: 'superset.sh', url: 'https://superset.sh' },
    { label: 'Superset pricing', url: 'https://superset.sh/pricing' },
    { label: 'Superset docs', url: 'https://docs.superset.sh' },
    { label: 'Superset setup and teardown scripts', url: 'https://docs.superset.sh/setup-teardown-scripts' },
    { label: 'Superset remote access', url: 'https://docs.superset.sh/remote-access' },
  ],
  checked: '29 September 2026',
};
