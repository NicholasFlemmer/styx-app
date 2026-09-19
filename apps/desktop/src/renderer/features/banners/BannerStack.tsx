import type { ProjectId } from '@styx/core';
import { command } from '../../state/commands';
import { Banner, BannerStack as UiBannerStack } from '@styx/ui';
import { useEffect, useMemo, useRef } from 'react';
import { useNow, useUi, useUiShallow } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { deriveBanners, mergeBanners, type BannerAction } from './derive';

/** Repo-authored grant policies are advisory until accepted (security audit H-1): banner keys `project-policy:<projectId>`. */
export const PROJECT_POLICY_BANNER = 'project-policy:';

/** `Review` on a project-policy banner: select the project and open Settings › Project › Targets (the accept row lives there). */
export const reviewProjectPolicy = (projectId: ProjectId): void => {
  const ui = useUiStore.getState();
  ui.setProject(projectId);
  ui.setSettingsSection('project:targets');
  ui.setScreen('settings');
};

/** Banner actions: Reconnect opens the connect modal on the expired target; the others navigate. */
export const runBannerAction = (action: BannerAction): void => {
  const ui = useUiStore.getState();
  switch (action.kind) {
    case 'reconnect': {
      // Opens the connect modal on that target; a CLI-backed target starts its login terminal as the modal opens.
      const target = useReadModel.getState().model.targets.byId[action.targetId];
      if (target !== undefined) {
        ui.pushOverlay({
          kind: 'modal',
          modal: 'connect',
          projectId: target.projectId,
          provider: target.provider,
          targetId: target.id,
        });
        return;
      }
      ui.setSettingsSection('project:targets');
      ui.setScreen('settings');
      return;
    }
    case 'install-guide':
      ui.setSettingsSection('app:agents');
      ui.setScreen('settings');
      return;
    case 'resolve':
      // ADR-0025 phase B: the banner's Resolve asks the lane's agent to finish the merge, and shows the lane.
      void command('worktree.resolve', { worktreeId: action.worktreeId });
      ui.setScreen('repo');
      return;
    case 'review-project-policy':
      reviewProjectPolicy(action.projectId);
      return;
  }
};

/** Error banners under the titlebar: `banner.set/clear` events merged with rows derived from the model. */
export function BannerStack() {
  const model = useReadModel((s) => s.model);
  const now = useNow();
  const events = useUi((s) => s.banners);
  const dismissed = useUiShallow((s) => s.dismissedBanners);
  const dismissBanner = useUi((s) => s.dismissBanner);
  const banners = useMemo(
    () => mergeBanners(deriveBanners(model, now), events, dismissed),
    [model, now, events, dismissed],
  );
  const root = useRef<HTMLDivElement>(null);

  // Publishes the stack height so overlays anchored to the content region (sheet, drawer) start below it.
  useEffect(() => {
    const el = root.current;
    const publish = () => {
      document.documentElement.style.setProperty('--h-banners', `${el?.offsetHeight ?? 0}px`);
    };
    publish();
    if (el === null || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [banners.length]);

  if (banners.length === 0) return <div ref={root} data-banners="0" />;
  return (
    <UiBannerStack ref={root} data-banners={banners.length}>
      {banners.map((b) => (
        <Banner
          key={b.key}
          tone={b.kind === 'project-policy' ? 'info' : 'error'}
          text={b.text}
          action={{ label: b.cta, onClick: () => runBannerAction(b.action) }}
          onDismiss={() => dismissBanner(b.key)}
          data-banner-key={b.key}
        />
      ))}
    </UiBannerStack>
  );
}
