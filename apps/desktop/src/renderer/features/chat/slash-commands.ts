import { copy, type Session } from '@styx/core';
import type { PopupItem } from '@styx/ui';

/**
 * One-line hints for the Claude Code built-ins we can describe (owner addition, docs/handoff-discrepancies #57).
 * The list of commands itself comes from the CLI (`Session.slashCommands`), so skills and plugins appear too;
 * anything not named here shows without a hint.
 */
const HINTS: Readonly<Record<string, string>> = {
  agents: 'Manage subagents',
  clear: 'Clear the conversation and start fresh',
  compact: 'Summarise the conversation to free context',
  config: 'Open Claude Code settings',
  context: 'Show what is using the context window',
  cost: 'Show token cost for this session',
  effort: 'Set the reasoning effort level',
  init: 'Write a CLAUDE.md for this project',
  insights: 'Show usage insights',
  mcp: 'List MCP servers and their tools',
  model: 'Switch the model for this session',
  permissions: 'Review tool permission rules',
  recap: 'Recap what happened in this session',
  usage: 'Show plan usage and limits',
};

/** `/name` rows for the composer popup, filtered by prefix then subsequence, best first. */
export const slashItems = (session: Session | null, query: string): PopupItem[] => {
  const names = session?.slashCommands ?? [];
  const q = query.trim().toLowerCase();
  const scored: { name: string; rank: number }[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (q === '') scored.push({ name, rank: 0 });
    else if (lower.startsWith(q)) scored.push({ name, rank: 0 });
    else if (lower.includes(q)) scored.push({ name, rank: 1 });
    else if (subsequence(lower, q)) scored.push({ name, rank: 2 });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, 50)
    .map(({ name }) => {
      const hint = HINTS[name];
      return { id: name, label: `/${name}`, ...(hint !== undefined ? { hint } : {}) };
    });
};

const subsequence = (text: string, query: string): boolean => {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return i === query.length;
};

/** `@path` rows from `fs.find`. */
export const mentionItems = (paths: readonly string[]): PopupItem[] =>
  paths.map((path) => ({ id: path, label: path }));

export const slashHint = (): string => copy.chat.slash.hint;
