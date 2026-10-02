/**
 * The hero demo's script: one grant, start to finish, in the order the app performs it. Pure data and
 * pure functions so the sequence is testable without a DOM.
 */
export const demoSteps = ['command', 'ask', 'sheet', 'mfa', 'granted', 'logged'] as const;
export type DemoStep = (typeof demoSteps)[number];

/** How long each step stays on screen while autoplaying, in ms. */
export const demoDurations: Readonly<Record<DemoStep, number>> = {
  command: 1800,
  ask: 2000,
  sheet: 2400,
  mfa: 1400,
  granted: 1800,
  logged: 3000,
};

export const demoStepLabels: Readonly<Record<DemoStep, string>> = {
  command: 'Command',
  ask: 'Pause',
  sheet: 'Review',
  mfa: 'Touch ID',
  granted: 'Grant',
  logged: 'Audit',
};

/** What a screen reader hears at each step (the mock itself is aria-hidden). */
export const demoStepDescriptions: Readonly<Record<DemoStep, string>> = {
  command: 'Codex tries to push a change to the live database. Styx catches it before it goes anywhere.',
  ask: 'The agent waits. A request appears in the chat, and the counter at the top reads 01 needs you.',
  sheet:
    'The approval sheet opens. It shows what Codex wants to do, how much to allow, and for how long: one hour. Touching production asks for Touch ID.',
  mfa: 'Waiting for Touch ID.',
  granted: 'Approved. The chat notes the one-hour pass, the terminal continues, and the change is applied.',
  logged:
    'A notification confirms it is on the record: what Codex got, for how long, and where you approved it.',
};

/** Windows asks with Windows Hello where a Mac asks with Touch ID: the step's label and words follow the chrome shown. */
const forChrome = (text: string, chrome: 'mac' | 'win'): string =>
  chrome === 'win' ? text.replace(/Touch ID/g, 'Windows Hello') : text;
export const stepLabel = (step: DemoStep, chrome: 'mac' | 'win'): string =>
  forChrome(demoStepLabels[step], chrome);
export const stepDescription = (step: DemoStep, chrome: 'mac' | 'win'): string =>
  forChrome(demoStepDescriptions[step], chrome);

export const stepIndex = (step: DemoStep): number => demoSteps.indexOf(step);

export const nextStep = (step: DemoStep): DemoStep => {
  const next = demoSteps[(stepIndex(step) + 1) % demoSteps.length];
  return next ?? 'command';
};

/** True once `step` has happened, i.e. `current` is at or after it. */
export const reached = (current: DemoStep, step: DemoStep): boolean => stepIndex(current) >= stepIndex(step);

/** True while the session is paused waiting on the user. */
export const waitingOnYou = (current: DemoStep): boolean =>
  reached(current, 'ask') && !reached(current, 'granted');

export const demoLoopMs = demoSteps.reduce((sum, step) => sum + demoDurations[step], 0);

/** The five steps of "What happens at the crossing", mapped onto the demo. Touch ID is folded into step 3. */
export const crossingSteps: readonly DemoStep[] = ['command', 'ask', 'sheet', 'granted', 'logged'];

export const crossingStepAt = (index: number): DemoStep => crossingSteps[index] ?? 'command';
