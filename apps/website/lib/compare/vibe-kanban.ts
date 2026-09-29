import type { Competitor } from './types';

export const vibeKanban: Competitor = {
  slug: 'vibe-kanban',
  name: 'Vibe Kanban',
  url: 'https://vibekanban.com',
  what: 'An open-source kanban board for running coding agents, community-maintained since its company shut down in 2026.',
  title: 'Styx vs Vibe Kanban: a Vibe Kanban alternative',
  description:
    'Vibe Kanban is now community-maintained. How Styx compares: parallel agents in worktrees, a native Mac app, and approvals before production.',
  intro:
    'Vibe Kanban is an open-source board for planning coding work as issues and handing each to an agent in its own worktree. Its company, Bloop, shut down in April 2026 and the project is now kept going by its community. Styx covers the same core, parallel agents in worktrees with review, as a native Mac app that is actively developed.',
  summary: [
    'Both run coding agents in parallel, one git worktree each, with diff review.',
    'Vibe Kanban is open source and board-first, with the widest agent list.',
    'Its company closed in April 2026; it is community-maintained and fully local now.',
    'Styx is actively developed and gates agents’ production access.',
  ],
  cells: {
    runsOn: 'A local web page (npx) or self-hosted with Docker',
    agents: 'Claude Code, Codex, Gemini CLI, Copilot, Cursor, Amp, OpenCode, more',
    price: 'Free and open source (Apache 2.0)',
    isolation: 'Git worktree, branch, terminal and dev server per workspace',
    scope: 'Board issues mapped to the repositories you pick',
    review: 'Diff with inline comments; pull requests or local merge',
    editor: 'Opens in your configured editor, including over SSH',
    secrets: 'Not part of its docs',
    production: 'Not part of its docs',
    audit: 'Not part of its docs',
    deploy: 'Not part of its docs',
    cloud: 'None since its servers shut down',
    team: 'Removed with the cloud shutdown',
    issues: 'Its own issues and sub-issues',
  },
  ahead: [
    { title: 'Open source', text: 'Apache 2.0 and self-hostable, so you can change or fork it.' },
    { title: 'More agents', text: 'It runs more agent CLIs, including Amp, Copilot and Qwen Code.' },
    { title: 'Board planning', text: 'Break work into issues and sub-issues before handing them out.' },
  ],
  styxPoints: ['keys', 'projects', 'editor'],
  choose: {
    them: 'you want free, open-source, board-first planning and are comfortable with community maintenance',
    styx: 'you want an actively developed Mac app for parallel agents, with production kept behind an approval',
  },
  faq: [
    {
      q: 'Is Vibe Kanban shut down?',
      a: 'Its company, Bloop, shut down on 10 April 2026 and ended the hosted features. The open-source app still runs locally and is maintained by its community.',
    },
    {
      q: 'What is a good Vibe Kanban alternative?',
      a: 'If you used Vibe Kanban to run agents in parallel worktrees, Styx does that as a native Mac app, with every project in one window and approvals before agents touch production.',
    },
  ],
  sources: [
    { label: 'Vibe Kanban on GitHub', url: 'https://github.com/BloopAI/vibe-kanban' },
    { label: 'vibekanban.com', url: 'https://vibekanban.com/' },
    { label: 'Vibe Kanban getting started', url: 'https://www.vibekanban.com/docs/getting-started' },
    { label: 'Vibe Kanban shutdown post', url: 'https://www.vibekanban.com/blog/shutdown' },
  ],
  checked: '29 September 2026',
};
