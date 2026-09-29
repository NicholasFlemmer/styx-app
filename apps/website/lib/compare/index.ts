import { claudeCode } from './claude-code';
import { codex } from './codex';
import { conductor } from './conductor';
import { cursor } from './cursor';
import { emdash } from './emdash';
import { kepler } from './kepler';
import { nimbalyst } from './nimbalyst';
import { orca } from './orca';
import { superset } from './superset';
import type { Competitor } from './types';
import { vibeKanban } from './vibe-kanban';
import { warp } from './warp';

export type { Competitor } from './types';

/** Every comparison, in the order the index lists them: ADEs first, then the agents' own apps and editors. */
export const COMPETITORS: readonly Competitor[] = [
  conductor,
  superset,
  emdash,
  orca,
  kepler,
  warp,
  nimbalyst,
  vibeKanban,
  claudeCode,
  codex,
  cursor,
];

export const competitor = (slug: string): Competitor | undefined => COMPETITORS.find((c) => c.slug === slug);
