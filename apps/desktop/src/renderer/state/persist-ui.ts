import { command } from './commands';
import { useUiStore, type Screen } from './ui-store';

/** Screens worth coming back to. Onboarding resolves itself; the diff review belongs to a session that has moved on. */
const REMEMBERED: readonly Screen[] = [
  'home',
  'workspace',
  'agents',
  'usage',
  'repo',
  'approvals',
  'settings',
];
const DEBOUNCE_MS = 300;

/**
 * Writes what the person is looking at to main (`ui.persist`) whenever it changes, so a relaunch comes back to the
 * same screen, project and per-project chat tab (README: ui.screen / projectId persist per machine). Only the
 * main window persists; a pop-out chat is one session and has none of this. `hydratePersisted` is the other half.
 */
export const startUiPersistence = (): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = { screen: '', projectId: '', sessions: '' };
  const flush = () => {
    timer = null;
    const s = useUiStore.getState();
    if (!s.screenResolved) return;
    const screen = REMEMBERED.includes(s.screen) ? s.screen : null;
    const sessions = JSON.stringify(s.projectSession);
    const next = { screen: screen ?? last.screen, projectId: s.projectId ?? '', sessions };
    const patch: {
      screen?: string;
      projectId?: typeof s.projectId;
      projectSession?: typeof s.projectSession;
    } = {};
    if (screen !== null && screen !== last.screen) patch.screen = screen;
    if (next.projectId !== last.projectId) patch.projectId = s.projectId;
    if (sessions !== last.sessions) patch.projectSession = s.projectSession;
    last = next;
    if (Object.keys(patch).length === 0) return;
    void command('ui.persist', patch);
  };
  const off = useUiStore.subscribe((s, prev) => {
    if (
      s.screen === prev.screen &&
      s.projectId === prev.projectId &&
      s.projectSession === prev.projectSession
    )
      return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });
  return () => {
    off();
    if (timer !== null) clearTimeout(timer);
  };
};
