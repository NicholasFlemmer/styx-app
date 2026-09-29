import { BannerStack } from '../features/banners/BannerStack';
import { useUpdatePrompt } from '../features/modals/UpdateModal';
import { Tour, useFirstRunTour } from '../features/tour/Tour';
import { AppTitlebar } from '../features/titlebar/AppTitlebar';
import { useUi } from '../state/hooks';
import { AppRail } from './AppRail';
import { Nav } from './Nav';
import { Rail } from './Rail';
import { ScreenOutlet } from './ScreenOutlet';
import s from './Shell.module.css';

/**
 * Main-window layout (spec §3, owner layout #85): titlebar 38 / banners / body = app rail 56 · project rail 56 ·
 * project nav 168 · content. Onboarding hides all three.
 */
export function Shell() {
  const screen = useUi((u) => u.screen);
  const chromeHidden = screen === 'onboarding';
  // A downloaded update opens its dialog once per version (#119).
  useUpdatePrompt();
  // The first-run walkthrough starts itself once after onboarding (#124).
  useFirstRunTour();
  return (
    <div id="layer-app" className={s['shell']} data-chrome-hidden={chromeHidden ? 'true' : undefined}>
      <AppTitlebar />
      <BannerStack />
      <div className={s['body']}>
        {chromeHidden ? null : <AppRail />}
        {chromeHidden ? null : <Rail />}
        {chromeHidden ? null : <Nav />}
        <ScreenOutlet />
      </div>
      <Tour />
    </div>
  );
}
