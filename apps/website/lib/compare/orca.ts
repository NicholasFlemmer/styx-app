import type { Competitor } from './types';

export const orca: Competitor = {
  slug: 'orca',
  name: 'Orca',
  url: 'https://www.onorca.dev',
  what: 'An open-source (MIT) environment for running a fleet of CLI coding agents in parallel, on any OS.',
  title: 'Styx vs Orca: comparing two ADEs for coding agents',
  description:
    'Styx and Orca both run coding agents in parallel git worktrees. How they differ: phone apps, diff comments, servers and production access.',
  intro:
    'Styx and Orca are both agentic development environments: a fleet of coding agents, one git worktree each, with a place to review what they changed. Orca is MIT-licensed, cross-platform and strong on the review loop; Styx focuses on every project in one window and on what agents are allowed to reach.',
  summary: [
    'Both run coding agents in parallel, one git worktree per task.',
    'Both are open source: Orca under MIT, Styx under Apache 2.0. Orca adds phone apps.',
    'Orca sends line-by-line diff comments back to the agent.',
    'Styx gates production access and keeps an append-only log of every approval.',
  ],
  cells: {
    runsOn: 'Mac, Windows, Linux; iOS and Android companions',
    agents: '27 presets incl. Claude Code, Codex, Gemini, Cursor, Copilot; any CLI',
    price: 'Free, MIT-licensed',
    isolation: 'One git worktree per task, with its own terminal and browser tab',
    scope: 'A folder holding several repositories',
    review: 'Diff viewer; inline comments go back to the agent; CI and PR review',
    editor: 'Built-in VS Code-style editor',
    secrets: 'Setup scripts usually copy .env files into worktrees',
    production: 'Not part of its docs',
    audit: 'Usage dashboard (agents spawned, time, pull requests)',
    deploy: 'Not part of its docs',
    cloud: 'SSH remote worktrees; self-hosted headless server',
    team: 'Account switcher and usage tracking',
    issues: 'GitHub, Linear, Jira',
  },
  ahead: [
    {
      title: 'Diff comments',
      text: 'Comment on a line of the diff and the agent gets it as its next instruction.',
    },
    {
      title: 'Every platform, and your phone',
      text: 'It runs on Windows and Linux too, with iOS and Android apps for keeping an eye on agents.',
    },
    {
      title: 'Headless',
      text: '`orca serve` runs the whole thing on a server, and SSH worktrees reconnect by themselves.',
    },
  ],
  styxPoints: ['keys', 'projects', 'editor'],
  choose: {
    them: 'you want a phone app, comments on the diff that go straight to the agent, or agents running on a server',
    styx: 'you want agents working near production without holding your credentials',
  },
  faq: [
    {
      q: 'Is Styx an Orca alternative?',
      a: 'Yes. Both run coding agents in parallel, each in its own git worktree. Both are open source. Orca is strong on the review loop and has phone apps; Styx adds a gate on production access and an append-only audit log.',
    },
  ],
  sources: [
    { label: 'onorca.dev', url: 'https://www.onorca.dev' },
    { label: 'Orca docs', url: 'https://www.onorca.dev/docs' },
    { label: 'Orca worktrees', url: 'https://www.onorca.dev/docs/model/worktrees' },
    { label: 'Orca on GitHub', url: 'https://github.com/stablyai/orca' },
  ],
  checked: '29 September 2026',
};
