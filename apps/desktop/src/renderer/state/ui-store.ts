import type { EventPayload, PaletteScope, ProjectId, ReadModel, SessionId } from '@styx/core';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  forgetInvoker,
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
  resolvedTheme: 'dark' | 'light';
  platform: BridgePlatform;
  paneSizes: Record<string, number>;
  palette: PaletteUiState;
  diffFocusIndex: number;
  approvalsTab: ApprovalsTab;
  settingsSection: string;
  onboardingStep: OnboardingStep;
  editorFile: string | null;
  banners: Record<string, BannerEvent>;
  dismissedBanners: string[];
}

export interface UiActions {
  setScreen(screen: Screen): void;
  setProject(projectId: ProjectId | null): void;
  setSession(projectId: ProjectId, sessionId: SessionId): void;
  /** Focus a session: switches project and screen too. */
  openSession(projectId: ProjectId, sessionId: SessionId): void;
  resolveInitialScreen(model: ReadModel): void;
  /** Seeds screen/project/pane state from the snapshot's persisted `ui` block (env overrides win). */
  hydratePersisted(ui: { screen: string | null; projectId: ProjectId | null; projectSession: Record<string, SessionId>; paneSizes: Record<string, number> }): void;
  setResolvedTheme(theme: 'dark' | 'light'): void;
  setPaneSize(key: string, size: number): void;
  setPalette(patch: Partial<PaletteUiState>): void;
  openPalette(scope?: PaletteScope): void;
  /** Mod+K: closes when the palette is the top overlay, opens otherwise. */
  togglePalette(): void;
  pushOverlay(overlay: OverlayInput): string;
  /** Pops the top overlay (or `id`), restoring focus to its invoker. */
  popOverlay(id?: string): void;
  closeOverlays(kind?: OverlayKind): void;
  setDiffFocusIndex(i: number): void;
  setApprovalsTab(tab: ApprovalsTab): void;
  setSettingsSection(section: string): void;
  setOnboardingStep(step: OnboardingStep): void;
  setEditorFile(file: string | null): void;
  setBanner(banner: BannerEvent): void;
  clearBanner(bannerKey: string): void;
  dismissBanner(bannerKey: string): void;
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

export const useUiStore = create<UiStore>()(
  immer((set, get) => ({
    screen: initialFromEnv?.screen ?? 'home',
    screenResolved: initialFromEnv !== null,
    projectId: null,
    projectSession: {},
    overlays: [],
    resolvedTheme: 'dark',
    platform: platform(),
    paneSizes: {},
    palette: { query: '', scope: 'all', activeId: null },
    diffFocusIndex: 0,
    approvalsTab: 'inbox',
    settingsSection: 'project:targets',
    onboardingStep: initialFromEnv?.step ?? 1,
    editorFile: null,
    banners: {},
    dismissedBanners: [],

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
    openSession: (projectId, sessionId) =>
      set((s) => {
        s.projectId = projectId;
        s.projectSession[projectId] = sessionId;
        s.screen = 'workspace';
        s.screenResolved = true;
      }),
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
      }),
    setResolvedTheme: (theme) =>
      set((s) => {
        s.resolvedTheme = theme;
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
      rememberInvoker(id);
      set((s) => {
        s.overlays = pushOverlayPure(s.overlays, { ...overlay, id } as Overlay);
      });
      return id;
    },
    popOverlay: (id) => {
      const target = id ?? topOverlay(get().overlays)?.id;
      if (target === undefined) return;
      set((s) => {
        s.overlays = removeOverlay(s.overlays, target);
      });
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
    setApprovalsTab: (tab) =>
      set((s) => {
        s.approvalsTab = tab;
      }),
    setSettingsSection: (section) =>
      set((s) => {
        s.settingsSection = section;
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
  })),
);

/** Derived: the active session of the active project. */
export const selectSessionId = (s: Pick<UiState, 'projectId' | 'projectSession'>): SessionId | null =>
  s.projectId === null ? null : (s.projectSession[s.projectId] ?? null);
