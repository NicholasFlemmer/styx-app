/**
 * Visual-diff state table (roadmap plan 04-01). One row per `<state>` in `__baseline__/<state>-<theme>-<chrome>.png`.
 *
 * `drive` describes how the prototype (design/handoff/Styx.dc.html) is put into that state; the app side receives the
 * same `state` verbatim as `STYX_SCREEN` and must set `[data-screen-ready]` once the screen (and any overlay) is painted.
 */
export type VisualTheme = 'dark' | 'light';
export type VisualChrome = 'mac' | 'win';

export type DriveStep =
  | { kind: 'screen'; label: 'All projects' | 'Workspace' | 'Agents' | 'Repo' | 'Approvals' | 'Settings' }
  | {
      kind: 'flow';
      label:
        | 'Onboarding'
        | 'Diff review'
        | 'Connect target'
        | 'Spawn agent'
        | 'New project'
        | 'Empty states'
        | 'Error states'
        | 'Notification'
        | 'Pop-out chat'
        | 'Audit detail';
    }
  /** Click a button inside the 1280×800 frame, matched by accessible name (regex source). */
  | { kind: 'frame-button'; name: string }
  | { kind: 'key'; key: string };

export interface VisualState {
  name: string;
  /** Prototype screen this state lives on (informational; used by the report). */
  screen: string;
  drive: readonly DriveStep[];
  /** Set when the prototype cannot render this state; the baker skips it and lists the reason in manifest.json. */
  unreachable?: string;
}

const EMPTY_MODE_BUG =
  "prototype throws in renderVals() when 'Empty states' is on (activeSession is undefined with no sessions) and " +
  'falls back to a placeholder skeleton; bake once design/handoff fixes it';

export const THEMES: readonly VisualTheme[] = ['dark', 'light'];
export const CHROMES: readonly VisualChrome[] = ['mac', 'win'];

export const STATES: readonly VisualState[] = [
  { name: 'home', screen: 'home', drive: [{ kind: 'screen', label: 'All projects' }] },
  { name: 'workspace', screen: 'workspace', drive: [{ kind: 'screen', label: 'Workspace' }] },
  {
    name: 'workspace-sheet',
    screen: 'workspace',
    drive: [
      { kind: 'screen', label: 'Workspace' },
      { kind: 'frame-button', name: '^Codex' },
      { kind: 'frame-button', name: '^Review request' },
    ],
  },
  { name: 'agents', screen: 'agents', drive: [{ kind: 'screen', label: 'Agents' }] },
  { name: 'repo', screen: 'repo', drive: [{ kind: 'screen', label: 'Repo' }] },
  { name: 'approvals', screen: 'approvals', drive: [{ kind: 'screen', label: 'Approvals' }] },
  { name: 'approvals-audit', screen: 'approvals', drive: [{ kind: 'flow', label: 'Audit detail' }] },
  { name: 'settings', screen: 'settings', drive: [{ kind: 'screen', label: 'Settings' }] },
  { name: 'diff', screen: 'diff', drive: [{ kind: 'flow', label: 'Diff review' }] },
  { name: 'onboarding-1', screen: 'onboarding', drive: [{ kind: 'flow', label: 'Onboarding' }] },
  {
    name: 'onboarding-2',
    screen: 'onboarding',
    drive: [
      { kind: 'flow', label: 'Onboarding' },
      { kind: 'frame-button', name: '^Continue$' },
    ],
  },
  {
    name: 'onboarding-3',
    screen: 'onboarding',
    drive: [
      { kind: 'flow', label: 'Onboarding' },
      { kind: 'frame-button', name: '^Continue$' },
      { kind: 'frame-button', name: '^Continue$' },
    ],
  },
  {
    name: 'onboarding-4',
    screen: 'onboarding',
    drive: [
      { kind: 'flow', label: 'Onboarding' },
      { kind: 'frame-button', name: '^Continue$' },
      { kind: 'frame-button', name: '^Continue$' },
      { kind: 'frame-button', name: '^Continue$' },
    ],
  },
  { name: 'connect', screen: 'workspace', drive: [{ kind: 'flow', label: 'Connect target' }] },
  { name: 'spawn', screen: 'workspace', drive: [{ kind: 'flow', label: 'Spawn agent' }] },
  { name: 'new-project', screen: 'workspace', drive: [{ kind: 'flow', label: 'New project' }] },
  { name: 'palette', screen: 'workspace', drive: [{ kind: 'key', key: 'Meta+K' }] },
  { name: 'toast', screen: 'workspace', drive: [{ kind: 'flow', label: 'Notification' }] },
  { name: 'popout', screen: 'workspace', drive: [{ kind: 'flow', label: 'Pop-out chat' }] },
  {
    name: 'home-empty',
    screen: 'home',
    drive: [
      { kind: 'screen', label: 'All projects' },
      { kind: 'flow', label: 'Empty states' },
    ],
    unreachable: EMPTY_MODE_BUG,
  },
  {
    name: 'agents-empty',
    screen: 'agents',
    drive: [
      { kind: 'screen', label: 'Agents' },
      { kind: 'flow', label: 'Empty states' },
    ],
    unreachable: EMPTY_MODE_BUG,
  },
  {
    name: 'workspace-error',
    screen: 'workspace',
    drive: [
      { kind: 'screen', label: 'Workspace' },
      { kind: 'flow', label: 'Error states' },
    ],
  },
  {
    name: 'repo-error',
    screen: 'repo',
    drive: [
      { kind: 'screen', label: 'Repo' },
      { kind: 'flow', label: 'Error states' },
    ],
  },
];

export const WINDOW = { width: 1280, height: 800 } as const;

export function baselineName(state: string, theme: VisualTheme, chrome: VisualChrome): string {
  return `${state}-${theme}-${chrome}.png`;
}

const NAME_RE = /^(.+)-(dark|light)-(mac|win)\.png$/;

export function parseBaselineName(
  file: string,
): { state: string; theme: VisualTheme; chrome: VisualChrome } | undefined {
  const m = NAME_RE.exec(file);
  if (!m) return undefined;
  return { state: m[1] as string, theme: m[2] as VisualTheme, chrome: m[3] as VisualChrome };
}
