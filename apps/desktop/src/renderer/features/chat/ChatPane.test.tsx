// @vitest-environment jsdom
import {
  copy,
  fixtures,
  upsertRows,
  type AskQuestion,
  type ModelInfo,
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

/** Codex `model/list` as the app-server runner stores it on the CLI row (docs/research/agent-parity.md §2.4). */
const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'xhigh',
    isDefault: false,
    hidden: false,
  },
];

/** The demo Codex session moved onto the app-server: stream runner, idle, a model and effort set, tokens counted. */
const codexLive = (patch: Partial<Session> = {}): ReadModel => {
  const model = fixtures.demoReadModel();
  const s = model.sessions.byId[codex];
  if (s === undefined) throw new Error('fixture');
  return {
    ...model,
    discovery: {
      ...model.discovery,
      clis: model.discovery.clis.map((c) =>
        c.agent === 'codex'
          ? { ...c, capabilities: { ...c.capabilities, appServer: true, models: CODEX_MODELS } }
          : c,
      ),
    },
    sessions: upsertRows(model.sessions, [
      {
        ...s,
        runner: 'stream',
        state: 'idle',
        model: 'gpt-6-astra',
        effort: 'ultra',
        tokensUsed: 14574,
        costUsd: 0,
        numTurns: 1,
        ...patch,
      },
    ]),
  };
};

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

  it('maps tool payloads to tool rows and decision rows carry chosen/open', () => {
    const model = fixtures.demoReadModel();
    const base = model.transcripts[claude]?.[0];
    if (base === undefined) throw new Error('fixture');
    const ask = model.pendingAsks.byId[fixtures.ids.ask.codexGrant];
    if (ask === undefined) throw new Error('fixture');
    const resolvedAsk = {
      ...ask,
      id: 'ask-res' as typeof ask.id,
      state: 'resolved' as const,
      sessionId: claude,
    };
    const withRows: ReadModel = {
      ...model,
      pendingAsks: upsertRows(model.pendingAsks, [resolvedAsk]),
      transcripts: {
        ...model.transcripts,
        [claude]: [
          {
            ...base,
            id: 'm-tool' as typeof base.id,
            seq: 100,
            body: '',
            askId: null,
            payload: {
              kind: 'tool',
              tool: 'Bash',
              hint: 'pnpm test',
              toolUseId: 't1',
              status: 'error',
              detail: 'exit 1',
            },
          },
          {
            ...base,
            id: 'm-dec' as typeof base.id,
            seq: 101,
            body: 'Run it?',
            askId: resolvedAsk.id,
            payload: { kind: 'decision', options: ['Allow', 'Deny'], chosen: 'Deny' },
          },
        ],
      },
    };
    const items = transcriptItems(withRows, claude);
    expect(items[0]).toEqual({
      id: 'm-tool',
      kind: 'tool',
      tool: 'Bash',
      hint: 'pnpm test',
      status: 'error',
      detail: 'exit 1',
    });
    expect(items[1]).toMatchObject({ kind: 'decision', chosen: 'Deny', open: false, askId: resolvedAsk.id });
    // Prototype rows have no ask: always answerable.
    const demo = transcriptItems(model, claude).find((i) => i.kind === 'decision');
    expect(demo).toMatchObject({ chosen: null, open: true, askId: null });
  });

  it('agent rows carry streaming; thinking rows map status and duration', () => {
    const model = fixtures.demoReadModel();
    const base = model.transcripts[claude]?.[0];
    if (base === undefined) throw new Error('fixture');
    const withRows: ReadModel = {
      ...model,
      transcripts: {
        ...model.transcripts,
        [claude]: [
          {
            ...base,
            id: 'm-th' as typeof base.id,
            seq: 100,
            body: 'hmm',
            askId: null,
            payload: { kind: 'thinking', status: 'done', durationMs: 4200 },
          },
          {
            ...base,
            id: 'm-ag' as typeof base.id,
            seq: 101,
            body: 'Rea',
            askId: null,
            payload: { kind: 'agent', streaming: true },
          },
          {
            ...base,
            id: 'm-ag2' as typeof base.id,
            seq: 102,
            body: 'Done.',
            askId: null,
            payload: { kind: 'agent' },
          },
        ],
      },
    };
    expect(transcriptItems(withRows, claude)).toEqual([
      { id: 'm-th', kind: 'thinking', text: 'hmm', status: 'done', durationMs: 4200 },
      { id: 'm-ag', kind: 'agent', text: 'Rea', streaming: true },
      { id: 'm-ag2', kind: 'agent', text: 'Done.', streaming: false },
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
      composerText: {},
      drafts: {},
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the project tabs with the first session current and the meta line', () => {
    render(<ChatPane projectId={acme} />);
    const tabs = screen.getAllByRole('tab');
    // Each tab carries its ✕ marker (shown on hover / when current).
    expect(tabs.map((t) => t.textContent)).toEqual(['Claude✕', 'Codex!✕', 'Gemini✕']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('claude · fix/checkout · 14m')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message Claude…')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /^\+/ })).toBeNull();
  });

  it('the chat pane has a resize handle: ← / → step its width and persist it', () => {
    render(<ChatPane projectId={acme} />);
    const handle = screen.getByRole('separator', { name: copy.workspace.resizeChat });
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    // Default is the token width until the user moves it.
    expect(handle.getAttribute('aria-valuenow')).toBe('360');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().paneSizes['chat']).toBe(376);
    expect(commands.filter((c) => c.name === 'ui.persist')).toHaveLength(1);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().paneSizes['chat']).toBe(360);
  });

  it('the resize handle stops at the floor, so the editor cannot be squeezed out', () => {
    useUiStore.setState({ paneSizes: { chat: 285 } });
    render(<ChatPane projectId={acme} />);
    const handle = screen.getByRole('separator', { name: copy.workspace.resizeChat });
    fireEvent.keyDown(handle, { key: 'ArrowRight' }); // narrower, past the 280 floor
    expect(useUiStore.getState().paneSizes['chat']).toBe(280);
  });

  it('the resize handle stops at the ceiling', () => {
    useUiStore.setState({ paneSizes: { chat: 715 } });
    render(<ChatPane projectId={acme} />);
    const handle = screen.getByRole('separator', { name: copy.workspace.resizeChat });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // wider, past the 720 ceiling
    expect(useUiStore.getState().paneSizes['chat']).toBe(720);
  });

  it('attach: the composer offers a picker that feeds the same path as paste and drop', () => {
    render(<ChatPane projectId={acme} />);
    const attach = screen.getByRole('button', { name: copy.chat.composer.attach });
    const input = document.querySelector('[data-chat-image-input]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.accept).toContain('image/png');
    expect(input.multiple).toBe(true);
    const clicked = vi.spyOn(input, 'click');
    fireEvent.click(attach);
    expect(clicked).toHaveBeenCalled();
  });

  it('✕ on a session tab closes that chat', () => {
    render(<ChatPane projectId={acme} />);
    const tab = document.querySelector(`[data-session-tab="${fixtures.ids.session.claude}"]`) as HTMLElement;
    fireEvent.click(tab.querySelector('[data-tab-close]') as HTMLElement);
    expect(commands.filter((c) => c.name === 'session.close')).toEqual([
      { name: 'session.close', input: { sessionId: fixtures.ids.session.claude } },
    ]);
    // Delete on the focused tab closes it too (the ✕ is not focusable: a tablist owns only tabs).
    commands.length = 0;
    fireEvent.keyDown(tab, { key: 'Delete' });
    expect(commands.filter((c) => c.name === 'session.close')).toHaveLength(1);
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
      'Claude✕',
      'Codex!✕',
      'Gemini✕',
      '+2',
    ]);
    fireEvent.click(screen.getByRole('tab', { name: '+2' }));
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    fireEvent.click(items[1] as HTMLElement);
    expect(useUiStore.getState().projectSession[acme]).toBe('extra-2');
    // The picked overflow session takes slot 3.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Claude✕',
      'Codex!✕',
      'Gemini✕',
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
      { name: 'session.sendMessage', input: { sessionId: claude, body: 'ship it', attachments: [] } },
    ]);
  });

  it('Claude session: permission / model selects and Stop replace the hints (effort lives in spawn/Settings; discrepancy #54)', async () => {
    render(<ChatPane projectId={acme} />);
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull();
    const mode = screen.getByRole('combobox', { name: 'Permissions' }) as HTMLSelectElement;
    expect(mode.value).toBe('default');
    expect(mode.title).toBe(copy.session.permissionModeHints.default);
    expect([...mode.options].map((o) => o.textContent)).toEqual([
      'Ask',
      'Accept edits',
      'Plan',
      'Bypass',
      "Don't ask",
      'Auto',
    ]);
    fireEvent.change(mode, { target: { value: 'plan' } });
    const model = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(model.value).toBe('default');
    fireEvent.change(model, { target: { value: 'opus' } });
    expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
    expect(screen.queryByText(copy.chat.composer.file)).toBeNull();
    fireEvent.change(model, { target: { value: 'default' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop · esc' }));
    await flush();
    expect(commands).toEqual([
      { name: 'session.configure', input: { sessionId: claude, permissionMode: 'plan' } },
      { name: 'session.configure', input: { sessionId: claude, model: 'opus' } },
      { name: 'session.configure', input: { sessionId: claude, model: null } },
      { name: 'session.interrupt', input: { sessionId: claude } },
    ]);
  });

  it('under the e2e/visual harness (env.e2e) the static Model ▾ hint stays so the baked baseline holds', () => {
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW, e2e: true },
        command: vi.fn(async () => ({ ok: true, value: {} })),
      },
    });
    render(<ChatPane projectId={acme} />);
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Permissions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop · esc' })).toBeNull();
  });

  it('other agents keep the static Model ▾ hint; a done Claude session shows no controls', () => {
    useUiStore.getState().setSession(acme, codex);
    const { unmount } = render(<ChatPane projectId={acme} />);
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Permissions' })).toBeNull();
    unmount();
    const model = fixtures.demoReadModel();
    const s = model.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    useReadModel.getState().replaceModel(
      {
        ...model,
        sessions: upsertRows(model.sessions, [
          { ...s, state: 'done', pid: null, exitCode: 0, endedAt: fixtures.DEMO_NOW },
        ]),
      },
      'connected',
    );
    useUiStore.getState().setSession(acme, claude);
    render(<ChatPane projectId={acme} />);
    expect(screen.queryByRole('combobox', { name: 'Permissions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop · esc' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy();
  });

  it('renders a full model name on the session as an extra option; Stop hides once the turn ends', () => {
    const model = fixtures.demoReadModel();
    const s = model.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    useReadModel.getState().replaceModel(
      {
        ...model,
        sessions: upsertRows(model.sessions, [{ ...s, state: 'idle', model: 'claude-opus-4-1' }]),
      },
      'connected',
    );
    render(<ChatPane projectId={acme} />);
    const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(select.value).toBe('claude-opus-4-1');
    expect([...select.options].map((o) => o.value)).toEqual([
      'default',
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'claude-opus-4-1',
    ]);
    expect(screen.queryByRole('button', { name: 'Stop · esc' })).toBeNull();
  });

  it('Codex over its app-server: Codex mode hints, the catalogue as the model list, a live Effort that follows the model, tokens in the meta (discrepancy #83)', async () => {
    useReadModel.getState().replaceModel(codexLive(), 'connected');
    useUiStore.getState().setSession(acme, codex);
    render(<ChatPane projectId={acme} />);
    expect(screen.getByText('codex · test/flaky · 3m · 14.6k tokens · 1 turn')).toBeTruthy();
    const mode = screen.getByRole('combobox', { name: 'Permissions' }) as HTMLSelectElement;
    expect(mode.title).toBe(copy.session.permissionModeHintsByAgent.codex.default);
    const modelSel = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(modelSel.value).toBe('gpt-6-astra');
    expect([...modelSel.options].map((o) => o.textContent)).toEqual(['Default', 'GPT-6 Astra', 'GPT-5.5']);
    const effort = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement;
    expect(effort.value).toBe('ultra');
    expect([...effort.options].map((o) => o.value)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    fireEvent.change(effort, { target: { value: 'high' } });
    fireEvent.change(modelSel, { target: { value: 'gpt-5.5' } });
    fireEvent.change(mode, { target: { value: 'auto' } });
    await flush();
    expect(commands).toEqual([
      { name: 'session.configure', input: { sessionId: codex, effort: 'high' } },
      { name: 'session.configure', input: { sessionId: codex, model: 'gpt-5.5' } },
      { name: 'session.configure', input: { sessionId: codex, permissionMode: 'auto' } },
    ]);
    // Once main applies the model, the effort list follows it (gpt-5.5 has no ultra); the effort still on the
    // session stays visible rather than the select lying about it.
    act(() => {
      useReadModel
        .getState()
        .replaceModel(codexLive({ model: 'gpt-5.5', permissionMode: 'auto' }), 'connected');
    });
    const after = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement;
    expect([...after.options].map((o) => o.value)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra',
    ]);
    expect((screen.getByRole('combobox', { name: 'Permissions' }) as HTMLSelectElement).title).toBe(
      copy.session.permissionModeHintsByAgent.codex.auto,
    );
  });

  it('a Codex session still on the pty keeps the static Model ▾ hint', () => {
    useReadModel.getState().replaceModel(codexLive({ runner: 'pty' }), 'connected');
    useUiStore.getState().setSession(acme, codex);
    render(<ChatPane projectId={acme} />);
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
  });

  const secretQuestion: AskQuestion = {
    key: 'token',
    header: 'Deploy',
    prompt: 'Paste the deploy token.',
    multiSelect: false,
    options: [],
    secret: true,
  };

  /** A question-set ask on the Claude session holding one secret question, open or resolved with the stored mask. */
  const withSecretAsk = (resolved: boolean): ReadModel => {
    const model = fixtures.demoReadModel();
    const base = model.transcripts[claude]?.[0];
    const ask = model.pendingAsks.byId[fixtures.ids.ask.codexGrant];
    if (base === undefined || ask === undefined) throw new Error('fixture');
    const secretAsk = {
      ...ask,
      id: 'ask-secret' as typeof ask.id,
      sessionId: claude,
      kind: 'questions' as const,
      grantId: null,
      payload: { kind: 'questions' as const, questions: [secretQuestion] },
      state: resolved ? ('resolved' as const) : ('open' as const),
      resolution: resolved
        ? { kind: 'questions' as const, answers: [{ key: 'token', chosen: [], freeText: '••••••' }] }
        : null,
    };
    return {
      ...model,
      pendingAsks: upsertRows(model.pendingAsks, [secretAsk]),
      transcripts: {
        ...model.transcripts,
        [claude]: [
          {
            ...base,
            id: 'm-secret' as typeof base.id,
            seq: 100,
            body: '',
            askId: secretAsk.id,
            payload: { kind: 'questions', questions: [secretQuestion], answers: null },
          },
        ],
      },
    };
  };

  it('a secret question (Codex isSecret) renders as a masked input and answers through ask.respond (discrepancy #83)', async () => {
    useReadModel.getState().replaceModel(withSecretAsk(false), 'connected');
    render(<ChatPane projectId={acme} />);
    const input = screen.getByPlaceholderText(copy.session.questions.secret) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.change(input, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.session.questions.submit }));
    await flush();
    expect(commands).toEqual([
      {
        name: 'ask.respond',
        input: {
          askId: 'ask-secret',
          resolution: { kind: 'questions', answers: [{ key: 'token', chosen: [], freeText: 'hunter2' }] },
        },
      },
    ]);
    expect(screen.queryByText('hunter2')).toBeNull();
  });

  it('a resolved secret question shows the mask main stored, never the value', () => {
    useReadModel.getState().replaceModel(withSecretAsk(true), 'connected');
    render(<ChatPane projectId={acme} />);
    expect(screen.queryByPlaceholderText(copy.session.questions.secret)).toBeNull();
    expect(screen.getByText('••••••')).toBeTruthy();
    expect(document.querySelector('[data-kind="questions"][data-settled="true"]')).not.toBeNull();
  });

  it('answered decision rows are settled: options disabled and the choice inverted', () => {
    const model = fixtures.demoReadModel();
    const rows = model.transcripts[claude] ?? [];
    const decision = rows.find((m) => m.payload.kind === 'decision');
    if (decision === undefined) throw new Error('fixture');
    useReadModel.getState().replaceModel(
      {
        ...model,
        transcripts: {
          ...model.transcripts,
          [claude]: rows.map((m) =>
            m.id === decision.id
              ? { ...m, payload: { kind: 'decision', options: ['Yes', 'No', 'Edit plan'], chosen: 'No' } }
              : m,
          ),
        },
      },
      'connected',
    );
    render(<ChatPane projectId={acme} />);
    const no = screen.getByRole('button', { name: 'No' });
    expect(no.hasAttribute('disabled')).toBe(true);
    expect(no.getAttribute('data-inv')).toBe('true');
    expect(screen.getByRole('button', { name: 'Yes' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders tool rows from the stream with the status glyph', () => {
    const model = fixtures.demoReadModel();
    const base = model.transcripts[claude]?.[0];
    if (base === undefined) throw new Error('fixture');
    useReadModel.getState().replaceModel(
      {
        ...model,
        transcripts: {
          ...model.transcripts,
          [claude]: [
            ...(model.transcripts[claude] ?? []),
            {
              ...base,
              id: 'm-tool' as typeof base.id,
              seq: 100,
              body: '',
              askId: null,
              payload: {
                kind: 'tool',
                tool: 'Bash',
                hint: 'pnpm test',
                toolUseId: 't1',
                status: 'ok',
                detail: null,
              },
            },
          ],
        },
      },
      'connected',
    );
    const { container } = render(<ChatPane projectId={acme} />);
    const row = container.querySelector('[data-kind="tool"]');
    expect(row?.getAttribute('data-status')).toBe('ok');
    expect(row?.textContent).toBe('✓Bashpnpm test');
  });

  const claudeRows = (
    rows: Array<{ id: string; body: string; payload: ReadModel['transcripts'][string][number]['payload'] }>,
  ) => {
    const model = fixtures.demoReadModel();
    const base = model.transcripts[claude]?.[0];
    if (base === undefined) throw new Error('fixture');
    useReadModel.getState().replaceModel(
      {
        ...model,
        transcripts: {
          ...model.transcripts,
          [claude]: [
            ...(model.transcripts[claude] ?? []),
            ...rows.map((r, i) => ({ ...base, ...r, id: r.id as typeof base.id, seq: 100 + i, askId: null })),
          ],
        },
      },
      'connected',
    );
    return model;
  };

  it('working line: the demo Claude session is working and its last row is a decision → "Working…" + seconds since the user message (discrepancy #55)', () => {
    const model = fixtures.demoReadModel();
    const userRow = (model.transcripts[claude] ?? []).find((m) => m.payload.kind === 'user');
    if (userRow === undefined) throw new Error('fixture');
    const { container } = render(<ChatPane projectId={acme} />);
    const line = screen.getByRole('status');
    expect(line.getAttribute('aria-live')).toBe('off');
    expect(line.textContent).toBe(`Working…${Math.round((fixtures.DEMO_NOW - userRow.createdAt) / 1000)}s`);
    // Last child of the transcript log.
    expect(container.querySelector('[role="log"]')?.lastElementChild).toBe(line);
  });

  it('working line is hidden under the e2e/visual harness so the baked workspace baseline holds', () => {
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW, e2e: true },
        command: vi.fn(async () => ({ ok: true, value: {} })),
      },
    });
    render(<ChatPane projectId={acme} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('working line names the running tool, and disappears for a non-working session', () => {
    claudeRows([
      {
        id: 'm-tool',
        body: '',
        payload: {
          kind: 'tool',
          tool: 'Bash',
          hint: 'pnpm test',
          toolUseId: 't1',
          status: 'running',
          detail: null,
        },
      },
    ]);
    const { unmount } = render(<ChatPane projectId={acme} />);
    expect(screen.getByRole('status').textContent).toMatch(/^Running Bash…\d+s$/);
    unmount();
    useUiStore.getState().setSession(acme, codex);
    render(<ChatPane projectId={acme} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('streaming agent reply: cursor in the bubble, no working line', () => {
    claudeRows([
      { id: 'm-ag', body: 'Reading checkout.ts and', payload: { kind: 'agent', streaming: true } },
    ]);
    const { container } = render(<ChatPane projectId={acme} />);
    const bubble = container.querySelector('[data-kind="agent"][data-streaming="true"]');
    expect(bubble?.textContent).toBe('Reading checkout.ts and▌');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('thinking rows: streaming shows "Thinking…" with the open body and cursor; done collapses to "Thought for 4s" with Show', () => {
    claudeRows([
      {
        id: 'm-th1',
        body: 'Check pay.ts first',
        payload: { kind: 'thinking', status: 'done', durationMs: 4200 },
      },
      {
        id: 'm-th2',
        body: 'Then the total',
        payload: { kind: 'thinking', status: 'streaming', durationMs: null },
      },
    ]);
    const { container } = render(<ChatPane projectId={acme} />);
    expect(screen.getByText('Thought for 4s')).toBeTruthy();
    expect(screen.queryByText('Check pay.ts first')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('Check pay.ts first')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy();
    expect(screen.getByText('Thinking…')).toBeTruthy();
    const streaming = container.querySelector('[data-kind="thinking"][data-status="streaming"]');
    expect(streaming?.textContent).toBe('Thinking…Then the total▌');
    // The streaming block is the last row: no working line.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('after a finished thinking block the working line reads "Thinking…"; a done block without a duration reads "Thinking"', () => {
    claudeRows([
      { id: 'm-th', body: 'hmm', payload: { kind: 'thinking', status: 'done', durationMs: null } },
    ]);
    render(<ChatPane projectId={acme} />);
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^Thinking…\d+s$/);
  });

  it('compact (pop-out) pane shows the working line too', () => {
    const { container } = render(<ChatPane projectId={acme} sessionId={claude} compact />);
    expect(container.querySelector('[data-chat-compact="true"] [data-working-line]')).not.toBeNull();
    expect(screen.getByRole('status').className).toMatch(/compact/);
  });

  it('+ opens the spawn modal and ⤢ pops the chat out', async () => {
    render(<ChatPane projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: 'Spawn agent' }));
    expect(useUiStore.getState().overlays.some((o) => o.kind === 'modal')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pop out chat' }));
    await flush();
    expect(commands).toEqual([{ name: 'window.popout', input: { sessionId: claude } }]);
  });

  it('shows the "Popped out" state with a Dock button while the session is in a pop-out window', async () => {
    const model = fixtures.demoReadModel();
    useReadModel.getState().replaceModel({ ...model, popouts: [claude] }, 'connected');
    render(<ChatPane projectId={acme} />);
    expect(screen.getByText('Popped out')).toBeTruthy();
    expect((screen.getByPlaceholderText('Message Claude…') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Dock' }));
    await flush();
    expect(commands).toEqual([{ name: 'window.dock', input: { sessionId: claude } }]);
  });

  it('compact (pop-out window) pins to the given session: no tabs, no meta line, live composer', async () => {
    const model = fixtures.demoReadModel();
    useReadModel.getState().replaceModel({ ...model, popouts: [codex] }, 'connected');
    // The ui store's active session is Claude; the pop-out shows Codex regardless.
    useUiStore.getState().setSession(acme, claude);
    const { container } = render(<ChatPane projectId={acme} sessionId={codex} compact />);
    expect(container.querySelector('[data-chat-compact="true"]')).not.toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(container.querySelector('[data-chat-meta]')).toBeNull();
    expect(screen.queryByText('Popped out')).toBeNull();
    expect(screen.getByRole('button', { name: 'Review request' })).toBeTruthy();
    const box = screen.getByPlaceholderText('Message Codex…') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'go' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(commands).toEqual([
      { name: 'session.sendMessage', input: { sessionId: codex, body: 'go', attachments: [] } },
    ]);
  });
});

describe('ChatPane queue (messages sent mid-turn)', () => {
  const commands: { name: string; input: unknown }[] = [];
  const queuedModel = (bodies: string[], sessionId: SessionId = claude, base = fixtures.demoReadModel()) => ({
    ...base,
    queues: {
      ...base.queues,
      [sessionId]: bodies.map((body, i) => ({
        id: `q-${i + 1}`,
        sessionId,
        body,
        files: [],
        createdAt: fixtures.DEMO_NOW + i,
      })),
    },
  });

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
      drafts: {},
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('held messages render as dashed bubbles under the transcript, oldest first, each with Send now / Take back', () => {
    useReadModel.getState().replaceModel(queuedModel(['first', 'second']), 'connected');
    const { container } = render(<ChatPane projectId={acme} />);
    const bubbles = container.querySelectorAll('[data-queued]');
    expect(Array.from(bubbles).map((b) => b.getAttribute('data-queued'))).toEqual(['q-1', 'q-2']);
    expect(bubbles[0]?.textContent).toContain('first');
    expect(bubbles[0]?.textContent).toContain(`${copy.queue.queued} · ${copy.queue.hint}`);
    expect(screen.getAllByRole('button', { name: copy.queue.sendNow })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: copy.queue.takeBack })).toHaveLength(2);
    // They sit after the transcript rows and are not user bubbles.
    const lastUser = container.querySelectorAll('[data-kind="user"]');
    const last = lastUser[lastUser.length - 1] as Element;
    expect(
      last.compareDocumentPosition(bubbles[0] as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(bubbles[0]?.getAttribute('data-kind')).toBeNull();
  });

  it("another session's queue does not show here", () => {
    useReadModel.getState().replaceModel(queuedModel(['for codex'], codex), 'connected');
    const { container } = render(<ChatPane projectId={acme} />);
    expect(container.querySelector('[data-queued]')).toBeNull();
  });

  it('Send now sends that message through session.sendQueued', () => {
    useReadModel.getState().replaceModel(queuedModel(['first', 'second']), 'connected');
    render(<ChatPane projectId={acme} />);
    fireEvent.click(screen.getAllByRole('button', { name: copy.queue.sendNow })[1] as HTMLElement);
    expect(commands).toEqual([
      { name: 'session.sendQueued', input: { sessionId: claude, messageId: 'q-2' } },
    ]);
  });

  it('Take back unqueues the message and puts its text into the composer draft', async () => {
    useReadModel.getState().replaceModel(queuedModel(['bring me back']), 'connected');
    render(<ChatPane projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: copy.queue.takeBack }));
    expect(commands).toEqual([{ name: 'session.unqueue', input: { sessionId: claude, messageId: 'q-1' } }]);
    await flush();
    const box = screen.getByPlaceholderText('Message Claude…') as HTMLTextAreaElement;
    expect(box.value).toBe('bring me back');
    expect(document.activeElement).toBe(box);
    // Applied once: the store entry is consumed so a remount does not paste it again.
    expect(useUiStore.getState().drafts[claude]).toBeUndefined();
  });

  it('a Stop that returned the queue (drafts in the store) lands in the composer, after what was typed', async () => {
    render(<ChatPane projectId={acme} />);
    const box = screen.getByPlaceholderText('Message Claude…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'typed' } });
    act(() => useUiStore.getState().prefillDraft(claude, 'alpha\n\nbeta'));
    await flush();
    expect(box.value).toBe('typed\n\nalpha\n\nbeta');
    expect(useUiStore.getState().drafts[claude]).toBeUndefined();
  });

  it('the composer draft belongs to its session: switching tabs shows each tab its own text, and a remount (another screen) brings it back', () => {
    const { unmount } = render(<ChatPane projectId={acme} />);
    const box = () => screen.getByRole('textbox', { name: /^Message/ }) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: 'for claude' } });
    expect(useUiStore.getState().composerText[claude]).toBe('for claude');
    // Codex's tab: an empty composer, its own text.
    fireEvent.click(screen.getByRole('tab', { name: /Codex/ }));
    expect(box().value).toBe('');
    fireEvent.change(box(), { target: { value: 'for codex' } });
    // Back to Claude: the first draft is still there, untouched.
    fireEvent.click(screen.getByRole('tab', { name: /Claude/ }));
    expect(box().value).toBe('for claude');
    // Leaving the workspace (Settings, say) unmounts the pane; coming back restores the draft from the store.
    unmount();
    render(<ChatPane projectId={acme} />);
    expect(box().value).toBe('for claude');
    // Sending clears the store entry for that session only.
    fireEvent.click(document.querySelector('[data-composer-send]') as HTMLButtonElement);
    expect(useUiStore.getState().composerText[claude]).toBeUndefined();
    expect(useUiStore.getState().composerText[codex]).toBe('for codex');
  });

  it("send hint: Queue with Claude's hint while working or blocked on an ask; ⏎ send once idle", () => {
    render(<ChatPane projectId={acme} />); // the demo Claude session is working
    const send = document.querySelector('[data-composer-send]') as HTMLButtonElement;
    expect(send.textContent).toBe(copy.queue.send.queue);
    expect(send.title).toBe(fill(copy.queue.queueHint, { agent: 'Claude Code' }));

    const model = fixtures.demoReadModel();
    const s = model.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    act(() =>
      useReadModel
        .getState()
        .replaceModel(
          { ...model, sessions: upsertRows(model.sessions, [{ ...s, state: 'needs-you' }]) },
          'connected',
        ),
    );
    expect((document.querySelector('[data-composer-send]') as HTMLButtonElement).textContent).toBe('Queue');
    act(() =>
      useReadModel
        .getState()
        .replaceModel(
          { ...model, sessions: upsertRows(model.sessions, [{ ...s, state: 'idle' }]) },
          'connected',
        ),
    );
    const idle = document.querySelector('[data-composer-send]') as HTMLButtonElement;
    expect(idle.textContent).toBe(copy.chat.composer.send);
    expect(idle.title).toBe('');
  });

  it("send hint: Steer with Codex's hint for a working Codex session on the app-server; Queue on the pty", () => {
    useReadModel.getState().replaceModel(codexLive({ state: 'working' }), 'connected');
    useUiStore.getState().setSession(acme, codex);
    render(<ChatPane projectId={acme} />);
    const send = document.querySelector('[data-composer-send]') as HTMLButtonElement;
    expect(send.textContent).toBe(copy.queue.send.steer);
    expect(send.title).toBe(fill(copy.queue.steerHint, { agent: 'Codex' }));
    act(() =>
      useReadModel.getState().replaceModel(codexLive({ state: 'working', runner: 'pty' }), 'connected'),
    );
    expect((document.querySelector('[data-composer-send]') as HTMLButtonElement).textContent).toBe('Queue');
  });

  it('under the e2e/visual harness the send hint stays ⏎ send (the baked workspace baseline shows a working session)', () => {
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW, e2e: true },
        command: vi.fn(async () => ({ ok: true, value: {} })),
      },
    });
    useReadModel.getState().replaceModel(queuedModel(['still shown']), 'connected');
    const { container } = render(<ChatPane projectId={acme} />);
    expect((document.querySelector('[data-composer-send]') as HTMLButtonElement).textContent).toBe('⏎ send');
    // The bubbles are not gated: nothing is queued in the fixture, so the baseline never sees one.
    expect(container.querySelector('[data-queued]')).not.toBeNull();
  });
});
