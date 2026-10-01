import { copy, fill, formatChord, type ReadModel } from '@styx/core';
import { shortcuts } from '@styx/tokens';
import { Button, useFocusTrap, useReturnFocus } from '@styx/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { env, platform } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { useUiStore, type ApprovalsTab, type Screen } from '../../state/ui-store';
import s from './Tour.module.css';

/**
 * First-run walkthrough (owner request, #124): one card per part of the window, pointed at the real thing, with
 * the rest dimmed. Steps whose anchor is not on screen are skipped rather than pointed at nothing; the last card
 * has no anchor and sits in the middle. Finishing or skipping marks it seen; the palette plays it again.
 */

type StepKey = keyof typeof copy.tour.steps;

/** Where a step happens: the tour switches there before pointing. */
interface Go {
  screen: Screen;
  settingsSection?: string;
  approvalsTab?: ApprovalsTab;
}

interface Step {
  key: StepKey;
  /** Where the card points; null = the closing card, centred. */
  anchor: string | null;
  go?: Go;
  /** Only with a project open: the workspace, Repo and Targets have nothing to point at without one. */
  needsProject?: boolean;
}

export const TOUR_STEPS: readonly Step[] = [
  { key: 'rail', anchor: '[data-rail="true"]', go: { screen: 'home' } },
  { key: 'needs', anchor: '[data-titlebar-needs="true"]', go: { screen: 'home' } },
  { key: 'palette', anchor: '[data-titlebar-palette="true"]', go: { screen: 'home' } },
  { key: 'spawn', anchor: '[data-nav-new-task="true"]', go: { screen: 'workspace' }, needsProject: true },
  { key: 'tabs', anchor: '[data-nav-lanes="true"]', go: { screen: 'workspace' }, needsProject: true },
  { key: 'composer', anchor: '[data-keyscope="composer"]', go: { screen: 'workspace' }, needsProject: true },
  { key: 'editor', anchor: '[data-keyscope="editor"]', go: { screen: 'workspace' }, needsProject: true },
  { key: 'land', anchor: '[data-land-button="true"]', go: { screen: 'workspace' }, needsProject: true },
  { key: 'deploy', anchor: '[data-deploy-button="true"]', go: { screen: 'workspace' }, needsProject: true },
  {
    key: 'design',
    anchor: '[data-workspace-mode="design"]',
    go: { screen: 'workspace' },
    needsProject: true,
  },
  { key: 'repo', anchor: '[data-repo-lanes="true"]', go: { screen: 'repo' }, needsProject: true },
  {
    key: 'approvals',
    anchor: '[data-approvals-tab="inbox"]',
    go: { screen: 'approvals', approvalsTab: 'inbox' },
  },
  {
    key: 'targets',
    anchor: '[data-connect-target="true"]',
    go: { screen: 'settings', settingsSection: 'project:targets' },
    needsProject: true,
  },
  {
    key: 'feedback',
    anchor: '[data-status-feedback="true"]',
    go: { screen: 'workspace' },
    needsProject: true,
  },
  { key: 'done', anchor: null },
];

/** How long a step waits for its anchor to render after switching screen, in frames (~1.5s). */
const SEEK_FRAMES = 90;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 6;
const GAP = 16;
const CARD_W = 340;

const boxOf = (selector: string): Box | null => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
};

/** Beside the anchor where it fits (right, left, below, above), always inside the window. */
export const placeCard = (hole: Box | null, card: { w: number; h: number }, vw: number, vh: number) => {
  const clampX = (x: number) => Math.min(Math.max(GAP, x), vw - card.w - GAP);
  const clampY = (y: number) => Math.min(Math.max(GAP, y), vh - card.h - GAP);
  if (hole === null) return { x: clampX((vw - card.w) / 2), y: clampY((vh - card.h) / 2) };
  if (hole.x + hole.w + GAP + card.w + GAP <= vw) return { x: hole.x + hole.w + GAP, y: clampY(hole.y) };
  if (hole.x - GAP - card.w >= GAP) return { x: hole.x - GAP - card.w, y: clampY(hole.y) };
  if (hole.y + hole.h + GAP + card.h + GAP <= vh) return { x: clampX(hole.x), y: hole.y + hole.h + GAP };
  return { x: clampX(hole.x), y: clampY(hole.y - GAP - card.h) };
};

const pad2 = (n: number) => String(n).padStart(2, '0');

function TourCard({ onClose }: { onClose: (finished: boolean) => void }) {
  const ui = useUiStore.getState;
  // Where the tour started, to go back there after; and the steps this machine can show.
  const [start] = useState(() => ui().screen);
  const [steps] = useState(() => TOUR_STEPS.filter((st) => !st.needsProject || ui().projectId !== null));
  const [i, setI] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [found, setFound] = useState(false);
  const [, setTick] = useState(0);
  const [cardH, setCardH] = useState(200);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const step = steps[Math.min(i, steps.length - 1)] ?? { key: 'done' as const, anchor: null };
  const last = i >= steps.length - 1;
  const chord = formatChord(shortcuts.palette, platform());

  useReturnFocus(true);
  useFocusTrap(card, { active: true, initialFocus: primary });

  const finish = useCallback(
    (finished: boolean) => {
      const u = ui();
      if (u.screen !== start) u.setScreen(start);
      onClose(finished);
    },
    [onClose, start, ui],
  );

  /** Switches to where a step happens (screen, Settings section, Approvals tab). */
  const applyGo = useCallback(
    (go: Go | undefined) => {
      if (!go) return;
      const u = ui();
      if (go.settingsSection !== undefined) u.setSettingsSection(go.settingsSection);
      if (go.approvalsTab !== undefined) u.setApprovalsTab(go.approvalsTab);
      if (u.screen !== go.screen) u.setScreen(go.screen);
    },
    [ui],
  );

  /** Moves to step `n`, switching to its screen first; past either end, the tour is over. */
  const goTo = useCallback(
    (n: number, towards: 1 | -1) => {
      if (n >= steps.length) return finish(true);
      const target = steps[Math.max(0, n)];
      if (!target) return;
      applyGo(target.go);
      setDir(towards);
      setFound(false);
      setI(Math.max(0, n));
    },
    [applyGo, finish, steps],
  );

  // Wait for the step's anchor to render (a screen switch takes a frame or two); skip the step if it never does.
  useEffect(() => {
    let frames = 0;
    let raf = 0;
    const seek = () => {
      // Opened from anywhere (Settings, the Help menu), the first step still happens where it belongs.
      if (frames === 0) applyGo(step.go);
      if (step.anchor === null || boxOf(step.anchor) !== null) {
        setFound(true);
        return;
      }
      frames += 1;
      if (frames > SEEK_FRAMES) {
        if (dir === -1 && i === 0) setFound(true);
        else goTo(i + dir, dir);
        return;
      }
      raf = requestAnimationFrame(seek);
    };
    raf = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(raf);
  }, [step.anchor, step.go, i, dir, goTo, applyGo]);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // The card's own height decides whether it fits beside the anchor.
  useEffect(() => {
    const el = card.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCardH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Each new step's primary button takes focus, so a screen reader reads the card that just appeared.
  useEffect(() => {
    if (found) primary.current?.focus();
  }, [found, i]);

  const next = () => goTo(i + 1, 1);
  const back = () => (i > 0 ? goTo(i - 1, -1) : undefined);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    }
  };

  const hole = found && step.anchor !== null ? boxOf(step.anchor) : null;
  const view = { w: window.innerWidth, h: window.innerHeight };
  const pos = placeCard(hole, { w: CARD_W, h: cardH }, view.w, view.h);
  const text = copy.tour.steps[step.key];
  const titleId = `tour-title-${step.key}`;
  const bodyId = `tour-body-${step.key}`;

  return (
    <div
      className={s['root']}
      data-tour="true"
      data-tour-step={step.key}
      data-tour-ready={found ? 'true' : undefined}
    >
      {/* The dim, with a hole where the anchor is: four panes around it, or one pane while there is none. */}
      {hole === null ? (
        <div className={s['pane']} style={{ inset: 0 }} />
      ) : (
        <>
          <div className={s['pane']} style={{ left: 0, top: 0, right: 0, height: Math.max(0, hole.y) }} />
          <div className={s['pane']} style={{ left: 0, top: hole.y + hole.h, right: 0, bottom: 0 }} />
          <div
            className={s['pane']}
            style={{ left: 0, top: hole.y, width: Math.max(0, hole.x), height: hole.h }}
          />
          <div
            className={s['pane']}
            style={{ left: hole.x + hole.w, top: hole.y, right: 0, height: hole.h }}
          />
          <div
            className={s['ring']}
            style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
            data-tour-ring="true"
          />
        </>
      )}
      <div
        ref={card}
        className={s['card']}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y, width: CARD_W, visibility: found ? 'visible' : 'hidden' }}
        onKeyDown={onKeyDown}
      >
        <p className={s['count']} aria-hidden="true">
          {fill(copy.tour.step, { n: pad2(i + 1), total: pad2(steps.length) })}
        </p>
        <h2 id={titleId} className={s['title']}>
          {text.title}
        </h2>
        <p id={bodyId} className={s['body']}>
          {fill(text.body, { chord })}
        </p>
        <div className={s['actions']}>
          {last ? null : (
            <Button variant="ghost" onClick={() => finish(false)} data-tour-skip="true">
              {copy.tour.skip}
            </Button>
          )}
          <span className={s['spacer']} />
          {i > 0 ? (
            <Button onClick={back} data-tour-back="true">
              {copy.tour.back}
            </Button>
          ) : null}
          <Button ref={primary} variant="primary" onClick={next} data-tour-next="true">
            {last ? copy.tour.done : copy.tour.next}
          </Button>
        </div>
      </div>
    </div>
  );
}

const selectTourDone = (m: ReadModel) => m.settings.app.tourDone;
const selectOnboardingDone = (m: ReadModel) => m.settings.app.onboardingDone;

/** The walkthrough, mounted once in the shell; `tourOpen` in the UI store says whether it is showing. */
export function Tour() {
  const open = useUi((u) => u.tourOpen);
  const setTourOpen = useUi((u) => u.setTourOpen);
  const tourDone = useModel(selectTourDone);
  // #125: whether people see the walkthrough, and whether they get to the end of it (counts only).
  useEffect(() => {
    if (open) void command('usage.note', { event: 'tour.shown' });
  }, [open]);
  const close = useCallback(
    (finished: boolean) => {
      void command('usage.note', { event: finished ? 'tour.finished' : 'tour.skipped' });
      setTourOpen(false);
      // Finished or skipped, it has been seen: it does not start by itself again.
      if (!tourDone) void command('settings.set', { patch: { tourDone: true } });
    },
    [setTourOpen, tourDone],
  );
  if (!open) return null;
  return createPortal(<TourCard onClose={close} />, document.body);
}

/**
 * Starts the walkthrough for someone who has finished onboarding and has not yet finished or skipped it: on
 * whatever screen they are on (its steps move between screens themselves), once nothing else is on screen (the
 * welcome sign-in dialog and any toast go first). It used to wait for Home, and a relaunch opens on the
 * Workspace, so anyone who missed it once never saw it (#125); now each launch offers it until it has been seen.
 * Never under the e2e harness, whose screens it would cover; the palette row still opens it there.
 */
export function useFirstRunTour(): void {
  const tourDone = useModel(selectTourDone);
  const onboardingDone = useModel(selectOnboardingDone);
  const screen = useUi((u) => u.screen);
  const overlays = useUi((u) => u.overlays.length);
  const open = useUi((u) => u.tourOpen);
  const setTourOpen = useUi((u) => u.setTourOpen);
  const started = useRef(false);
  const ready =
    onboardingDone && !tourDone && screen !== 'onboarding' && overlays === 0 && !open && env().e2e !== true;
  useEffect(() => {
    if (!ready || started.current) return;
    // A beat after Home paints, so the anchors exist and the eye has landed.
    const t = setTimeout(() => {
      started.current = true;
      setTourOpen(true);
    }, 700);
    return () => clearTimeout(t);
  }, [ready, setTourOpen]);
}
