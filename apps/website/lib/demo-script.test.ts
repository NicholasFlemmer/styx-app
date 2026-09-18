import { describe, expect, it } from 'vitest';
import {
  demoDurations,
  demoLoopMs,
  demoStepDescriptions,
  demoStepLabels,
  demoSteps,
  nextStep,
  reached,
  stepIndex,
  waitingOnYou,
} from './demo-script';

describe('demo script', () => {
  it('runs the grant lifecycle in the app’s order', () => {
    expect(demoSteps).toEqual(['command', 'ask', 'sheet', 'mfa', 'granted', 'logged']);
  });

  it('loops back to the start', () => {
    expect(nextStep('command')).toBe('ask');
    expect(nextStep('logged')).toBe('command');
  });

  it('has a label, a description and a duration for every step', () => {
    for (const step of demoSteps) {
      expect(demoStepLabels[step].length).toBeGreaterThan(0);
      expect(demoStepDescriptions[step].length).toBeGreaterThan(0);
      expect(demoDurations[step]).toBeGreaterThan(0);
    }
    expect(demoLoopMs).toBe(Object.values(demoDurations).reduce((a, b) => a + b, 0));
  });

  it.each([
    ['command', 'ask', false],
    ['ask', 'ask', true],
    ['logged', 'ask', true],
    ['sheet', 'granted', false],
  ] as const)('reached(%s, %s) → %s', (current, step, expected) => {
    expect(reached(current, step)).toBe(expected);
  });

  it('is waiting on you between the ask and the grant', () => {
    expect(demoSteps.map((s) => [s, waitingOnYou(s)])).toEqual([
      ['command', false],
      ['ask', true],
      ['sheet', true],
      ['mfa', true],
      ['granted', false],
      ['logged', false],
    ]);
    expect(stepIndex('mfa')).toBe(3);
  });
});

describe('crossing steps', () => {
  it('walks the demo forward in five stops', async () => {
    const { crossingStepAt, crossingSteps, stepIndex } = await import('./demo-script');
    expect(crossingSteps).toHaveLength(5);
    const indices = crossingSteps.map(stepIndex);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(crossingStepAt(0)).toBe('command');
    expect(crossingStepAt(4)).toBe('logged');
    expect(crossingStepAt(99)).toBe('command');
  });
});
