import type { Competitor } from './types';

export const kepler: Competitor = {
  slug: 'kepler',
  name: 'GitKraken Kepler',
  url: 'https://www.gitkraken.com/lp/project-kepler',
  what: 'GitKraken’s agentic development environment, in public preview, where one task can span several repositories.',
  title: 'Styx vs GitKraken Kepler: two ADEs compared',
  description:
    'Styx and GitKraken Kepler are both ADEs for parallel coding agents. How they differ: tasks across repos, issue trackers, platforms and production access.',
  intro:
    'GitKraken Kepler and Styx are both agentic development environments: several coding agents in parallel, each in a git worktree, with review before anything merges. Kepler is built around tasks that start in your backlog and span several repositories; Styx around every project in one window and keeping agents away from your keys.',
  summary: [
    'Both run Claude Code, Codex, Gemini, Cursor and more in parallel worktrees.',
    'Kepler lets one task open a worktree in every repository it touches.',
    'Kepler pulls work from Jira, Linear, GitHub, GitLab and others, on any OS.',
    'Styx gates production access and keeps an append-only log. Kepler is in preview.',
  ],
  cells: {
    runsOn: 'Mac, Windows, Linux',
    agents: 'Claude Code, Codex, Copilot, Cursor, Gemini, OpenCode, any ACP agent',
    price: 'Free in public preview with a GitKraken account',
    isolation: 'A git worktree per repository, per task',
    scope: 'One task can span several repositories',
    review: 'Diff overlay, branch sync, AI commit composing, PR review queue',
    editor: 'Hands off to GitKraken Desktop',
    secrets: 'Not part of its docs',
    production: 'Permission prompts by default; no deploy approval documented',
    audit: 'Not part of its docs',
    deploy: 'Not part of its docs',
    cloud: 'No hosted cloud; SSH or WSL',
    team: 'Team features not shipped yet',
    issues: 'Jira, Trello, Linear, GitHub, GitLab, Azure DevOps, Bitbucket',
  },
  ahead: [
    {
      title: 'Tasks across repositories',
      text: 'One task opens a worktree in each repository it needs, with shared instructions.',
    },
    {
      title: 'Starts from your backlog',
      text: 'It pulls assigned issues and pull requests from most trackers and git hosts.',
    },
    { title: 'Every platform', text: 'It runs on Windows and Linux as well as the Mac.' },
    {
      title: 'More agents',
      text: 'Any agent that speaks the Agent Client Protocol, including Copilot and OpenCode.',
    },
  ],
  styxPoints: ['keys', 'projects', 'editor'],
  choose: {
    them: 'your tasks span several repositories and start in Jira or Linear, or you already live in GitKraken',
    styx: 'you want a finished Mac app across all your projects, with agents asking before they touch production',
  },
  faq: [
    {
      q: 'Is Styx a GitKraken Kepler alternative?',
      a: 'Yes. Both are agentic development environments for running coding agents in parallel worktrees. Kepler is stronger on multi-repository tasks and issue trackers; Styx on production access and working across projects.',
    },
    {
      q: 'Is Kepler finished?',
      a: 'Kepler was in public preview on 29 September 2026, free with a GitKraken account; pricing after the preview had not been announced.',
    },
  ],
  sources: [
    {
      label: 'Kepler public preview',
      url: 'https://gitkraken.com/blog/kepler-is-in-public-preview-one-task-every-repo-every-agent',
    },
    { label: 'Kepler release notes', url: 'https://gitkraken.com/blog/big-kepler-release' },
    { label: 'Kepler getting started', url: 'https://help.gitkraken.com/kepler/kepler-getting-started/' },
  ],
  checked: '29 September 2026',
};
