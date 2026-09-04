// @vitest-environment jsdom
import { fixtures, type AuditId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { AuditDrawer } from './AuditDrawer';

const commandMock = vi.fn(async () => ({ ok: true, value: {} }));
const writeText = vi.fn(async (_text: string) => undefined);

const open = (auditId: AuditId) => {
  const id = useUiStore.getState().pushOverlay({ kind: 'drawer', drawer: 'audit', auditId });
  render(<AuditDrawer id={id} auditId={auditId} />);
  return id;
};

describe('AuditDrawer', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'approvals', platform: 'darwin' });
    commandMock.mockClear();
    writeText.mockClear();
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the granted entry: title, meta and the eight detail rows', () => {
    open(fixtures.ids.audit(3));
    const dialog = screen.getByRole('dialog', { name: 'Audit entry' });
    expect(dialog.textContent).toContain('granted deploy to Claude · 1h');
    expect(screen.getByText('09:12 · you → vercel-prod')).toBeTruthy();
    for (const [k, v] of [
      ['Actor', 'you'],
      ['Target', 'vercel-prod'],
      ['Scope', 'deploy'],
      ['Duration', '1h · expires 10:12'],
      ['Session', 'claude · acme-shop'],
      ['Worktree', 'fix/checkout'],
      ['Triggered by', 'grant sheet'],
      ['Policy', '#2 Always ask, require Touch ID for prod write'],
    ]) {
      expect(screen.getByText(k as string)).toBeTruthy();
      expect(screen.getByText(v as string)).toBeTruthy();
    }
  });

  it('Copy JSON writes the entry as JSON; Revoke now revokes the user-issued active grant and closes', async () => {
    open(fixtures.ids.audit(3));
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const json = JSON.parse(writeText.mock.calls[0]?.[0] ?? '') as {
      id: string;
      action: string;
    };
    expect(json.id).toBe(fixtures.ids.audit(3));
    expect(json.action).toBe('granted');

    const revoke = screen.getByRole('button', { name: 'Revoke now' }) as HTMLButtonElement;
    expect(revoke.disabled).toBe(false);
    fireEvent.click(revoke);
    expect(commandMock).toHaveBeenCalledWith('grant.revoke', {
      grantId: fixtures.ids.grant.vercelProdClaude,
      triggeredBy: 'audit drawer',
    });
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
  });

  it.each([
    ['system-issued expiry', fixtures.ids.audit(2)],
    ['agent request without a live grant', fixtures.ids.audit(4)],
    ['entry without a grant', fixtures.ids.audit(1)],
  ])('Revoke now is disabled for %s', (_name, auditId) => {
    open(auditId);
    expect((screen.getByRole('button', { name: 'Revoke now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('✕ pops the overlay; an unknown entry closes itself', () => {
    const id = open(fixtures.ids.audit(5));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().overlays.some((o) => o.id === id)).toBe(false);
    cleanup();
    open('01JDEMOAUDIT00000000999999' as AuditId);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });
});
