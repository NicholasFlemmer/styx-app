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
