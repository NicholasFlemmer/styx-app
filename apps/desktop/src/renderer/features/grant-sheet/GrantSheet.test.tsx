// @vitest-environment jsdom
import { copy, fill, fixtures, platformCopy, type AskId, type ProjectId, type SessionId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { credentialScopedOf, durationChoice, grantButtonLabel, grantPayload, scopeRows } from './grant-sheet';
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
    const prod = { env: 'prod', policy: 'ask' } as const;
    expect(grantButtonLabel(prod, ['read', 'write'], '1h', 'darwin', true)).toBe('Grant 1h · Touch ID');
    expect(grantButtonLabel(prod, ['read', 'write'], 'session', 'win32', true)).toBe(
      'Grant session · Windows Hello',
    );
    expect(grantButtonLabel(prod, ['write'], 'once', 'linux', false)).toBe('Grant once · system password');
    expect(grantButtonLabel(prod, ['read'], '1h', 'darwin', true)).toBe('Grant 1h');
    // A prod read on a token that can't be narrowed still asks main for Touch ID: the button says so.
    expect(grantButtonLabel(prod, ['read'], '1h', 'darwin', false)).toBe('Grant 1h · Touch ID');
    expect(grantButtonLabel({ env: 'staging', policy: 'ask-mfa' }, ['read'], '1h', 'darwin', true)).toBe(
      'Grant 1h · Touch ID',
    );
    expect(grantButtonLabel({ env: 'staging', policy: 'ask' }, ['write'], 'always', 'darwin', false)).toBe(
      'Grant always',
    );
  });

  it('offers only once for a prod write on a token that cannot be narrowed (issue #29)', () => {
    const enabled = (c: ReturnType<typeof durationChoice>) =>
      c.options.filter((o) => !o.disabled).map((o) => o.value);
    const capped = durationChoice('prod', ['read', 'write'], false, '1h');
    expect(capped).toMatchObject({ value: 'once', onceOnly: true });
    expect(enabled(capped)).toEqual(['once']);
    expect(capped.options.map((o) => o.label)).toEqual(['once', '1h', 'session', 'always']);
    for (const [env, scope, scoped] of [
      ['prod', ['read'], false],
      ['prod', ['write'], true],
      ['staging', ['write'], false],
      ['preview', ['deploy'], false],
    ] as const) {
      const c = durationChoice(env, scope, scoped, 'session');
      expect(c).toMatchObject({ value: 'session', onceOnly: false });
      expect(enabled(c)).toEqual(['once', '1h', 'session', 'always']);
    }
    expect(credentialScopedOf(undefined)).toBe(false);
    expect(credentialScopedOf({ kind: 'grant', grantId: grantId as never })).toBe(false);
    expect(credentialScopedOf({ kind: 'grant', grantId: grantId as never, credentialScoped: true })).toBe(
      true,
    );
    expect(credentialScopedOf({ kind: 'question', prompt: 'q' })).toBe(false);
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

  /** The demo's Codex ask, as main would send it for an adapter that narrows the credential (AWS with a role). */
  const asScoped = () => {
    const m = fixtures.demoReadModel();
    const ask = m.pendingAsks.byId[askId];
    if (ask === undefined || ask.payload.kind !== 'grant') throw new Error('fixture ask');
    const scoped = { ...ask, payload: { ...ask.payload, credentialScoped: true } };
    useReadModel
      .getState()
      .replaceModel(
        { ...m, pendingAsks: { ...m.pendingAsks, byId: { ...m.pendingAsks.byId, [askId]: scoped } } },
        'connected',
      );
  };
  const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLButtonElement;

  it('renders the request with pre-checked scopes, and on a token that cannot be narrowed offers only once (issue #29)', () => {
    open();
    expect(screen.getByText('Codex · test/flaky')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toContain('Supabase / prod db');
    expect((screen.getByLabelText('Read schema') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Delete / drop') as HTMLInputElement).checked).toBe(false);
    expect(radio('once').getAttribute('aria-checked')).toBe('true');
    expect(radio('once').disabled).toBe(false);
    for (const d of ['1h', 'session', 'always']) expect(radio(d).disabled).toBe(true);
    const note = fill(copy.grantSheet.onceOnlyNote, { mfa: platformCopy('darwin').mfa });
    const group = screen.getByRole('radiogroup', { name: copy.grantSheet.durationLabel });
    const describedBy = group.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(note);
    const grant = screen.getByRole('button', { name: 'Grant once · Touch ID' });
    expect(document.activeElement).toBe(grant);
  });

  it('once only: Grant sends once; unchecking the write lifts the cap (a read keeps the longer durations)', async () => {
    open();
    // A disabled chip cannot be picked.
    fireEvent.click(radio('session'));
    expect(screen.getByRole('button', { name: 'Grant once · Touch ID' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Write'));
    expect(radio('1h').getAttribute('aria-checked')).toBe('true');
    expect(radio('always').disabled).toBe(false);
    expect(screen.getByRole('dialog').textContent).toContain(
      fill(copy.grantSheet.prodNote, { mfa: platformCopy('darwin').mfa }),
    );
    // Supabase's token still goes whole to the agent on prod, so even a read asks for Touch ID.
    expect(screen.getByRole('button', { name: 'Grant 1h · Touch ID' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Write'));
    fireEvent.click(screen.getByRole('button', { name: 'Grant once · Touch ID' }));
    await flush();
    expect(commands).toEqual([
      { name: 'grant.approve', input: { grantId, duration: 'once', scope: ['read', 'write'] } },
    ]);
    expect(document.getElementById('announcer')?.textContent ?? '').toBe('');
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.getElementById('announcer')?.textContent).toBe(
      'Granted Codex read, write on Supabase prod for one command',
    );
  });

  it('scope and duration drive the command payload; the MFA suffix follows the chosen scope', async () => {
    asScoped();
    open();
    expect(radio('1h').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Grant 1h · Touch ID' })).toBeTruthy();
    fireEvent.click(radio('session'));
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
    fireEvent.click(screen.getByRole('button', { name: 'Grant once · Touch ID' }));
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
