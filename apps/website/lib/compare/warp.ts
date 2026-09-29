import type { Competitor } from './types';

export const warp: Competitor = {
  slug: 'warp',
  name: 'Warp',
  url: 'https://www.warp.dev',
  what: 'A terminal-first agentic development environment, with its own agent and cloud agents on the Oz platform.',
  title: 'Styx vs Warp: two agentic development environments',
  description:
    'Warp coined the ADE; Styx is one too. How they differ: terminal vs projects, cloud agents, team admin, and approvals before agents touch production.',
  intro:
    'Warp coined the term agentic development environment in 2025, and Styx is one too. Warp starts from the terminal and grows into cloud agents and team administration; Styx starts from your projects and the agents working in them, and puts a gate between those agents and production.',
  summary: [
    'Both run Claude Code, Codex, Gemini CLI and other agents side by side.',
    'Warp is a full terminal, with paid cloud agents, team admin and ticket triggers.',
    'Warp runs on Mac, Linux and Windows.',
    'Styx gives each agent its own worktree automatically and gates production access.',
  ],
  cells: {
    runsOn: 'Mac, Linux, Windows',
    agents: 'Warp’s agent, Claude Code, Codex, Gemini CLI, OpenCode, Amp, others',
    price: 'Free; Build $20/month; Max $200/month; Business $50/user/month',
    isolation: 'Worktree per agent recommended in its guides; Docker in the cloud',
    scope: 'Tabs across folders and branches',
    review: 'Side-by-side diffs of agent changes; pull request review bot',
    editor: 'Built-in file editor and review panel',
    secrets: 'Cloud agent secrets encrypted, injected as env vars',
    production: 'Admins set agent permissions; no deploy approval documented',
    audit: 'Secret use described as auditable; run and cost dashboards',
    deploy: 'Not part of its docs',
    cloud: 'Cloud agents in Warp’s cloud or your own',
    team: 'Warp Drive, admin controls, SSO on Business',
    issues: 'Linear, Jira, GitHub, GitLab, Slack, Azure DevOps',
  },
  ahead: [
    {
      title: 'Cloud agents',
      text: 'Its Oz platform runs and coordinates agents in Warp’s cloud or your own, while your laptop is closed.',
    },
    {
      title: 'Team governance',
      text: 'Admins manage permissions, data controls, SSO and spend in one place.',
    },
    { title: 'Triggers', text: 'Work can start from Slack, Linear, Jira or GitHub and report back there.' },
    {
      title: 'A real terminal',
      text: 'It replaces your terminal outright, on Linux and Windows as well as the Mac.',
    },
  ],
  styxPoints: ['keys', 'projects', 'editor'],
  choose: {
    them: 'you live in the terminal, want agents in the cloud, or need team administration',
    styx: 'you think in projects rather than terminal tabs and want agents to ask before they touch anything live',
  },
  faq: [
    {
      q: 'Is Styx a Warp alternative?',
      a: 'For running coding agents, yes: both run Claude Code, Codex and Gemini CLI side by side. Warp is also a full terminal with cloud agents and team admin; Styx gives each agent its own worktree and gates production access.',
    },
    {
      q: 'Did Warp invent the term ADE?',
      a: 'Yes. Warp’s CEO launched Warp 2.0 as “the first Agentic Development Environment” in June 2025.',
    },
  ],
  sources: [
    { label: 'warp.dev', url: 'https://www.warp.dev' },
    { label: 'Warp pricing', url: 'https://www.warp.dev/pricing' },
    {
      label: 'Warp: running multiple coding agents',
      url: 'https://docs.warp.dev/guides/agent-workflows/how-to-run-multiple-ai-coding-agents/',
    },
    { label: 'Warp cloud agent secrets', url: 'https://docs.warp.dev/platform/secrets/' },
    {
      label: 'Warp 2.0, the Agentic Development Environment',
      url: 'https://www.warp.dev/blog/reimagining-coding-agentic-development-environment',
    },
  ],
  checked: '29 September 2026',
};
