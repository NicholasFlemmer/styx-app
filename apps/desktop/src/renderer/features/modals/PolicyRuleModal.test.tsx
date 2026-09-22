// @vitest-environment jsdom
import { copy, fixtures, type PolicyId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { draftRuleText, PolicyRuleModal } from './PolicyRuleModal';

const commandMock = vi.fn(async () => ({ ok: true as const, value: { policyId: 'p-new' } }));
const calls = (name: string) =>
  commandMock.mock.calls.filter((c) => (c as unknown[])[0] === name).map((c) => (c as unknown[])[1]);

describe('PolicyRuleModal (+ Rule)', () => {
  beforeEach(() => {
    commandMock.mockReset();
    commandMock.mockImplementation(async () => ({ ok: true as const, value: { policyId: 'p-new' } }));
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'policy-rule' }],
      platform: 'darwin',
      projectId: fixtures.ids.project.acmeShop,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('drafts the rule text from the choices and saves an auto-approve rule through policy.upsert', async () => {
    render(<PolicyRuleModal id="modal-1" />);
    const text = screen.getByLabelText(copy.policies.editor.text) as HTMLInputElement;
    expect(text.value).toBe('Auto-approve read schema on any target for 1h');
    fireEvent.click(screen.getByRole('checkbox', { name: copy.providers.vercel }));
    fireEvent.click(screen.getByRole('checkbox', { name: copy.policies.editor.envNames.preview }));
    fireEvent.click(screen.getByRole('checkbox', { name: copy.grantSheet.scopes.deploy }));
    fireEvent.click(screen.getByRole('radio', { name: 'always' }));
    expect(text.value).toBe('Auto-approve read schema + deploy on Vercel (Preview) for always');
    fireEvent.click(screen.getByRole('button', { name: copy.policies.editor.save }));
    await waitFor(() => expect(calls('policy.upsert')).toHaveLength(1));
    expect(calls('policy.upsert')[0]).toEqual({
      policyId: null,
      rule: {
        kind: 'auto-approve',
        match: { provider: ['vercel'], env: ['preview'] },
        scopes: ['read', 'deploy'],
        duration: 'always',
      },
      ruleText: 'Auto-approve read schema + deploy on Vercel (Preview) for always',
      enabled: true,
    });
    await waitFor(() => expect(useUiStore.getState().overlays).toEqual([]));
  });

  it('an ask rule carries requireMfa; no scope disables the save; the person can override the text', () => {
    render(<PolicyRuleModal id="modal-1" />);
    fireEvent.click(screen.getByRole('radio', { name: copy.policies.editor.kinds.ask }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Require / }));
    const text = screen.getByLabelText(copy.policies.editor.text) as HTMLInputElement;
    expect(text.value).toBe('Ask, require Touch ID for read schema on any target');
    fireEvent.click(screen.getByRole('checkbox', { name: copy.grantSheet.scopes.read }));
    expect(screen.getByRole('button', { name: copy.policies.editor.save })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: copy.grantSheet.scopes.write }));
    fireEvent.change(text, { target: { value: 'Prod writes always ask' } });
    fireEvent.click(screen.getByRole('button', { name: copy.policies.editor.save }));
    expect(calls('policy.upsert')[0]).toMatchObject({
      rule: { kind: 'ask', match: {}, scopes: ['write'], requireMfa: true },
      ruleText: 'Prod writes always ask',
    });
  });

  it('editing an existing custom rule starts from its choices and text and upserts under its id', () => {
    const model = useReadModel.getState().model;
    const id = 'p-custom' as PolicyId;
    useReadModel.getState().replaceModel(
      {
        ...model,
        policies: {
          byId: {
            ...model.policies.byId,
            [id]: {
              id,
              ord: 4,
              rule: {
                kind: 'auto-approve',
                match: { provider: ['github'] },
                scopes: ['read'],
                duration: 'session',
              },
              ruleText: 'GitHub reads are fine',
              enabled: false,
              builtinKey: null,
              matchCountToday: 0,
              matchCountWeek: 0,
              countersResetAt: null,
              createdAt: fixtures.DEMO_NOW,
            },
          },
          ids: [...model.policies.ids, id],
        },
      },
      'connected',
    );
    render(<PolicyRuleModal id="modal-1" policyId={id} />);
    expect((screen.getByLabelText(copy.policies.editor.text) as HTMLInputElement).value).toBe(
      'GitHub reads are fine',
    );
    expect(screen.getByRole('checkbox', { name: copy.providers.github })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'session' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: copy.policies.editor.saveEdit }));
    expect(calls('policy.upsert')[0]).toMatchObject({
      policyId: id,
      ruleText: 'GitHub reads are fine',
      enabled: false,
    });
  });

  it('draftRuleText names any target and the environments', () => {
    expect(draftRuleText('ask', [], ['prod', 'staging'], ['write', 'delete'], '1h', false, 'Touch ID')).toBe(
      'Ask for write + delete / drop on any target (Prod, Staging)',
    );
  });
});
