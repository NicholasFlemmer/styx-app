import type { Container } from '../../container';
import { bannersToReemit } from '../../services/notification-service';
import type { CommandBus } from '../bus';

/** store.snapshot · settings.* · ui.persist · onboarding.complete · notify.* */
export function registerStoreCommands(bus: CommandBus, app: Container): void {
  const { repos, publisher } = app;

  bus.register('store.snapshot', () => {
    const snapshot = publisher.snapshot();
    // Persistent banners (notifications.banner_key, state 'shown') survive restarts: re-emit them to the window that
    // just connected until the underlying condition resolves (spec §4.14 / plan §5 NotificationService).
    for (const b of bannersToReemit(repos)) publisher.sendEvent('banner.set', b);
    return snapshot;
  });

  bus.register('settings.get', () => ({ app: repos.settings.app() }));

  bus.register('settings.set', ({ patch }) => {
    const next = repos.settings.patch(patch);
    if (patch.fallbackIde !== undefined) {
      repos.discovery.setFallback(patch.fallbackIde);
      publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    }
    if (patch.dnd !== undefined) app.notifications?.setDnd(patch.dnd);
    publisher.settingsSet(next);
    app.onAppSettings(next);
    // Tracking agent edits starts or stops the worktree watchers for the sessions that are live right now.
    if (patch.trackAgentEdits !== undefined) void app.hunks.applyTracking();
    return {};
  });

  bus.register('ui.persist', (input) => {
    if (input.screen !== undefined) repos.uiState.set('screen', input.screen);
    if (input.projectId !== undefined) repos.uiState.set('projectId', input.projectId);
    if (input.projectSession !== undefined) repos.uiState.set('projectSession', input.projectSession);
    if (input.paneSizes !== undefined)
      repos.uiState.set('paneSizes', {
        ...(repos.uiState.get<Record<string, number>>('paneSizes') ?? {}),
        ...input.paneSizes,
      });
    return {};
  });

  bus.register('onboarding.complete', () => {
    publisher.settingsSet(repos.settings.patch({ onboardingDone: true }));
    return {};
  });

  bus.register('notify.setDnd', ({ dnd }) => {
    app.notifications?.setDnd(dnd);
    publisher.settingsSet(repos.settings.patch({ dnd }));
    return {};
  });

  bus.register('notify.later', ({ notificationId }) => {
    const n = repos.notifications.get(notificationId);
    if (n && n.state === 'shown') {
      repos.notifications.upsert({ ...n, state: 'later' });
      publisher.upsert('notifications', [n.id]);
    }
    return {};
  });
}
