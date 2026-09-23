import { MockFrame } from './demo/MockFrame';
import { WORKSPACE_FULL, WorkspaceMock } from './demo/WorkspaceMock';
import { SCREEN } from './screens/AppChrome';
import {
  AgentsScreen,
  ApprovalsScreen,
  DiffScreen,
  HomeScreen,
  OnboardingScreen,
  RepoScreen,
  SettingsScreen,
} from './screens/Screens';
import { Section } from './Section';
import styles from './ScreensStrip.module.css';

const scaleToScreen = SCREEN.w / WORKSPACE_FULL.w;

const screens = [
  ['Home', <HomeScreen key="home" />],
  [
    'Workspace',
    <div key="workspace" className={styles.letterbox}>
      <div
        style={{
          width: WORKSPACE_FULL.w,
          height: WORKSPACE_FULL.h,
          transform: `scale(${scaleToScreen})`,
          transformOrigin: '0 0',
        }}
      >
        <WorkspaceMock step="sheet" compact={false} chrome="mac" />
      </div>
    </div>,
  ],
  ['Agents', <AgentsScreen key="agents" />],
  ['Repo', <RepoScreen key="repo" />],
  ['Approvals', <ApprovalsScreen key="approvals" />],
  ['Diff review', <DiffScreen key="diff" />],
  ['Settings', <SettingsScreen key="settings" />],
  ['Onboarding', <OnboardingScreen key="onboarding" />],
] as const;

export const ScreensStrip = () => (
  <Section
    id="screens"
    title="The whole app, in one strip."
    lede="Eight screens, one language. Everything you saw above is in here, drawn from the same rules: one window, square dots, lime only where something needs you."
  >
    <div
      className={styles.strip}
      role="region"
      aria-label="Screens of the app, scrolls sideways"
      tabIndex={0}
    >
      {screens.map(([name, node]) => (
        <figure key={name} className={styles.shot}>
          <MockFrame full={SCREEN}>{node}</MockFrame>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </div>
  </Section>
);
