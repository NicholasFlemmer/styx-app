// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { BannerStack } from './BannerStack';

const acme = fixtures.ids.project.acmeShop;

describe('<BannerStack /> project-policy banner (security H-1)', () => {
  beforeEach(() => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'fixture');
    useUiStore.setState({ projectId: null, screen: 'home', settingsSection: 'app:general', banners: {}, dismissedBanners: [] });
    useUiStore.getState().setBanner({
      bannerKey: `project-policy:${acme}`,
      kind: 'project-policy',
      text: "acme-shop's .styx/project.json wants to change grant policies. Review in Settings.",
      cta: copy.errors.projectPolicyUntrusted.cta,
      action: { kind: 'review-project-policy', projectId: acme, hash: 'sha256:abc' },
      sessionId: null,
      reason: null,
    });
  });
  afterEach(cleanup);

  it('is informational (status, not alert) and Review opens Settings › Project › Targets for that project', () => {
    render(<BannerStack />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.errors.projectPolicyUntrusted.cta }));
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('settings');
    expect(ui.settingsSection).toBe('project:targets');
    expect(ui.projectId).toBe(acme);
  });
});

describe('<BannerStack /> auth-expired banner', () => {
  beforeEach(() => {
    useReadModel.getState().replaceModel(fixtures.errorReadModel(), 'fixture');
    useUiStore.setState({
      projectId: acme,
      screen: 'workspace',
      settingsSection: 'app:general',
      overlays: [],
      banners: {},
      dismissedBanners: [],
    });
  });
  afterEach(cleanup);

  it('Reconnect opens the connect modal on the expired target (provider + targetId), not Settings', () => {
    render(<BannerStack />);
    const texts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(texts.some((x) => x?.includes('AWS acme-prod: credentials expired'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: copy.errors.authExpired.cta }));
    const ui = useUiStore.getState();
    expect(ui.overlays).toMatchObject([
      {
        kind: 'modal',
        modal: 'connect',
        projectId: acme,
        provider: 'aws',
        targetId: fixtures.ids.target.awsProd,
      },
    ]);
    expect(ui.screen).toBe('workspace');
  });
});
