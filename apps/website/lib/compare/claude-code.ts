import type { Competitor } from './types';

export const claudeCode: Competitor = {
  slug: 'claude-code',
  name: 'Claude Code desktop',
  url: 'https://code.claude.com/docs/en/desktop',
  what: 'The Code tab in Anthropic’s Claude desktop app, running parallel Claude Code sessions locally or in the cloud.',
  title: 'Styx vs the Claude Code desktop app',
  description:
    'The Claude Code desktop app runs parallel Claude sessions; Styx runs Claude Code next to Codex, Gemini and Cursor. How they differ on production access.',
  intro:
    'Anthropic’s Claude desktop app has a Code tab that runs several Claude Code sessions at once, each in its own worktree. Styx runs Claude Code too, through the same login, alongside Codex, Gemini CLI and Cursor’s agent, across every project, with a gate in front of production.',
  summary: [
    'Both run parallel Claude Code sessions, each in its own git worktree.',
    'The Claude app adds cloud and SSH sessions, CI follow-through and a built-in preview.',
    'Styx runs other companies’ agents next to Claude Code.',
    'Styx makes agents ask before touching production and logs every approval.',
  ],
  cells: {
    runsOn: 'Mac, Windows; Linux in beta',
    agents: 'Claude Code only',
    price: 'Needs a paid Claude plan: Pro $20, Max from $100/month',
    isolation: 'Git worktree per session; cloud, SSH or WSL',
    scope: 'A sidebar of sessions, one folder each',
    review: 'Diffs with comments; pull request checks, auto-fix, auto-merge',
    editor: 'Built-in editor and terminal; opens in VS Code, Cursor or Zed',
    secrets: 'Local variables stored encrypted; separate cloud environments',
    production: 'Permission modes for edits and commands; no deploy approval',
    audit: 'Compliance API on Enterprise',
    deploy: 'Not part of its docs',
    cloud: 'Cloud sessions keep running after the app closes',
    team: 'Team and Enterprise plans with admin controls',
    issues: 'GitHub and Linear through connectors',
  },
  ahead: [
    {
      title: 'Cloud and SSH sessions',
      text: 'The same sessions run on your Mac, in Anthropic’s cloud or on your own server.',
    },
    {
      title: 'CI follow-through',
      text: 'It watches pull request checks, fixes failures and merges when they pass.',
    },
    {
      title: 'Built-in preview',
      text: 'A browser pane and an iOS Simulator pane let Claude check its own work.',
    },
    {
      title: 'Everywhere',
      text: 'It runs on Windows, with Linux in beta, and you can send tasks from your phone.',
    },
  ],
  styxPoints: ['agents', 'keys', 'projects'],
  choose: {
    them: 'Claude is the only agent you use and you want cloud sessions and CI follow-through from Anthropic itself',
    styx: 'you use Claude Code alongside Codex, Gemini or Cursor, or want production kept behind an approval with a record',
  },
  faq: [
    {
      q: 'Does Styx use my Claude subscription?',
      a: 'Yes. Styx runs the Claude Code CLI you already have, under your own Claude login, so there is nothing extra to pay.',
    },
    {
      q: 'Is Styx a Claude Code alternative?',
      a: 'No. Styx runs Claude Code; it is an alternative to the desktop app around it, useful when you also run other agents or want production access gated.',
    },
  ],
  sources: [
    { label: 'Claude Code desktop docs', url: 'https://code.claude.com/docs/en/desktop' },
    { label: 'Claude Code worktrees', url: 'https://code.claude.com/docs/en/worktrees' },
    { label: 'Claude pricing', url: 'https://claude.com/pricing' },
    {
      label: 'Compliance API and Claude Code',
      url: 'https://claude.com/blog/compliance-api-cowork-and-claude-code',
    },
  ],
  checked: '29 September 2026',
};
