import { BannerStack } from '../features/banners/BannerStack';
import { useUpdatePrompt } from '../features/modals/UpdateModal';
import { Tour, useFirstRunTour } from '../features/tour/Tour';
import { AppTitlebar } from '../features/titlebar/AppTitlebar';
import { isProjectSection, resolveSection } from '../screens/Settings/sections';
import { useModel, useUi } from '../state/hooks';
import { WORKSPACE_MODE_KEY, defaultInstrument, instrumentOf } from '../screens/Workspace/instruments';
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
  const appSettings = useUi(
    (u) => u.screen === 'settings' && !isProjectSection(resolveSection(u.settingsSection)),
  );
  // The Design tab gives the canvas the room the project nav took (#140); the nav is back on every other tab.
  const order = useModel((m) => m.settings.app.instrumentOrder);
  const designing = useUi(
    (u) =>
      u.screen === 'workspace' &&
      (u.newTask === null || u.newTask.projectId !== u.projectId) &&
      instrumentOf(u.paneSizes[WORKSPACE_MODE_KEY], defaultInstrument(order, false)) === 'canvas',
  );
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
        {chromeHidden || appSettings || designing ? null : <Nav />}
        <ScreenOutlet />
      </div>
      <Tour />
    </div>
  );
}
