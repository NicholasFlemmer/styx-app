import type { Competitor } from './types';

export const nimbalyst: Competitor = {
  slug: 'nimbalyst',
  name: 'Nimbalyst',
  url: 'https://nimbalyst.com',
  what: 'An open-source visual workspace for Claude Code and Codex, with visual editors, task tracking and team editing.',
  title: 'Styx vs Nimbalyst: two workspaces for coding agents',
  description:
    'Styx and Nimbalyst both give Claude Code and Codex a desktop home. How they differ: visual editors, multiplayer, task tracking and production access.',
  intro:
    'Styx and Nimbalyst both put coding agents like Claude Code and Codex in a desktop app with parallel sessions and review. Nimbalyst is built around documents, visual editors and shared team work; Styx around every project in one window and keeping agents away from your production keys.',
  summary: [
    'Both run Claude Code and Codex sessions in parallel with per-edit review.',
    'Nimbalyst adds visual editors for docs, mockups and diagrams, and real-time team editing.',
    'Nimbalyst runs on Mac, Windows and Linux and is open source.',
    'Styx runs four agents side by side and gates their production access.',
  ],
  cells: {
    runsOn: 'Mac, Windows, Linux; iOS companion',
    agents: 'Claude Code, Codex; OpenCode, Copilot in alpha; Gemini',
    price: 'Free for individuals; Teams $20/user/month; Enterprise custom',
    isolation: 'Optional git worktree per session',
    scope: 'Not part of its docs',
    review: 'Red and green per-edit accept or reject; merge in the app',
    editor: 'Built-in code editor plus visual markdown, mockup and diagram editors',
    secrets: 'Not part of its docs',
    production: 'Not part of its docs',
    audit: 'Not part of its docs',
    deploy: 'Not part of its docs',
    cloud: 'Not part of its docs; runs on your computer',
    team: 'Real-time shared docs, trackers, kanban and chat',
    issues: 'Built-in task tracker',
  },
  ahead: [
    {
      title: 'Visual editing',
      text: 'WYSIWYG editors for markdown, mockups and diagrams, each with the same AI diff review as code.',
    },
    { title: 'Multiplayer', text: 'Real-time shared documents, trackers and boards on its Teams plan.' },
    {
      title: 'Task tracking',
      text: 'Agents read and update plans, bugs and to-dos in its built-in trackers.',
    },
    {
      title: 'Every platform',
      text: 'It ships for Windows and Linux as well as the Mac.',
    },
  ],
  styxPoints: ['keys', 'agents', 'projects'],
  choose: {
    them: 'your agent work centres on documents, mockups and plans, or you want to edit with your team in real time',
    styx: 'you want four agents side by side across every project and nothing reaching production without your OK',
  },
  faq: [
    {
      q: 'Is Styx a Nimbalyst alternative?',
      a: 'Partly. Both give Claude Code and Codex a desktop app with parallel sessions and review. Nimbalyst is stronger on visual documents and team editing; Styx on running several agents across projects and gating production access.',
    },
  ],
  sources: [
    { label: 'nimbalyst.com', url: 'https://nimbalyst.com' },
    { label: 'Nimbalyst pricing', url: 'https://nimbalyst.com/pricing' },
    { label: 'Nimbalyst features', url: 'https://nimbalyst.com/features/' },
    { label: 'Nimbalyst worktrees', url: 'https://docs.nimbalyst.com/developer-features/worktrees' },
    { label: 'Nimbalyst on GitHub', url: 'https://github.com/nimbalyst/nimbalyst' },
  ],
  checked: '29 September 2026',
};
