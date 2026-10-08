import { describe, expect, it } from 'vitest';
import { runnerFor } from './session-service';

/** Which runner a CLI gets, from the flags DetectService read off its `--help` (docs/research/agent-parity.md). */
describe('runnerFor', () => {
  it.each([
    ['claude', { streamJson: true }, 'stream'],
    ['claude', {}, 'pty'],
    ['codex', { appServer: true, configOverride: true }, 'stream'],
    ['codex', { configOverride: true }, 'pty'],
    ['gemini', { acp: true }, 'stream'],
    ['gemini', {}, 'pty'],
    ['cursor', { acp: true }, 'stream'],
    ['cursor', { streamJson: true, printMode: true }, 'stream'],
    ['cursor', { streamJson: true }, 'pty'],
    ['opencode', { acp: true }, 'stream'],
    // OpenCode's `run --format json` is not Claude's stream-json: without ACP it stays on the TUI.
    ['opencode', { streamJson: true, printMode: true }, 'pty'],
    ['opencode', {}, 'pty'],
    ['shell', {}, 'pty'],
  ] as const)('%s with %o → %s', (agent, capabilities, runner) => {
    expect(runnerFor(agent, { capabilities })).toBe(runner);
  });

  it('no CLI row at all → pty', () => {
    expect(runnerFor('codex', null)).toBe('pty');
  });
});
