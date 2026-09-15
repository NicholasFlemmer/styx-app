import { create } from 'zustand';

/**
 * Skills live on disk, not in the read model, so the pane fetches its lists itself. Anything that changes them
 * (the reader drawer installing, the pane removing) bumps `version`; the pane refetches when it moves.
 */
export interface SkillsStore {
  version: number;
  bump: () => void;
}

export const useSkillsStore = create<SkillsStore>()((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
