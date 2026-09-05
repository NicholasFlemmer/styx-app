// @vitest-environment jsdom
import {
  fixtures,
  upsertRows,
  type ProjectId,
  type ReadModel,
  type Session,
  type SessionId,
} from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ChatPane } from './ChatPane';
import { inlineSegments, transcriptItems } from './transcript-items';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;
const codex = fixtures.ids.session.codex as SessionId;

const flush = () => act(async () => {});

describe('transcript items', () => {
  it('maps the Codex transcript onto message kinds with lowercase scope labels', () => {
    const items = transcriptItems(fixtures.demoReadModel(), codex);
    expect(items.map((i) => i.kind)).toEqual(['user', 'agent', 'accessRequest']);
    const card = items[2];
    expect(card?.kind === 'accessRequest' && card.scopes).toEqual(['read schema', 'write']);
    expect(card?.kind === 'accessRequest' && card.target).toBe('Supabase');
    expect(card?.kind === 'accessRequest' && card.env).toBe('prod');
  });

  it('drops the access-request card once the grant is decided', () => {
    const model = fixtures.demoReadModel();
    const grant = model.grants.byId[fixtures.ids.grant.supabaseCodex];
    if (grant === undefined) throw new Error('fixture');
    const decided: ReadModel = {
      ...model,
      grants: upsertRows(model.grants, [{ ...grant, state: 'denied' }]),
    };
    expect(transcriptItems(decided, codex).map((i) => i.kind)).toEqual(['user', 'agent']);
  });

  it('shows −0 only for files the agent modified (prototype file list)', () => {
    const files = transcriptItems(fixtures.demoReadModel(), claude).find((i) => i.kind === 'fileList');
    expect(files?.kind === 'fileList' && files.files).toEqual([
      { path: 'validate.ts', added: 31 },
      { path: 'checkout.ts', added: 2, removed: 0 },
      { path: 'checkout.test.ts', added: 44 },
    ]);
  });

  it('splits file names out of body text', () => {
    expect(inlineSegments('Read checkout.ts and pay.ts.')).toEqual([
      { text: 'Read ', code: false },
      { text: 'checkout.ts', code: true },
      { text: ' and ', code: false },
      { text: 'pay.ts', code: true },
      { text: '.', code: false },
    ]);
  });
});

describe('ChatPane', () => {
  const commands: { name: string; input: unknown }[] = [];

  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return { ok: true, value: {} };
        }),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the project tabs with the first session current and the meta line', () => {
    render(<ChatPane projectId={acme} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Claude', 'Codex!', 'Gemini']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('claude · fix/checkout · 14m')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message Claude…')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /^\+/ })).toBeNull();
  });

  it('folds sessions beyond three into the ▾ tab; picking one switches the session', () => {
    const model = fixtures.demoReadModel();
    const base = model.sessions.byId[fixtures.ids.session.gemini];
    if (base === undefined) throw new Error('fixture');
    const extra: Session[] = [1, 2].map((n) => ({
      ...base,
      id: `extra-${n}` as SessionId,
      startedAt: base.startedAt + n,
    }));
    useReadModel
      .getState()
      .replaceModel({ ...model, sessions: upsertRows(model.sessions, extra) }, 'connected');
    render(<ChatPane projectId={acme} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Claude',
      'Codex!',
      'Gemini',
      '+2',
    ]);
    fireEvent.click(screen.getByRole('tab', { name: '+2' }));
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    fireEvent.click(items[1] as HTMLElement);
    expect(useUiStore.getState().projectSession[acme]).toBe('extra-2');
    // The picked overflow session takes slot 3.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Claude',
      'Codex!',
      'Gemini',
      '+2',
    ]);
  });

  it('routes the access-request card: Review request opens the sheet, Deny sends grant.deny', async () => {
    useUiStore.getState().setSession(acme, codex);
    render(<ChatPane projectId={acme} />);
    expect(screen.getByText('codex · test/flaky · 3m · waiting on you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review request' }));
    const sheet = useUiStore.getState().overlays.find((o) => o.kind === 'sheet');
    expect(sheet?.kind === 'sheet' && sheet.askId).toBe(fixtures.ids.ask.codexGrant);
    expect(sheet?.kind === 'sheet' && sheet.sessionId).toBe(codex);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await flush();
    expect(commands).toEqual([{ name: 'grant.deny', input: { grantId: fixtures.ids.grant.supabaseCodex } }]);
  });

  it('⏎ in the composer sends session.sendMessage for the active session', async () => {
    render(<ChatPane projectId={acme} />);
    const box = screen.getByPlaceholderText('Message Claude…');
    fireEvent.change(box, { target: { value: 'ship it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(commands).toEqual([
      { name: 'session.sendMessage', input: { sessionId: claude, body: 'ship it' } },
    ]);
  });

  it('+ opens the spawn modal and ⤢ pops the chat out', async () => {
    render(<ChatPane projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: 'Spawn agent' }));
    expect(useUiStore.getState().overlays.some((o) => o.kind === 'modal')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pop out chat' }));
    await flush();
    expect(commands).toEqual([{ name: 'window.popout', input: { sessionId: claude } }]);
  });
});
