// @vitest-environment jsdom
import { copy, fixtures, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { placeCard, Tour, useFirstRunTour } from './Tour';

const commandMock = vi.fn(async (_n: string, _i: unknown) => ({ ok: true, value: {} }));

const withSettings = (app: Partial<ReadModel['settings']['app']>): ReadModel => {
  const m = fixtures.demoReadModel();
  return { ...m, settings: { ...m.settings, app: { ...m.settings.app, ...app } } };
};

/** The window's anchors, each with a real size (jsdom lays nothing out). */
const ANCHORS = ['data-rail', 'data-titlebar-needs', 'data-app-rail-item', 'data-titlebar-palette'];
function Anchors({ without = [] as string[] }) {
  return (
    <div>
      {!without.includes('rail') && <nav data-rail="true">rail</nav>}
      {!without.includes('needs') && <span data-titlebar-needs="true">02 needs you</span>}
      {!without.includes('agents') && <button data-app-rail-item="agents">Agents</button>}
      {!without.includes('approvals') && <button data-app-rail-item="approvals">Approvals</button>}
      {!without.includes('palette') && <button data-titlebar-palette="true">Switch…</button>}
    </div>
  );
}

const counter = () => document.querySelector('[data-tour] p')?.textContent;
const stepKey = () => document.querySelector('[data-tour]')?.getAttribute('data-tour-step');

describe('first-run walkthrough (#124)', () => {
  let rect: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    commandMock.mockClear();
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useUiStore.setState({ overlays: [], tourOpen: false, screen: 'home', platform: 'darwin' });
    useReadModel.getState().replaceModel(withSettings({ tourDone: false }), 'connected');
    rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const sized = ANCHORS.some((a) => this.hasAttribute(a));
      return {
        x: 60,
        y: 40,
        left: 60,
        top: 40,
        width: sized ? 120 : 0,
        height: sized ? 30 : 0,
        right: 180,
        bottom: 70,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });
  afterEach(() => {
    cleanup();
    rect.mockRestore();
    vi.useRealTimers();
    Object.assign(window, { styx: undefined });
  });

  it('walks every step, pointing at the real thing, and marks itself seen when done', () => {
    render(
      <>
        <Anchors />
        <Tour />
      </>,
    );
    act(() => useUiStore.getState().setTourOpen(true));
    expect(screen.getByRole('dialog', { name: copy.tour.steps.rail.title })).toBeTruthy();
    expect(counter()).toBe('01 / 06');
    expect(document.querySelector('[data-tour-ring]')).not.toBeNull();
    // Focus is on Next, inside the card.
    expect(document.activeElement?.getAttribute('data-tour-next')).toBe('true');

    for (const key of ['needs', 'agents', 'approvals', 'palette', 'done']) {
      fireEvent.click(screen.getByRole('button', { name: key === 'done' ? copy.tour.next : copy.tour.next }));
      expect(stepKey()).toBe(key);
    }
    // The closing card: no anchor, no ring, Done instead of Next, the chord in words.
    expect(document.querySelector('[data-tour-ring]')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.tour.skip })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.tour.done }));
    expect(useUiStore.getState().tourOpen).toBe(false);
    expect(commandMock).toHaveBeenCalledWith('settings.set', { patch: { tourDone: true } });
  });

  it('skips a step whose anchor is not on screen', () => {
    render(
      <>
        <Anchors without={['approvals']} />
        <Tour />
      </>,
    );
    act(() => useUiStore.getState().setTourOpen(true));
    expect(counter()).toBe('01 / 05');
  });

  it('keyboard: → next, ← back, Esc skips and still counts as seen', () => {
    render(
      <>
        <Anchors />
        <Tour />
      </>,
    );
    act(() => useUiStore.getState().setTourOpen(true));
    const card = screen.getByRole('dialog');
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(stepKey()).toBe('needs');
    fireEvent.keyDown(card, { key: 'ArrowLeft' });
    expect(stepKey()).toBe('rail');
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(useUiStore.getState().tourOpen).toBe(false);
    expect(commandMock).toHaveBeenCalledWith('settings.set', { patch: { tourDone: true } });
  });

  it('replayed after it was seen, it does not write the setting again', () => {
    useReadModel.getState().replaceModel(withSettings({ tourDone: true }), 'connected');
    render(
      <>
        <Anchors />
        <Tour />
      </>,
    );
    act(() => useUiStore.getState().setTourOpen(true));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(commandMock).not.toHaveBeenCalled();
  });

  function Starter() {
    useFirstRunTour();
    return null;
  }

  it('starts by itself once after onboarding, on Home, with nothing else open', () => {
    render(<Starter />);
    act(() => vi.advanceTimersByTime(800));
    expect(useUiStore.getState().tourOpen).toBe(true);
  });

  it.each([
    [
      'already seen',
      () => useReadModel.getState().replaceModel(withSettings({ tourDone: true }), 'connected'),
    ],
    [
      'onboarding not finished',
      () => useReadModel.getState().replaceModel(withSettings({ onboardingDone: false }), 'connected'),
    ],
    ['not on Home', () => useUiStore.setState({ screen: 'workspace' })],
    [
      'a dialog is open',
      () =>
        useUiStore.setState({ overlays: [{ id: 'm', kind: 'modal', modal: 'sign-in', reason: 'welcome' }] }),
    ],
    [
      'under the e2e harness',
      () => Object.assign(window, { styx: { platform: 'darwin', env: { e2e: true }, command: commandMock } }),
    ],
  ])('does not start by itself when %s', (_, arrange) => {
    arrange();
    render(<Starter />);
    act(() => vi.advanceTimersByTime(2000));
    expect(useUiStore.getState().tourOpen).toBe(false);
  });

  it('places the card beside its anchor, inside the window', () => {
    const card = { w: 340, h: 200 };
    expect(placeCard({ x: 60, y: 40, w: 60, h: 400 }, card, 1400, 900)).toEqual({ x: 136, y: 40 });
    // No room on the right: to the left.
    expect(placeCard({ x: 1200, y: 10, w: 150, h: 30 }, card, 1400, 900)).toEqual({ x: 844, y: 16 });
    // The closing card: centred.
    expect(placeCard(null, card, 1400, 900)).toEqual({ x: 530, y: 350 });
  });
});
