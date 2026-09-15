// @vitest-environment jsdom
import { fixtures, type ReadModel, type SkillSummary } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shellBindings } from '../../keys/bindings';
import { KeyRegistry } from '../../keys/registry';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { SkillDrawer } from './SkillDrawer';
import { useSkillsStore } from './skills-store';

const acme = fixtures.ids.project.acmeShop;

const MD = [
  '---',
  'name: pdf',
  'description: Read, fill and merge PDF files with the pdf toolkit.',
  '---',
  '',
  '# pdf',
  '',
  'Use this skill when asked to read, fill or merge PDF files.',
  '',
  '## Workflow',
  '',
  '1. Inspect the file with `pdfinfo` before changing it.',
  '2. Merge with page ranges, not whole files.',
  '',
].join('\n');

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
let installed: SkillSummary[] = [];
let installResult: Result = { ok: true, value: { skills: [] } };
const commandMock = vi.fn(async (name: string, _input?: unknown): Promise<Result> => {
  switch (name) {
    case 'skills.preview':
      return { ok: true, value: { text: MD } };
    case 'skills.list':
      return { ok: true, value: { skills: installed } };
    case 'skills.install':
      return installResult;
    default:
      return { ok: true, value: {} };
  }
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

/** Renders whatever skill drawer the overlay stack holds, the way OverlayHost does, so popping it unmounts it. */
function Host() {
  const overlays = useUiStore((st) => st.overlays);
  return (
    <>
      {overlays.map((o) =>
        o.kind === 'drawer' && o.drawer === 'skill' ? (
          <SkillDrawer key={o.id} id={o.id} directory={o.directory} />
        ) : null,
      )}
    </>
  );
}

const open = async (directory = 'pdf') => {
  render(<Host />);
  act(() => {
    useUiStore.getState().pushOverlay({ kind: 'drawer', drawer: 'skill', directory });
  });
  const dialog = await screen.findByRole('dialog', { name: 'Skill' });
  await waitFor(() => expect(within(dialog).queryByText('Loading skill…')).toBeNull());
  return dialog;
};

const hostBox = (host: string) => document.querySelector<HTMLInputElement>(`[data-skill-host="${host}"]`)!;
const installButton = () => screen.getByRole('button', { name: /^Install/ }) as HTMLButtonElement;

const withClis = (found: Record<string, boolean>): ReadModel => {
  const m = fixtures.demoReadModel();
  return {
    ...m,
    discovery: {
      ...m.discovery,
      clis: m.discovery.clis.map((c) => ({ ...c, found: found[c.agent] ?? c.found })),
    },
  };
};

describe('SkillDrawer', () => {
  beforeEach(() => {
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'settings', platform: 'darwin', projectId: acme });
    useSkillsStore.setState({ version: 0 });
    installed = [];
    installResult = { ok: true, value: { skills: [] } };
    commandMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the SKILL.md as markdown under the security line, with the frontmatter lifted into title and description', async () => {
    const dialog = await open();
    // Title (the frontmatter name) and meta (the directory) both read "pdf" here; the markdown h1 is a third.
    expect(within(dialog).getAllByText('pdf', { selector: 'span' })).toHaveLength(2);
    expect(within(dialog).getByRole('heading', { level: 1, name: 'pdf' })).toBeTruthy();
    expect(within(dialog).getByText('Read, fill and merge PDF files with the pdf toolkit.')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Workflow' })).toBeTruthy();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    expect(within(dialog).getByText(/Read it before installing/)).toBeTruthy();
    expect(dialog.textContent).not.toContain('---');
    expect(dialog.textContent).not.toContain('description:');
    expect(calls('skills.preview')[0]?.[1]).toEqual({ directory: 'pdf' });
  });

  it('pre-checks the agents whose CLI was found', async () => {
    useReadModel.getState().replaceModel(withClis({ codex: false, cursor: false }), 'connected');
    await open();
    expect(hostBox('claude').checked).toBe(true);
    expect(hostBox('codex').checked).toBe(false);
    expect(hostBox('gemini').checked).toBe(true);
    expect(hostBox('cursor').checked).toBe(false);
  });

  it('Install is disabled until at least one agent is picked', async () => {
    await open();
    expect(installButton().disabled).toBe(false);
    for (const host of ['claude', 'codex', 'gemini', 'cursor']) fireEvent.click(hostBox(host));
    expect(installButton().disabled).toBe(true);
    fireEvent.click(hostBox('codex'));
    expect(installButton().disabled).toBe(false);
  });

  it('agents that already have the skill for the chosen scope are locked with an Installed tag and do not count', async () => {
    installed = [{ name: 'pdf', directory: 'pdf', description: '', scope: 'global', host: 'claude' }];
    const dialog = await open();
    await waitFor(() => expect(hostBox('claude').disabled).toBe(true));
    expect(hostBox('claude').checked).toBe(true);
    expect(within(dialog).getByText('Installed')).toBeTruthy();
    for (const host of ['codex', 'gemini', 'cursor']) fireEvent.click(hostBox(host));
    expect(installButton().disabled).toBe(true);
    // A project install is a different place: Claude is free again there.
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Project' }));
    expect(hostBox('claude').disabled).toBe(false);
  });

  it('installs for the picked agents and scope, then closes, refreshes the pane and confirms with a toast', async () => {
    const dialog = await open();
    fireEvent.click(hostBox('gemini'));
    fireEvent.click(hostBox('cursor'));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Project' }));
    fireEvent.click(installButton());
    await waitFor(() => expect(calls('skills.install')).toHaveLength(1));
    expect(calls('skills.install')[0]?.[1]).toEqual({
      directory: 'pdf',
      scope: 'project',
      hosts: ['claude', 'codex'],
      projectId: acme,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const toast = useUiStore.getState().overlays.find((o) => o.kind === 'toast');
    expect(toast?.kind === 'toast' && toast.toast).toEqual({
      kind: 'info',
      heading: 'Skills',
      title: 'Installed pdf for Claude, Codex',
    });
    expect(useSkillsStore.getState().version).toBe(1);
  });

  it('a failed install stays open and shows the error', async () => {
    installResult = {
      ok: false,
      error: { code: 'provider-error', message: 'Could not reach the skill catalogue: HTTP 503' },
    };
    const dialog = await open();
    fireEvent.click(installButton());
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('HTTP 503'));
    expect(screen.getByRole('dialog', { name: 'Skill' })).toBeTruthy();
    expect(useSkillsStore.getState().version).toBe(0);
  });

  it('without a project the Project chip is disabled and says why', async () => {
    useUiStore.setState({ projectId: null });
    const dialog = await open();
    const project = within(dialog).getByRole('radio', { name: 'Project' }) as HTMLButtonElement;
    expect(project.disabled).toBe(true);
    expect(within(dialog).getByText('Open a project to install it there.')).toBeTruthy();
  });

  it('Esc (the shell binding) and Close both pop the drawer', async () => {
    const reg = new KeyRegistry({
      platform: () => 'darwin',
      overlayOpen: () => useUiStore.getState().overlays.length > 0,
    });
    reg.registerAll(shellBindings());
    const off = reg.install(window);
    try {
      await open();
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(useUiStore.getState().overlays).toHaveLength(0);
      // The Host is still mounted: push again rather than rendering a second one.
      act(() => {
        useUiStore.getState().pushOverlay({ kind: 'drawer', drawer: 'skill', directory: 'pdf' });
      });
      const dialog = await screen.findByRole('dialog', { name: 'Skill' });
      // Two buttons read "Close": the header ✕ (aria-label) and the footer button; the footer one is last.
      const closeButtons = within(dialog).getAllByRole('button', { name: 'Close' });
      expect(closeButtons).toHaveLength(2);
      fireEvent.click(closeButtons[closeButtons.length - 1]!);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    } finally {
      off();
    }
  });
});
