import { fixtures, hasSeqGap, type DeltaBatch } from '@styx/core';
import { bridge, hasSnapshot, onEvent, windowKind } from './bridge';
import { useReadModel } from './read-model';
import { startUiPersistence } from './persist-ui';
import { useUiStore } from './ui-store';

/**
 * Snapshot → sequenced deltas → gap resync (plan §8). Deltas that arrive while a snapshot is in flight are
 * queued and replayed in order; a batch whose seq is not `seq + 1` triggers another `snapshot()`.
 */
export const connectSync = (): (() => void) => {
  const store = useReadModel.getState();
  const api = bridge();

  // ---------------------------------------------------------------------------------------------------------
  // DEV FALLBACK (remove once main's preload exposes `snapshot`): hydrate from the core demo fixture so
  // `pnpm dev` and vitest render a populated shell before the main-process bridge lands.
  // ---------------------------------------------------------------------------------------------------------
  if (api === null || !hasSnapshot()) {
    console.warn(
      '[styx] window.styx.snapshot missing — hydrating from fixtures.demoReadModel() (dev fallback)',
    );
    const model = fixtures.demoReadModel();
    store.replaceModel(model, 'fixture');
    useUiStore.getState().resolveInitialScreen(model);
    return () => {};
  }

  let disposed = false;
  let syncing = false;
  const queue: DeltaBatch[] = [];
  // What the person is looking at goes back to main as it changes, so the next launch opens there.
  const stopPersist = windowKind() === 'main' ? startUiPersistence() : () => {};

  const drain = (): boolean => {
    queue.sort((a, b) => a.seq - b.seq);
    while (queue.length > 0) {
      const batch = queue[0];
      if (batch === undefined) break;
      const { model } = useReadModel.getState();
      if (batch.seq <= model.seq) {
        queue.shift();
        continue;
      }
      if (hasSeqGap(model, batch)) return false;
      queue.shift();
      useReadModel.getState().applyDeltas(batch);
    }
    return true;
  };

  const resync = async (): Promise<void> => {
    if (syncing || disposed) return;
    syncing = true;
    useReadModel.getState().setConnection('connecting');
    try {
      const snapshot = await api.snapshot?.();
      if (disposed || snapshot === undefined) return;
      useReadModel.getState().applySnapshot(snapshot);
      useUiStore.getState().hydratePersisted(snapshot.ui);
      useUiStore.getState().resolveInitialScreen(useReadModel.getState().model);
    } catch (err) {
      console.error('[styx] store.snapshot failed', err);
    } finally {
      syncing = false;
    }
    if (!drain()) void resync();
  };

  const offDelta =
    api.onDelta?.((batch) => {
      if (disposed) return;
      if (syncing) {
        queue.push(batch);
        return;
      }
      const result = useReadModel.getState().applyDeltas(batch);
      if (result === 'gap') {
        queue.push(batch);
        void resync();
      }
    }) ?? (() => {});

  const offBannerSet = onEvent('banner.set', (b) => useUiStore.getState().setBanner(b));
  const offBannerClear = onEvent('banner.clear', ({ bannerKey }) =>
    useUiStore.getState().clearBanner(bannerKey),
  );
  // Tray left-click / dock-menu items (spec §4.14) route the main window to a screen.
  const offNavGo = onEvent('nav.go', ({ screen }) => useUiStore.getState().setScreen(screen));
  // Stop returned the session's queued messages: they go back into its composer, oldest first, blank-line separated.
  const offQueueReturned = onEvent('queue.returned', ({ sessionId, bodies }) => {
    if (bodies.length > 0) useUiStore.getState().prefillDraft(sessionId, bodies.join('\n\n'));
  });
  // A card in the agent dock: bring that session forward here. Only the main window acts on it — a pop-out
  // shows one fixed session and the dock is the sender.
  const offFocusSession = onEvent('session.focus', ({ sessionId }) => {
    if (windowKind() !== 'main') return;
    const session = useReadModel.getState().model.sessions.byId[sessionId];
    if (session === undefined) return;
    useUiStore.getState().openSession(session.projectId, session.id);
  });

  void resync();

  return () => {
    disposed = true;
    stopPersist();
    offDelta();
    offFocusSession();
    offBannerSet();
    offBannerClear();
    offNavGo();
    offQueueReturned();
  };
};
