import { describe, expect, it } from 'vitest';
import { DEMO_NOW, demoReadModel, errorReadModel } from '../fixtures/demo';
import type { AgentSetup, SetupAgent } from '../model/agent-setup';
import type { ReadModel } from '../read-model';
import {
  agentCard,
  agentCards,
  agentSetupFoot,
  isAgentReady,
  readyAgents,
  startingAgent,
} from './agent-setup';

const run = (agent: SetupAgent, over: Partial<AgentSetup> = {}): AgentSetup => ({
  agent,
  status: 'running',
  step: 'install',
  preparing: null,
  installedVersion: null,
  installMs: null,
  testedMs: null,
  url: null,
  wantsCode: false,
  problem: null,
  message: null,
  terminalId: null,
  startedAt: DEMO_NOW,
  updatedAt: DEMO_NOW,
  ...over,
});

const withRun = (model: ReadModel, setup: AgentSetup): ReadModel => ({
  ...model,
  agentSetup: { ...model.agentSetup, [setup.agent]: setup },
});

/** The error fixture: Claude and Cursor signed in, Codex missing, Gemini installed and signed out. */
const base = errorReadModel;

describe('agent setup cards (design/next/styx-next-agent-setup.html)', () => {
  it('reads each plan from detection: ready, not set up, signed out; one button only where something is missing', () => {
    const cards = agentCards(base());
    expect(cards.map((c) => [c.agent, c.state, c.badge, c.primary?.action ?? null])).toEqual([
      ['claude', 'ready', 'Ready', null],
      ['codex', 'not-installed', 'Not set up', 'set-up'],
      ['gemini', 'signed-out', 'Signed out', 'sign-in'],
      ['cursor', 'ready', 'Ready', null],
    ]);
    expect(cards.map((c) => c.name)).toEqual(['Claude', 'ChatGPT', 'Gemini', 'Cursor']);
    expect(cards[1]?.what).toBe('Not on this computer yet. Takes about a minute.');
    expect(cards[1]?.primary?.label).toBe('Set up ChatGPT');
    expect(cards[2]?.primary?.label).toBe('Sign in to Gemini');
    expect(cards[2]?.checks.map((c) => c.key)).toEqual(['found']);
    // A ready card lists where it was found and who is signed in.
    expect(cards[0]?.checks.map((c) => [c.key, c.state])).toEqual([
      ['found', 'done'],
      ['signin', 'done'],
    ]);
    expect(cards[0]?.checks[0]?.text).toMatch(/^On this computer · /);
  });

  it('Gemini not installed says it needs Node.js, which Styx sets up', () => {
    const m = base();
    const gone = {
      ...m,
      discovery: {
        ...m.discovery,
        clis: m.discovery.clis.map((c) => (c.agent === 'gemini' ? { ...c, found: false } : c)),
      },
    };
    expect(agentCard(gone, 'gemini').what).toMatch(/Needs Node\.js/);
    // An agent detection never listed reads as not set up too.
    const none = { ...m, discovery: { ...m.discovery, clis: [] } };
    expect(agentCard(none, 'claude').state).toBe('not-installed');
  });

  it('a run in flight is a checklist: done steps with what they learned, the current one, then what is left', () => {
    const m = withRun(base(), run('codex', { step: 'prepare', preparing: 'Git' }));
    const prep = agentCard(m, 'codex');
    expect(prep.state).toBe('working');
    expect(prep.badge).toBe('Getting ready');
    expect(prep.primary).toBeNull();
    expect(prep.checks.map((c) => [c.key, c.state, c.text])).toEqual([
      ['prepare', 'now', 'Set up Git'],
      ['install', 'todo', 'Install Codex'],
      ['signin', 'todo', 'Sign in with your ChatGPT account'],
      ['test', 'todo', 'Send a test message'],
    ]);
    const signing = agentCard(
      withRun(
        base(),
        run('codex', { step: 'signin', status: 'waiting', installedVersion: '0.46.0', installMs: 38_000 }),
      ),
      'codex',
    );
    expect(signing.badge).toBe('Signing in');
    expect(signing.checks.map((c) => [c.key, c.state, c.meta])).toEqual([
      ['install', 'done', '0.46.0 · 38.0s'],
      ['signin', 'now', 'waiting for your browser'],
      ['test', 'todo', null],
    ]);
    // An agent that was already installed shows where it was found instead of an install line.
    const found = agentCard(withRun(base(), run('gemini', { step: 'test' })), 'gemini');
    expect(found.checks.map((c) => [c.key, c.state])).toEqual([
      ['install', 'done'],
      ['signin', 'done'],
      ['test', 'now'],
    ]);
    expect(found.checks[0]?.text).toMatch(/^On this computer · /);
    expect(found.checks[1]?.text).toBe('Signed in');
    // Running (not waiting) sign-in has no "waiting for your browser" note; an install with no timing has no meta.
    const quiet = agentCard(withRun(base(), run('codex', { step: 'signin' })), 'codex');
    expect(quiet.checks.map((c) => c.meta)).toEqual([null, null, null]);
  });

  it('a problem is one sentence with the one fix', () => {
    const cases: [AgentSetup['problem'], string, string][] = [
      ['needs-plan', 'see-plans', 'See plans'],
      ['out-of-date', 'update', 'Update Codex'],
      ['signin', 'sign-in', 'Sign in to ChatGPT'],
      ['limit', 'retry', 'Try again'],
      ['prepare-failed', 'retry', 'Try again'],
      ['install-failed', 'retry', 'Try again'],
      ['test-failed', 'retry', 'Try again'],
    ];
    for (const [problem, action, label] of cases) {
      const card = agentCard(
        withRun(base(), run('codex', { status: 'failed', problem, message: 'Why.' })),
        'codex',
      );
      expect([card.state, card.primary?.action, card.primary?.label, card.what]).toEqual([
        'problem',
        action,
        label,
        'Why.',
      ]);
    }
    // A failed run is not ready, even when the CLI says it is signed in.
    const failed = withRun(base(), run('claude', { status: 'failed', problem: 'limit', message: 'Out.' }));
    expect(isAgentReady(failed, 'claude')).toBe(false);
    expect(readyAgents(failed)).toEqual(['cursor']);
  });

  it('a finished run adds the test result; a cancelled one falls back to what detection says', () => {
    const done = agentCard(
      withRun(base(), run('claude', { status: 'done', step: 'test', testedMs: 2_100 })),
      'claude',
    );
    expect(done.checks.at(-1)?.text).toBe('Tested: it answered in 2.1s');
    const doneNoTest = agentCard(withRun(base(), run('claude', { status: 'done', step: 'test' })), 'claude');
    expect(doneNoTest.checks).toHaveLength(2);
    expect(agentCard(withRun(base(), run('codex', { status: 'cancelled' })), 'codex').state).toBe(
      'not-installed',
    );
    // A failed run without a problem (never published that way) is read from detection.
    expect(agentCard(withRun(base(), run('codex', { status: 'failed' })), 'codex').state).toBe(
      'not-installed',
    );
  });

  it('New task starts with an agent that works: the preferred one when ready, else the first ready, else the preferred', () => {
    expect(startingAgent(base(), 'claude')).toBe('claude');
    expect(startingAgent(base(), 'codex')).toBe('claude');
    expect(startingAgent(base(), 'shell')).toBe('claude');
    const nobody = { ...base(), discovery: { ...base().discovery, clis: [] } };
    expect(startingAgent(nobody, 'codex')).toBe('codex');
  });

  it('the line under the cards: ready, still going, or a nudge', () => {
    expect(agentSetupFoot(base())).toBe('Claude is ready. That’s enough to start.');
    expect(agentSetupFoot(withRun(base(), run('codex', { status: 'waiting', step: 'signin' })))).toBe(
      'ChatGPT finishes in the background; you can continue.',
    );
    const nobody = { ...demoReadModel(), discovery: { ...demoReadModel().discovery, clis: [] } };
    expect(agentSetupFoot(nobody)).toMatch(/^Set up one to start a task/);
  });
});
