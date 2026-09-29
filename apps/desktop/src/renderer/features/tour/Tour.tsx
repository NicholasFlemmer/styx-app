import { copy, fill, formatChord, type ReadModel } from '@styx/core';
import { shortcuts } from '@styx/tokens';
import { Button, useFocusTrap, useReturnFocus } from '@styx/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { env, platform } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './Tour.module.css';

/**
 * First-run walkthrough (owner request, #124): one card per part of the window, pointed at the real thing, with
 * the rest dimmed. Steps whose anchor is not on screen are skipped rather than pointed at nothing; the last card
 * has no anchor and sits in the middle. Finishing or skipping marks it seen; the palette plays it again.
 */

type StepKey = keyof typeof copy.tour.steps;
interface Step {
  key: StepKey;
  /** Where the card points; null = the closing card, centred. */
  anchor: string | null;
}

export const TOUR_STEPS: readonly Step[] = [
  { key: 'rail', anchor: '[data-rail="true"]' },
  { key: 'needs', anchor: '[data-titlebar-needs="true"]' },
  { key: 'agents', anchor: '[data-app-rail-item="agents"]' },
  { key: 'approvals', anchor: '[data-app-rail-item="approvals"]' },
  { key: 'palette', anchor: '[data-titlebar-palette="true"]' },
  { key: 'done', anchor: null },
];

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
  // Only the steps whose anchor exists right now; the closing card always does.
  const steps = useMemo(() => TOUR_STEPS.filter((st) => st.anchor === null || boxOf(st.anchor) !== null), []);
  const [i, setI] = useState(0);
  // Re-rendered on resize; the anchor and window are read fresh on every render, so nothing goes stale.
  const [, setTick] = useState(0);
  const [cardH, setCardH] = useState(200);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const step = steps[Math.min(i, steps.length - 1)] ?? { key: 'done' as const, anchor: null };
  const last = i >= steps.length - 1;
  const chord = formatChord(shortcuts.palette, platform());

  useReturnFocus(true);
  useFocusTrap(card, { active: true, initialFocus: primary });

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
  const hole = step.anchor === null ? null : boxOf(step.anchor);
  const view = { w: window.innerWidth, h: window.innerHeight };
  // The new step's primary button takes focus, so a screen reader reads the card that just appeared.
  useEffect(() => primary.current?.focus(), [i]);

  const next = () => (last ? onClose(true) : setI((n) => n + 1));
  const back = () => setI((n) => Math.max(0, n - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(false);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    }
  };

  const pos = placeCard(hole, { w: CARD_W, h: cardH }, view.w, view.h);
  const text = copy.tour.steps[step.key];
  const titleId = `tour-title-${step.key}`;
  const bodyId = `tour-body-${step.key}`;

  return (
    <div className={s['root']} data-tour="true" data-tour-step={step.key}>
      {/* The dim, with a hole where the anchor is: four panes around it, or one pane for the closing card. */}
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
        aria-label={copy.tour.label}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y, width: CARD_W }}
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
            <Button variant="ghost" onClick={() => onClose(false)} data-tour-skip="true">
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
  const close = useCallback(
    (_finished: boolean) => {
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
 * Starts the walkthrough once, for someone who has just finished onboarding and has never seen it: on Home, with
 * nothing else on screen (the welcome sign-in dialog goes first). Never under the e2e harness, whose screens it
 * would cover; the palette row still opens it there.
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
    onboardingDone && !tourDone && screen === 'home' && overlays === 0 && !open && env().e2e !== true;
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
