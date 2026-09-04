import { Banner, BannerStack as UiBannerStack } from '@styx/ui';
import { useEffect, useMemo, useRef } from 'react';
import { useNow, useUi, useUiShallow } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { deriveBanners, mergeBanners, type BannerAction } from './derive';

/** Banner actions dispatch navigation; the target flows (connect modal, repo lane) attach in later phases. */
export const runBannerAction = (action: BannerAction): void => {
  const ui = useUiStore.getState();
  switch (action.kind) {
    case 'reconnect':
      ui.setSettingsSection('targets');
      ui.setScreen('settings');
      return;
    case 'install-guide':
      ui.setSettingsSection('agents');
      ui.setScreen('settings');
      return;
    case 'resolve':
      ui.setScreen('repo');
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
          tone="error"
          text={b.text}
          action={{ label: b.cta, onClick: () => runBannerAction(b.action) }}
          onDismiss={() => dismissBanner(b.key)}
          data-banner-key={b.key}
        />
      ))}
    </UiBannerStack>
  );
}
