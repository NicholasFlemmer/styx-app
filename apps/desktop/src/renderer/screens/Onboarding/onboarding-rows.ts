import { copy } from '@styx/core';
import type { OnboardingStep } from '../../state/ui-store';

export const STEPS: readonly { n: OnboardingStep; label: string }[] = [
  { n: 1, label: copy.onboarding.steps.editor },
  { n: 2, label: copy.onboarding.steps.projects },
  { n: 3, label: copy.onboarding.steps.agents },
  { n: 4, label: copy.onboarding.steps.targets },
];

export interface IdeImports {
  keybindings: boolean;
  theme: boolean;
  recents: boolean;
  installOpenIn: boolean;
}
export const DEFAULT_IDE_IMPORTS: IdeImports = {
  keybindings: true,
  theme: true,
  recents: true,
  installOpenIn: false,
};

export { repoMeta, type RepoRow, type ScannedRepo } from '../../features/modals/scanned-repos';
