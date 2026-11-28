// @vitest-environment jsdom
import { copy, fixtures, HUB_OFF, type HubState, type ProjectId, type SessionId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { ShareSheet, sizeLabel } from './ShareSheet';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;
const commands: { name: string; input: unknown }[] = [];
let listener: ((p: unknown) => void) | null = null;
let answer: (name: string) => { ok: boolean; value?: unknown; error?: { code: string; message: string } };
const copied: string[] = [];

const hub: HubState = {
  ...HUB_OFF,
  connection: {
    kind: 'signed-in',
    account: { id: 'u', email: 'nic@launchsite.co.za', name: 'Nic' },
    teams: [],
    spaces: [{ id: 'spc_acme', teamId: 't', name: 'Acme', role: 'owner', agentProposals: 'review' }],
    staleSince: null,
  },
  links: [{ projectId: acme, spaceId: 'spc_acme', hubProjectId: 'p' }],
};

const PICK = { id: 'pick_1', items: [{ name: 'out', files: 14, bytes: 1_258_291 }] };

describe('ShareSheet (ADR-0032 phase 2)', () => {
  beforeEach(() => {
    commands.length = 0;
    copied.length = 0;
    answer = (name) =>
      name === 'hub.pickShare'
        ? { ok: true, value: { pick: PICK } }
        : name === 'hub.share'
          ? { ok: true, value: { url: 'https://share.test/l/abc', itemId: 'itm_1' } }
          : { ok: true, value: {} };
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return answer(name);
        }),
        onEvent: (name: string, cb: (p: unknown) => void) => {
          if (name === 'hub.share.progress') listener = cb;
          return () => undefined;
        },
      },
    });
    Object.assign(navigator, { clipboard: { writeText: async (t: string) => void copied.push(t) } });
    useReadModel.getState().replaceModel({ ...fixtures.demoReadModel(), hub }, 'connected');
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('chooses a folder, shares it with anyone for 30 days, and puts the link on the clipboard', async () => {
    render(<ShareSheet id="o1" sessionId={claude} projectId={acme} />);
    expect((screen.getByRole('button', { name: copy.hub.share.go }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.share.chooseFolder }));
    });
    expect(screen.getByText('out')).toBeTruthy();
    expect(screen.getByText('14 files · 1.2 MB')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: copy.hub.share.anyone }));
    fireEvent.click(screen.getByRole('radio', { name: copy.hub.share.expiry['30d'] }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.share.go }));
    });
    expect(commands.at(-1)).toEqual({
      name: 'hub.share',
      input: { sessionId: claude, pickId: 'pick_1', access: 'anyone', expiresIn: '30d', review: true },
    });
    expect(screen.getByText(copy.hub.share.done)).toBeTruthy();
    expect(screen.getByText('https://share.test/l/abc')).toBeTruthy();
    expect(copied).toEqual(['https://share.test/l/abc']);
  });

  it('shows upload progress for its own pick only', async () => {
    let finish: (v: unknown) => void = () => undefined;
    answer = (name) =>
      name === 'hub.pickShare' ? { ok: true, value: { pick: PICK } } : { ok: true, value: {} };
    (window as unknown as { styx: { command: unknown } }).styx.command = vi.fn(async (name: string) =>
      name === 'hub.share' ? new Promise((r) => (finish = r)) : answer(name),
    );
    render(<ShareSheet id="o1" sessionId={claude} projectId={acme} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.share.chooseFiles }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.share.go }));
    });
    act(() => listener?.({ pickId: 'other', sent: 999, total: 1000 }));
    act(() => listener?.({ pickId: 'pick_1', sent: 629_146, total: 1_258_291 }));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    await act(async () => finish({ ok: true, value: { url: 'u', itemId: 'i' } }));
  });

  it('says why a share failed and lets the person try again', async () => {
    answer = (name) =>
      name === 'hub.pickShare'
        ? { ok: true, value: { pick: PICK } }
        : { ok: false, error: { code: 'provider-error', message: 'Uploading index.html failed (403).' } };
    render(<ShareSheet id="o1" sessionId={claude} projectId={acme} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.share.chooseFolder }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: copy.hub.share.go }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Uploading index.html failed (403).');
    expect((screen.getByRole('button', { name: copy.hub.share.go }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('labels sizes plainly', () => {
    expect(sizeLabel(812 * 1024)).toBe('812 KB');
    expect(sizeLabel(38 * 1024 ** 2)).toBe('38.0 MB');
    expect(sizeLabel(2 * 1024 ** 3)).toBe('2.0 GB');
  });
});
