import { copy } from '@styx/core';
import type { OnboardingStep } from '../../state/ui-store';

export const STEPS: readonly { n: OnboardingStep; label: string; title: string; why: string }[] = [
  {
    n: 1,
    label: copy.onboarding.steps.editor,
    title: copy.onboarding.stepTitles.editor,
    why: copy.onboarding.stepWhy.editor,
  },
  {
    n: 2,
    label: copy.onboarding.steps.projects,
    title: copy.onboarding.stepTitles.projects,
    why: copy.onboarding.stepWhy.projects,
  },
  {
    n: 3,
    label: copy.onboarding.steps.agents,
    title: copy.onboarding.stepTitles.agents,
    why: copy.onboarding.stepWhy.agents,
  },
  {
    n: 4,
    label: copy.onboarding.steps.targets,
    title: copy.onboarding.stepTitles.targets,
    why: copy.onboarding.stepWhy.targets,
  },
];

export interface IdeImports {
  keybindings: boolean;
  theme: boolean;
  recents: boolean;
  /** Step 2 also lists where Claude Code and Codex have worked (their session history; #93). */
  agents: boolean;
  installOpenIn: boolean;
}
export const DEFAULT_IDE_IMPORTS: IdeImports = {
  keybindings: true,
  theme: true,
  recents: true,
  agents: true,
  installOpenIn: false,
};

export { repoMeta, rowMeta, type RepoRow, type ScannedRepo } from '../../features/modals/scanned-repos';
