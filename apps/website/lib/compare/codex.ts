import type { Competitor } from './types';

export const codex: Competitor = {
  slug: 'codex',
  name: 'the Codex app',
  url: 'https://chatgpt.com/codex/',
  what: 'Codex in the ChatGPT desktop app: OpenAI’s place to run Codex agents in parallel across projects.',
  title: 'Styx vs the Codex app in ChatGPT',
  description:
    'The Codex app runs parallel Codex agents; Styx runs Codex next to Claude Code, Gemini and Cursor. How they differ on cloud tasks and production access.',
  intro:
    'OpenAI’s Codex app, now part of the ChatGPT desktop app, runs several Codex agents at once across your projects, locally or in OpenAI’s cloud. Styx runs Codex too, under the same ChatGPT login, next to Claude Code, Gemini CLI and Cursor’s agent, with a gate in front of production.',
  summary: [
    'Both run Codex agents in parallel, each in its own git worktree.',
    'The Codex app adds cloud tasks, scheduled automations and careful handling of cloud secrets.',
    'Styx runs other companies’ agents next to Codex.',
    'Styx makes agents ask before touching production and logs every approval.',
  ],
  cells: {
    runsOn: 'Mac (Apple silicon), Windows, Linux',
    agents: 'Codex only',
    price: 'Included with ChatGPT, from the free and $8 plans up',
    isolation: 'Built-in git worktrees with setup scripts; cloud environments',
    scope: 'Projects and threads across many repositories',
    review: 'Diff with inline comments; stage, revert, commit, pull requests',
    editor: 'Opens changes in your editor',
    secrets: 'Cloud secrets hidden from the agent after setup',
    production: 'Sandbox and approval modes; no internet by default in the cloud',
    audit: 'Compliance API on Business and Enterprise',
    deploy: 'Not part of its docs',
    cloud: 'Cloud tasks, within your plan’s allowance',
    team: 'Shared project config; admin tools on Business and Enterprise',
    issues: 'GitHub, Slack and Linear through plugins',
  },
  ahead: [
    { title: 'Cloud tasks', text: 'Agents can run in OpenAI’s cloud with controlled internet access.' },
    { title: 'Automations', text: 'Scheduled tasks drop their results into a review queue.' },
    {
      title: 'Cloud secrets',
      text: 'Secrets reach setup scripts only and are removed before the agent runs.',
    },
    { title: 'Comes with ChatGPT', text: 'It is included even on ChatGPT’s free and $8 plans.' },
  ],
  styxPoints: ['agents', 'keys', 'projects'],
  choose: {
    them: 'Codex is the only agent you use and you want OpenAI’s cloud tasks and automations',
    styx: 'you run Codex alongside Claude Code, Gemini or Cursor, or want production kept behind an approval with a record',
  },
  faq: [
    {
      q: 'Does Styx use my ChatGPT subscription for Codex?',
      a: 'Yes. Styx runs the Codex CLI under your own ChatGPT login, so there is nothing extra to pay.',
    },
    {
      q: 'Is the Codex app the same as the ChatGPT desktop app?',
      a: 'Codex now lives inside the ChatGPT desktop app; OpenAI’s older Codex app pages redirect there.',
    },
  ],
  sources: [
    { label: 'ChatGPT desktop app docs', url: 'https://learn.chatgpt.com/docs/app' },
    { label: 'Codex pricing', url: 'https://learn.chatgpt.com/docs/pricing' },
    {
      label: 'Codex local environments',
      url: 'https://learn.chatgpt.com/docs/environments/local-environment',
    },
    { label: 'Codex cloud environments', url: 'https://developers.openai.com/codex/cloud/environments' },
  ],
  checked: '29 September 2026',
};
