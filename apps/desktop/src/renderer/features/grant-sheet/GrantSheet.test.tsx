// @vitest-environment jsdom
import { fixtures, type AskId, type ProjectId, type SessionId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { grantButtonLabel, grantPayload, scopeRows } from './grant-sheet';
import { GrantSheet } from './GrantSheet';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const codex = fixtures.ids.session.codex as SessionId;
const askId = fixtures.ids.ask.codexGrant as AskId;
const grantId = fixtures.ids.grant.supabaseCodex;

const flush = () => act(async () => {});

describe('grant sheet (pure)', () => {
  it('never widens the requested scope and reads the MFA suffix from the chosen scope', () => {
    expect(grantPayload(['read', 'write'], ['read', 'write', 'delete'], '1h')).toEqual({
      scope: ['read', 'write'],
      duration: '1h',
    });
    expect(grantButtonLabel('prod', ['read', 'write'], '1h', 'darwin')).toBe('Grant 1h · Touch ID');
    expect(grantButtonLabel('prod', ['read', 'write'], 'session', 'win32')).toBe(
      'Grant session · Windows Hello',
    );
    expect(grantButtonLabel('prod', ['read'], '1h', 'darwin')).toBe('Grant 1h');
    expect(grantButtonLabel('staging', ['write'], 'always', 'darwin')).toBe('Grant always');
  });

  it('lists the provider scopes with the requested ones first-class', () => {
    expect(scopeRows('supabase', ['read', 'write']).map((r) => [r.label, r.requested])).toEqual([
      ['Read schema', true],
      ['Write', true],
      ['Delete / drop', false],
    ]);
  });
});

describe('GrantSheet', () => {
  const commands: { name: string; input: unknown }[] = [];
  let result: { ok: boolean; value?: unknown; error?: unknown } = { ok: true, value: {} };

  beforeEach(() => {
    commands.length = 0;
    result = { ok: true, value: { grantId, expiresAt: null } };
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return result;
        }),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', platform: 'darwin', projectId: acme });
    document.body.innerHTML = '<div id="announcer"></div>';
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  const open = () => {
    const id = useUiStore.getState().pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId: codex, askId });
    render(<GrantSheet id={id} sessionId={codex} askId={askId} />);
    return id;
  };

  it('renders the request with pre-checked scopes, 1h chosen, and focus on Grant', () => {
    open();
    expect(screen.getByText('Codex · test/flaky')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toContain('Supabase / prod db');
    expect((screen.getByLabelText('Read schema') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Delete / drop') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('radio', { name: '1h' }).getAttribute('aria-checked')).toBe('true');
    const grant = screen.getByRole('button', { name: 'Grant 1h · Touch ID' });
    expect(document.activeElement).toBe(grant);
  });

  it('scope and duration drive the command payload; the MFA suffix follows the chosen scope', async () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'session' }));
    expect(screen.getByRole('button', { name: 'Grant session · Touch ID' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Write'));
    expect(screen.getByRole('button', { name: 'Grant session' })).toBeTruthy();
    // Delete / drop was not requested: it cannot be checked.
    fireEvent.click(screen.getByLabelText('Delete / drop'));
    expect((screen.getByLabelText('Delete / drop') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Grant session' }));
    expect(useUiStore.getState().overlays).toHaveLength(0);
    await flush();
    expect(commands).toEqual([
      { name: 'grant.approve', input: { grantId, duration: 'session', scope: ['read'] } },
    ]);
    expect(document.getElementById('announcer')?.textContent ?? '').toBe('');
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.getElementById('announcer')?.textContent).toBe(
      'Granted Codex read on Supabase prod for this session',
    );
  });

  it('Deny closes eagerly and sends grant.deny; Mod+Backspace does the same', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(useUiStore.getState().overlays).toHaveLength(0);
    await flush();
    expect(commands.map((c) => c.name)).toEqual(['grant.deny']);
    expect(commands[0]?.input).toEqual({ grantId });
  });

  it('re-opens with an inline error when grant.approve fails', async () => {
    result = { ok: false, error: { code: 'mfa-failed', message: 'Touch ID cancelled' } };
    const first = open();
    fireEvent.click(screen.getByRole('button', { name: 'Grant 1h · Touch ID' }));
    await flush();
    const sheets = useUiStore.getState().overlays.filter((o) => o.kind === 'sheet');
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.id).not.toBe(first);
    cleanup();
    const again = sheets[0]?.id ?? '';
    render(<GrantSheet id={again} sessionId={codex} askId={askId} />);
    expect(screen.getByRole('alert').textContent).toContain('Touch ID cancelled');
  });
});
