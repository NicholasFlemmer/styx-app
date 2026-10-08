import { copy, fill } from '../copy';
import type { AgentSetup, SetupAgent, SetupProblem, SetupStep } from '../model/agent-setup';
import { SETUP_AGENTS, SETUP_STEPS, isSetupAgent } from '../model/agent-setup';
import type { Agent } from '../model/common';
import type { CliInstall } from '../model/discovery';
import type { ReadModel } from '../read-model';
import { cliSourceOf } from './discovery';

/** Where a card stands, in the words its badge uses. */
export type AgentCardState = 'ready' | 'signed-out' | 'not-installed' | 'working' | 'problem';

/** The one button a card offers (design: one per card). */
export type AgentCardAction = 'set-up' | 'sign-in' | 'update' | 'retry' | 'see-plans';

export interface AgentCardCheck {
  key: 'found' | SetupStep;
  state: 'done' | 'now' | 'todo';
  text: string;
  meta: string | null;
}

export interface AgentCard {
  agent: SetupAgent;
  name: string;
  plan: string;
  state: AgentCardState;
  /** The badge text ("Ready", "Signing in", "Needs a plan"). */
  badge: string;
  /** One sentence when there is no checklist to show (not set up, signed out, a problem). */
  what: string | null;
  checks: AgentCardCheck[];
  primary: { action: AgentCardAction; label: string } | null;
  /** The run in flight or last finished; null before any. */
  setup: AgentSetup | null;
}

const NAME = (agent: SetupAgent): string => copy.agentSetup.names[agent];
const PRODUCT = (agent: SetupAgent): string => copy.agentProducts[agent];
const seconds = (ms: number): string => (ms / 1000).toFixed(1);

const cliOf = (model: ReadModel, agent: SetupAgent): CliInstall | null =>
  model.discovery.clis.find((c) => c.agent === agent) ?? null;

/** Installed and signed in, as the CLI last said (a run that ended on a problem is not ready). */
export const isAgentReady = (model: ReadModel, agent: Exclude<Agent, 'shell'>): boolean => {
  const cli = model.discovery.clis.find((c) => c.agent === agent) ?? null;
  const setup = isSetupAgent(agent) ? model.agentSetup[agent] : undefined;
  if (setup !== undefined && setup.status === 'failed') return false;
  return cli !== null && cli.found && cli.authState === 'signed-in';
};

/** An agent's name in the setup and sign-in words: the plan's name for a card agent ("ChatGPT"), else its own. */
export const agentSetupName = (agent: Exclude<Agent, 'shell'>): string =>
  isSetupAgent(agent) ? copy.agentSetup.names[agent] : copy.agents[agent];

/** The agents that would answer right now, in the cards' order. */
export const readyAgents = (model: ReadModel): SetupAgent[] =>
  SETUP_AGENTS.filter((a) => isAgentReady(model, a));

/**
 * New task's starting agent (owner request: "starts with an agent that works"): the preferred one when it is
 * ready, else the first that is, else the preferred one anyway (its chip then offers Set up).
 */
export const startingAgent = <A extends string>(model: ReadModel, preferred: A): A | SetupAgent => {
  const ready = readyAgents(model);
  if (ready.some((a) => a === preferred) || ready.length === 0) return preferred;
  return ready[0] ?? preferred;
};

const PROBLEM_ACTION: Record<SetupProblem, AgentCardAction> = {
  'prepare-failed': 'retry',
  'install-failed': 'retry',
  signin: 'sign-in',
  'needs-plan': 'see-plans',
  limit: 'retry',
  'out-of-date': 'update',
  'test-failed': 'retry',
};

const actionLabel = (agent: SetupAgent, action: AgentCardAction): string => {
  const a = copy.agentSetup.actions;
  switch (action) {
    case 'set-up':
      return fill(a.setUp, { name: NAME(agent) });
    case 'sign-in':
      return fill(a.signIn, { name: NAME(agent) });
    case 'update':
      return fill(a.update, { product: PRODUCT(agent) });
    case 'retry':
      return a.retry;
    case 'see-plans':
      return a.seePlans;
  }
};

const foundCheck = (cli: CliInstall): AgentCardCheck => ({
  key: 'found',
  state: 'done',
  text: fill(copy.agentSetup.checks.found, { where: copy.cliSources[cliSourceOf(cli) ?? 'path'] }),
  meta: cli.version,
});

const signedInText = (account: string | null): string =>
  account === null ? copy.agentSetup.checks.signedIn : fill(copy.agentSetup.checks.signedInAs, { account });

/** The checklist of a run in flight: done steps with what they learned, the current one, then what is left. */
const runChecks = (agent: SetupAgent, setup: AgentSetup, cli: CliInstall | null): AgentCardCheck[] => {
  const c = copy.agentSetup.checks;
  const at = SETUP_STEPS.indexOf(setup.step);
  const out: AgentCardCheck[] = [];
  for (const step of SETUP_STEPS) {
    const i = SETUP_STEPS.indexOf(step);
    if (step === 'prepare' && setup.preparing === null) continue;
    const state: AgentCardCheck['state'] = i < at ? 'done' : i === at ? 'now' : 'todo';
    switch (step) {
      case 'prepare':
        out.push({ key: step, state, text: fill(c.prepare, { what: setup.preparing ?? '' }), meta: null });
        break;
      case 'install':
        if (setup.installedVersion === null && cli?.found === true && state === 'done') {
          out.push({ ...foundCheck(cli), key: 'install' });
          break;
        }
        out.push({
          key: step,
          state,
          text: fill(state === 'done' ? c.installed : c.install, { product: PRODUCT(agent) }),
          meta:
            state === 'done' && setup.installMs !== null
              ? fill(c.installedMeta, {
                  version: setup.installedVersion ?? cli?.version ?? '',
                  s: seconds(setup.installMs),
                })
              : null,
        });
        break;
      case 'signin':
        out.push({
          key: step,
          state,
          text:
            state === 'done'
              ? signedInText(cli?.account ?? null)
              : fill(c.signin, { account: copy.agentSetup.accounts[agent] }),
          meta: state === 'now' && setup.status === 'waiting' ? c.waitingBrowser : null,
        });
        break;
      case 'test':
        out.push({ key: step, state, text: c.test, meta: null });
        break;
    }
  }
  return out;
};

/** Everything one card shows (design frames 1–3), from detection and the setup run. */
export const agentCard = (model: ReadModel, agent: SetupAgent): AgentCard => {
  const cli = cliOf(model, agent);
  const setup = model.agentSetup[agent] ?? null;
  const s = copy.agentSetup;
  const base = { agent, name: NAME(agent), plan: s.plans[agent], setup };
  if (setup !== null && (setup.status === 'running' || setup.status === 'waiting'))
    return {
      ...base,
      state: 'working',
      badge: s.state.steps[setup.step],
      what: null,
      checks: runChecks(agent, setup, cli),
      primary: null,
    };
  if (setup !== null && setup.status === 'failed' && setup.problem !== null) {
    const action = PROBLEM_ACTION[setup.problem];
    return {
      ...base,
      state: 'problem',
      badge: s.state.problems[setup.problem],
      what: setup.message,
      checks: [],
      primary: { action, label: actionLabel(agent, action) },
    };
  }
  if (cli === null || !cli.found)
    return {
      ...base,
      state: 'not-installed',
      badge: s.state.notSetUp,
      what: agent === 'gemini' ? s.what.notInstalledGemini : s.what.notInstalled,
      checks: [],
      primary: { action: 'set-up', label: actionLabel(agent, 'set-up') },
    };
  if (cli.authState !== 'signed-in')
    return {
      ...base,
      state: 'signed-out',
      badge: s.state.signedOut,
      what: s.what.signedOut,
      checks: [foundCheck(cli)],
      primary: { action: 'sign-in', label: actionLabel(agent, 'sign-in') },
    };
  const checks: AgentCardCheck[] = [
    foundCheck(cli),
    { key: 'signin', state: 'done', text: signedInText(cli.account), meta: null },
  ];
  if (setup !== null && setup.status === 'done' && setup.testedMs !== null)
    checks.push({
      key: 'test',
      state: 'done',
      text: fill(s.checks.tested, { s: seconds(setup.testedMs) }),
      meta: null,
    });
  return { ...base, state: 'ready', badge: s.state.ready, what: null, checks, primary: null };
};

export const agentCards = (model: ReadModel): AgentCard[] => SETUP_AGENTS.map((a) => agentCard(model, a));

/** The line under the cards: what is ready, what is still going, or a nudge (never a block). */
export const agentSetupFoot = (model: ReadModel): string => {
  const f = copy.agentSetup.foot;
  const working = SETUP_AGENTS.find((a) => {
    const st = model.agentSetup[a]?.status;
    return st === 'running' || st === 'waiting';
  });
  const ready = readyAgents(model)[0];
  if (ready !== undefined && working === undefined) return fill(f.ready, { name: NAME(ready) });
  if (working !== undefined) return fill(f.working, { name: NAME(working) });
  return f.none;
};
