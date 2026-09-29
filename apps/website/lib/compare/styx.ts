import type { RowKey, StyxPoint } from './types';

/** Styx's column, the same on every comparison page. Keep it true to the shipped app. */
export const STYX_CELLS: Record<RowKey, string> = {
  runsOn: 'Mac (Apple silicon); Windows coming',
  agents: 'Claude Code, Codex, Gemini CLI, Cursor',
  price: 'Free',
  isolation: 'Own git worktree and branch',
  scope: 'Every project you work on',
  review: 'Diff with per-hunk accept and reject; checks before landing',
  editor: 'Imports recents, keybindings and theme; opens files back in it',
  secrets: 'In the macOS Keychain; agents get scoped, expiring access',
  production: 'Agents ask; you approve for a set time; Touch ID for live systems',
  audit: 'Every request, approval and use, append-only',
  deploy: 'Vercel, AWS, Google Cloud, Supabase, GitHub, SSH',
  cloud: 'No: everything runs on your Mac',
  team: 'No',
  issues: 'No',
};

/** The "Where Styx is different" sections, picked per page. */
export const STYX_POINTS: Record<StyxPoint, { title: string; text: string }> = {
  projects: {
    title: 'Every project, one window',
    text: 'Styx is built around switching between everything you work on: each project, its agents and the ones waiting on you, one keystroke apart. Nothing is organised around a single repository.',
  },
  keys: {
    title: 'Agents never hold your keys',
    text: 'Useful agents need real things: a deploy, a database, a server. In Styx the credentials stay in your Mac’s Keychain. When an agent wants production, it stops and asks; you approve it for a set time, with Touch ID for anything live, and the access ends on its own. Every request, approval and use goes into a log nobody can edit.',
  },
  editor: {
    title: 'On top of your editor',
    text: 'Styx brings in your editor’s recent projects, keybindings and theme, and opens any file back in it with one key. It is not trying to be the place you write code.',
  },
  local: {
    title: 'Everything stays on your Mac',
    text: 'Your code, prompts, agent conversations and credentials never reach a Styx server. Agents run on your machine, under your own agent subscriptions.',
  },
  agents: {
    title: 'Every agent, side by side',
    text: 'Claude Code, Codex, Gemini CLI and Cursor’s agent run next to each other in one board, on the subscriptions you already pay for, so you can pick the right agent per task instead of per tool.',
  },
};

/** Said on every page, because it is true of Styx whatever it is compared with. */
export const STYX_LIMIT =
  'One honest limit: this is a guardrail, not a sandbox. Agents run as you, on your Mac, and an agent that deliberately goes around Styx’s tools is not stopped by them.';

/** Questions every comparison can answer the same way. */
export const SHARED_FAQ = [
  {
    q: 'What is an agentic development environment (ADE)?',
    a: 'An app for managing AI agents that write code, rather than for writing code yourself: several agents in parallel, each isolated on its own branch, with a place to see who needs you and to review what they did. Warp coined the term in June 2025.',
  },
] as const;
