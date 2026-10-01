import { BannerStack } from '../features/banners/BannerStack';
import { useUpdatePrompt } from '../features/modals/UpdateModal';
import { Tour, useFirstRunTour } from '../features/tour/Tour';
import { AppTitlebar } from '../features/titlebar/AppTitlebar';
import { isProjectSection, resolveSection } from '../screens/Settings/sections';
import { useUi } from '../state/hooks';
import { AppRail, RailSettings } from './AppRail';
import { Nav } from './Nav';
import { Rail } from './Rail';
import { ScreenOutlet } from './ScreenOutlet';
import s from './Shell.module.css';

/**
 * Main-window layout (ADR-0027 §5): titlebar 38 / banners / body = one rail column 56 (the app's places, the
 * project tiles, Settings) · project nav 216 · content. Onboarding hides both.
 */
export function Shell() {
  const screen = useUi((u) => u.screen);
  const chromeHidden = screen === 'onboarding';
  // App settings stand apart from the project: no project nav beside them (its own options open with it).
  const appSettings = useUi((u) => u.screen === 'settings' && !isProjectSection(resolveSection(u.settingsSection)));
  // A downloaded update opens its dialog once per version (#119).
  useUpdatePrompt();
  // The first-run walkthrough starts itself once after onboarding (#124).
  useFirstRunTour();
  return (
    <div id="layer-app" className={s['shell']} data-chrome-hidden={chromeHidden ? 'true' : undefined}>
      <AppTitlebar />
      <BannerStack />
      <div className={s['body']}>
        {chromeHidden ? null : (
          <div className={s['rails']} data-rails="true">
            <AppRail />
            <div className={s['railsDivider']} role="presentation" />
            <Rail />
            <RailSettings />
          </div>
        )}
        {chromeHidden || appSettings ? null : <Nav />}
        <ScreenOutlet />
      </div>
      <Tour />
    </div>
  );
}
