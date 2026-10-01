import type { EventPayload, PaletteScope, ProjectId, ReadModel, SessionId, SnakeGame } from '@styx/core';
import { newSnakeGame, pauseSnake, taskKey } from '@styx/core';
import { useReadModel } from './read-model';
import type { TaskLaunch } from '../features/tasks/task-launch';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  findOverlay,
  forgetInvoker,
  invokerOf,
  overlayId,
  pushOverlay as pushOverlayPure,
  rememberInvoker,
  removeOverlay,
  restoreInvoker,
  topOverlay,
  type Overlay,
  type OverlayInput,
  type OverlayKind,
} from '../overlays/stack';
import { env, platform, type BridgePlatform } from './bridge';

export const SCREENS = [
  'home',
  'workspace',
  'agents',
  'usage',
  'repo',
  'approvals',
  'settings',
  'diff',
  'onboarding',
] as const;
export type Screen = (typeof SCREENS)[number];
export const isScreen = (v: string): v is Screen => (SCREENS as readonly string[]).includes(v);

export type ApprovalsTab = 'inbox' | 'policies' | 'audit';
export type OnboardingStep = 1 | 2 | 3 | 4;

/** Banner rows pushed by main (`banner.set` / `banner.clear`). */
export type BannerEvent = EventPayload<'banner.set'>;

/**
 * Snake in a project's chat pane (owner addition, discrepancy row 110). The game lives here, not in the board,
 * so it survives a tab switch, a tab finishing, a trip to Settings and the hold: the app freezes it the moment
 * the tab on screen needs the person, and Resume (once that ask is answered) counts it back in.
 */
export interface ArcadeState {
  projectId: ProjectId;
  game: SnakeGame;
  /** Frozen by the app (the tab on screen needs the person); the transcript shows in the board's place until Resume. */
  held: boolean;
  /** 3 · 2 · 1 before play resumes after a hold. */
  countdown: number | null;
}

/** Per-machine high score, in the same persisted map as the pane sizes (never in `.styx/project.json`). */
export const ARCADE_BEST_KEY = 'arcade.snakeBest';

export interface PaletteUiState {
  query: string;
  scope: PaletteScope;
  activeId: string | null;
}

export interface UiState {
  screen: Screen;
  /** Set once the initial screen was decided (env override or first snapshot). */
  screenResolved: boolean;
  projectId: ProjectId | null;
  /** Active session per project; `sessionId` is derived from it. */
  projectSession: Record<string, SessionId>;
  overlays: Overlay[];
  /**
   * Floating DOM menus that are not overlays (the Deploy picker, the rail +, the session overflow): while one is
   * open the design window's native view must leave the screen or it paints over the menu.
   */
  floatingMenus: number;
  resolvedTheme: 'dark' | 'light';
  platform: BridgePlatform;
  paneSizes: Record<string, number>;
  palette: PaletteUiState;
  diffFocusIndex: number;
  /** The Diff screen shows this turn checkpoint's patch (read-only) instead of the session's hunks (ADR-0020). */
  diffCheckpointId: string | null;
  approvalsTab: ApprovalsTab;
  settingsSection: string;
  onboardingStep: OnboardingStep;
  editorFile: string | null;
  banners: Record<string, BannerEvent>;
  dismissedBanners: string[];
  /** Sessions working an ability out for the Run locally / Deploy buttons: `run:<projectId>` / `deploy:<targetId>` → session. */
  learning: Record<string, SessionId>;
  /** What the Agents board shows: every project's sessions (the default, and the app rail's tile) or the current project's (the project nav's row). */
  boardScope: 'all' | 'project';
  /**
   * The project whose workspace shows New task in place of the lane (ADR-0027 §1), with any text to start from
   * (the palette's "Start as a task"); null when the workspace shows the lane.
   */
  newTask: { projectId: ProjectId; text: string } | null;
  taskLaunches: Record<string, TaskLaunch>;
  /**
   * Text handed back to a session's composer (a queued message taken back, or Stop returning the queue), by
   * session. The chat pane applies it once and clears it; `seq` tells the composer a new one arrived.
   */
  drafts: Record<string, { text: string; seq: number }>;
  /**
   * What is typed in each session's composer (owner report: one composer's text showed in every tab and was
   * gone after a trip to Settings). Kept here, per session, for as long as the window lives.
   */
  composerText: Record<string, string>;
  arcade: ArcadeState | null;
  /** The first-run walkthrough is on screen (#124): started once after onboarding, or from the palette. */
  tourOpen: boolean;
}

export interface UiActions {
  setScreen(screen: Screen): void;
  setTourOpen(open: boolean): void;
  setProject(projectId: ProjectId | null): void;
  setSession(projectId: ProjectId, sessionId: SessionId): void;
  /** Focus a session: switches project and screen too. */
  openSession(projectId: ProjectId, sessionId: SessionId): void;
  resolveInitialScreen(model: ReadModel): void;
  /** Seeds screen/project/pane state from the snapshot's persisted `ui` block (env overrides win). */
  hydratePersisted(ui: {
    screen: string | null;
    projectId: ProjectId | null;
    projectSession: Record<string, SessionId>;
    paneSizes: Record<string, number>;
  }): void;
  setResolvedTheme(theme: 'dark' | 'light'): void;
  setPaneSize(key: string, size: number): void;
  setPalette(patch: Partial<PaletteUiState>): void;
  openPalette(scope?: PaletteScope): void;
  /** Mod+K: closes when the palette is the top overlay, opens otherwise. */
  togglePalette(): void;
  pushOverlay(overlay: OverlayInput): string;
  /** A floating menu opened (+1) or closed (-1). */
  floatingMenu(delta: 1 | -1): void;
  /** Pops the top overlay (or `id`), restoring focus to its invoker. */
  popOverlay(id?: string): void;
  closeOverlays(kind?: OverlayKind): void;
  setDiffFocusIndex(i: number): void;
  setDiffCheckpoint(checkpointId: string | null): void;
  setApprovalsTab(tab: ApprovalsTab): void;
  setSettingsSection(section: string): void;
  setTaskLaunch(key: string, launch: TaskLaunch): void;
  setLearning(key: string, sessionId: SessionId | null): void;
  setBoardScope(scope: 'all' | 'project'): void;
  /** Opens New task in the project's workspace (and goes there); null closes it. */
  openNewTask(projectId: ProjectId | null, text?: string): void;
  setOnboardingStep(step: OnboardingStep): void;
  setEditorFile(file: string | null): void;
  setBanner(banner: BannerEvent): void;
  clearBanner(bannerKey: string): void;
  dismissBanner(bannerKey: string): void;
  /** Puts `text` into the session's composer draft (after anything already waiting there, blank-line separated). */
  prefillDraft(sessionId: SessionId, text: string): void;
  clearDraft(sessionId: SessionId): void;
  setComposerText(sessionId: SessionId, text: string): void;
  /** Opens Snake in the project's chat pane (a fresh board from `seed`), replacing any game already open. */
  openArcade(projectId: ProjectId, seed: number): void;
  setArcadeGame(game: SnakeGame): void;
  /** The tab on screen needs the person: the game pauses and gives the pane back to the transcript. */
  holdArcade(): void;
  /** Resume after a hold: the board returns and counts down from 3. */
  resumeArcade(): void;
  setArcadeCountdown(countdown: number | null): void;
  closeArcade(): void;
}

export type UiStore = UiState & UiActions;

/** Visual-harness state names (`STYX_SCREEN=<state>`) map onto a screen (+ optional step). */
export const screenFromEnv = (
  value: string | undefined,
): { screen: Screen; step?: OnboardingStep } | null => {
  if (value === undefined || value === '') return null;
  if (isScreen(value)) return { screen: value };
  const onboarding = /^onboarding-([1-4])$/.exec(value);
  if (onboarding !== null) return { screen: 'onboarding', step: Number(onboarding[1]) as OnboardingStep };
  const head = value.split('-')[0] ?? '';
  if (isScreen(head)) return { screen: head };
  return { screen: 'workspace' };
};

const initialFromEnv = screenFromEnv(env().screen);

/** Ever-increasing across sessions and clears, so a composer never mistakes a new prefill for one it applied. */
let draftSeq = 0;

export const useUiStore = create<UiStore>()(
  immer((set, get) => ({
    screen: initialFromEnv?.screen ?? 'home',
    screenResolved: initialFromEnv !== null,
    projectId: null,
    projectSession: {},
    overlays: [],
    floatingMenus: 0,
    resolvedTheme: 'dark',
    platform: platform(),
    paneSizes: {},
    palette: { query: '', scope: 'all', activeId: null },
    diffFocusIndex: 0,
    diffCheckpointId: null,
    approvalsTab: 'inbox',
    settingsSection: 'project:targets',
    learning: {},
    boardScope: 'all',
    newTask: null,
    taskLaunches: {},
    onboardingStep: initialFromEnv?.step ?? 1,
    editorFile: null,
    banners: {},
    dismissedBanners: [],
    drafts: {},
    composerText: {},
    arcade: null,
    tourOpen: false,

    setTourOpen: (open) =>
      set((s) => {
        s.tourOpen = open;
      }),
    setScreen: (screen) =>
      set((s) => {
        s.screen = screen;
        s.screenResolved = true;
      }),
    setProject: (projectId) =>
      set((s) => {
        s.projectId = projectId;
      }),
    setSession: (projectId, sessionId) =>
      set((s) => {
        s.projectSession[projectId] = sessionId;
      }),
    openSession: (projectId, sessionId) => {
      const session = useReadModel.getState().model.sessions.byId[sessionId];
      if (session?.purpose) {
        get().pushOverlay({ kind: 'task', taskKey: taskKey(session) });
        return;
      }
      set((s) => {
        s.projectId = projectId;
        s.projectSession[projectId] = sessionId;
        s.screen = 'workspace';
        s.newTask = null;
        s.screenResolved = true;
      });
    },
    hydratePersisted: (ui) =>
      set((s) => {
        if (s.projectId === null && ui.projectId !== null) s.projectId = ui.projectId;
        s.projectSession = { ...ui.projectSession, ...s.projectSession };
        s.paneSizes = { ...ui.paneSizes, ...s.paneSizes };
        if (!s.screenResolved && ui.screen !== null && isScreen(ui.screen)) {
          s.screen = ui.screen;
          s.screenResolved = true;
        }
      }),
    resolveInitialScreen: (model) =>
      set((s) => {
        const projects = model.projects.ids
          .map((id) => model.projects.byId[id])
          .filter((p) => p !== undefined && p.removedAt === null)
          .sort((a, b) => (a?.railOrder ?? 0) - (b?.railOrder ?? 0));
        if (s.projectId === null) s.projectId = projects[0]?.id ?? null;
        if (s.screenResolved) return;
        if (!model.settings.app.onboardingDone) s.screen = 'onboarding';
        else s.screen = projects.length === 0 ? 'home' : 'workspace';
        s.screenResolved = true;
        // First launch, nobody signed in: the sign-in dialog is the first thing on screen (owner request,
        // discrepancy row 113). It has a Not now, and it is pushed once — this only runs when the screen is
        // first resolved, so it never nags on later starts.
        if (!model.settings.app.onboardingDone && model.account.kind === 'signed-out') {
          s.overlays = pushOverlayPure(s.overlays, {
            id: overlayId('modal'),
            kind: 'modal',
            modal: 'sign-in',
            reason: 'welcome',
          });
        }
      }),
    setResolvedTheme: (theme) =>
      set((s) => {
        s.resolvedTheme = theme;
      }),
    floatingMenu: (delta) =>
      set((s) => {
        s.floatingMenus = Math.max(0, s.floatingMenus + delta);
      }),
    setPaneSize: (key, size) =>
      set((s) => {
        s.paneSizes[key] = size;
      }),
    setPalette: (patch) =>
      set((s) => {
        Object.assign(s.palette, patch);
      }),
    openPalette: (scope = 'all') => {
      set((s) => {
        s.palette = { query: '', scope, activeId: null };
      });
      if (topOverlay(get().overlays)?.kind !== 'palette') get().pushOverlay({ kind: 'palette' });
    },
    togglePalette: () => {
      const top = topOverlay(get().overlays);
      if (top?.kind === 'palette') get().popOverlay(top.id);
      else get().openPalette('all');
    },
    pushOverlay: (overlay) => {
      const id = overlayId(overlay.kind);
      // A push that replaces an overlay of the same kind (a task's detail view over the task list) keeps the
      // original invoker: the button inside the replaced overlay unmounts, so focus would otherwise fall to body.
      const replaced =
        overlay.kind === 'task' || overlay.kind === 'modal' || overlay.kind === 'palette'
          ? findOverlay(get().overlays, overlay.kind)
          : null;
      const inherited = replaced === null ? null : invokerOf(replaced.id);
      if (inherited !== null && replaced !== null) {
        rememberInvoker(id, inherited);
        forgetInvoker(replaced.id);
      } else rememberInvoker(id);
      set((s) => {
        s.overlays = pushOverlayPure(s.overlays, { ...overlay, id } as Overlay);
      });
      return id;
    },
    popOverlay: (id) => {
      const target = id ?? topOverlay(get().overlays)?.id;
      if (target === undefined) return;
      const closing = get().overlays.find((o) => o.id === target);
      // A Connect agent modal opened from Spawn hands back to Spawn however it was closed (Done, Esc, backdrop),
      // and the new modal inherits the invoker so focus still returns to where the user started.
      const returnTo =
        closing?.kind === 'modal' && closing.modal === 'connect-agent' ? closing.returnTo : undefined;
      const invoker = returnTo === undefined ? null : invokerOf(target);
      set((s) => {
        s.overlays = removeOverlay(s.overlays, target);
      });
      if (returnTo !== undefined) {
        forgetInvoker(target);
        const next = get().pushOverlay({ kind: 'modal', modal: 'spawn', projectId: returnTo.projectId });
        if (invoker !== null) rememberInvoker(next, invoker);
        return;
      }
      restoreInvoker(target);
    },
    closeOverlays: (kind) => {
      for (const o of get().overlays) {
        if (kind === undefined || o.kind === kind) forgetInvoker(o.id);
      }
      set((s) => {
        s.overlays = kind === undefined ? [] : s.overlays.filter((o) => o.kind !== kind);
      });
    },
    setDiffFocusIndex: (i) =>
      set((s) => {
        s.diffFocusIndex = i;
      }),
    setDiffCheckpoint: (checkpointId) =>
      set((s) => {
        s.diffCheckpointId = checkpointId;
      }),
    setApprovalsTab: (tab) =>
      set((s) => {
        s.approvalsTab = tab;
      }),
    setSettingsSection: (section) =>
      set((s) => {
        s.settingsSection = section;
      }),
    setTaskLaunch: (key, launch) =>
      set((s) => {
        s.taskLaunches[key] = launch;
      }),
    setLearning: (key, sessionId) =>
      set((s) => {
        if (sessionId === null) delete s.learning[key];
        else s.learning[key] = sessionId;
      }),
    setBoardScope: (scope) =>
      set((s) => {
        s.boardScope = scope;
      }),
    openNewTask: (projectId, text = '') =>
      set((s) => {
        if (projectId === null) {
          s.newTask = null;
          return;
        }
        s.newTask = { projectId, text };
        s.projectId = projectId;
        s.screen = 'workspace';
      }),
    setOnboardingStep: (step) =>
      set((s) => {
        s.onboardingStep = step;
      }),
    setEditorFile: (file) =>
      set((s) => {
        s.editorFile = file;
      }),
    setBanner: (banner) =>
      set((s) => {
        s.banners[banner.bannerKey] = banner;
        s.dismissedBanners = s.dismissedBanners.filter((k) => k !== banner.bannerKey);
      }),
    clearBanner: (bannerKey) =>
      set((s) => {
        delete s.banners[bannerKey];
      }),
    dismissBanner: (bannerKey) =>
      set((s) => {
        if (!s.dismissedBanners.includes(bannerKey)) s.dismissedBanners.push(bannerKey);
      }),
    prefillDraft: (sessionId, text) =>
      set((s) => {
        const cur = s.drafts[sessionId];
        draftSeq += 1;
        s.drafts[sessionId] = { text: cur === undefined ? text : `${cur.text}\n\n${text}`, seq: draftSeq };
      }),
    clearDraft: (sessionId) =>
      set((s) => {
        delete s.drafts[sessionId];
      }),
    setComposerText: (sessionId, text) =>
      set((s) => {
        if (text === '') delete s.composerText[sessionId];
        else if (s.composerText[sessionId] !== text) s.composerText[sessionId] = text;
      }),
    openArcade: (projectId, seed) =>
      set((s) => {
        s.arcade = { projectId, game: newSnakeGame(seed), held: false, countdown: null };
      }),
    setArcadeGame: (game) =>
      set((s) => {
        if (s.arcade !== null) s.arcade.game = game;
      }),
    holdArcade: () =>
      set((s) => {
        if (s.arcade === null) return;
        s.arcade.game = pauseSnake(s.arcade.game);
        s.arcade.held = true;
        s.arcade.countdown = null;
      }),
    resumeArcade: () =>
      set((s) => {
        if (s.arcade === null || !s.arcade.held) return;
        s.arcade.held = false;
        // A game that was ready or over needs no run-up; a paused one counts down before it moves again.
        s.arcade.countdown = s.arcade.game.phase === 'paused' ? 3 : null;
      }),
    setArcadeCountdown: (countdown) =>
      set((s) => {
        if (s.arcade !== null) s.arcade.countdown = countdown;
      }),
    closeArcade: () =>
      set((s) => {
        s.arcade = null;
      }),
  })),
);

/** Derived: the active session of the active project. */
export const selectSessionId = (s: Pick<UiState, 'projectId' | 'projectSession'>): SessionId | null =>
  s.projectId === null ? null : (s.projectSession[s.projectId] ?? null);
