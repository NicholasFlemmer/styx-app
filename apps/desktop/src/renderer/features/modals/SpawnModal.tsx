import {
  copy,
  fill,
  platformCopy,
  projectNameOf,
  projectSettingsOfOrDefault,
  type Agent,
  type ProjectId,
  type ReadModel,
} from '@styx/core';
import { Button, Checkbox, Field, Input, Modal, Select, StatusDot, Textarea } from '@styx/ui';
import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useCopyPlatform, useModel, useUi } from '../../state/hooks';
import {
  SPAWN_AGENTS,
  autoBranchFor,
  cliMissing,
  cliOf,
  cliVersionLabel,
  defaultToggles,
  projectWorktrees,
  spawnPayload,
  spawnValid,
  type SpawnForm,
} from './modals';
import s from './SpawnModal.module.css';

export interface SpawnModalProps {
  id: string;
  projectId: ProjectId;
}

const selectModel = (m: ReadModel) => m;

/**
 * Spawn agent (spec §4.11, modal 600): five agent tiles, inline CLI-missing row, Worktree / Branch / First message,
 * three toggles, Cancel / `Spawn · Mod⏎`. Spawning creates the worktree, starts the CLI and opens Workspace on it.
 */
export function SpawnModal({ id, projectId }: SpawnModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const openSession = useUi((u) => u.openSession);
  const setScreen = useUi((u) => u.setScreen);
  const setOnboardingStep = useUi((u) => u.setOnboardingStep);
  /** Keyboard Mod follows the OS; the `mod` glyph in the Spawn label follows the rendered chrome (spec §7). */
  const platform = useUi((u) => u.platform);
  const copyPlatform = useCopyPlatform();
  const model = useModel(selectModel);
  const project = projectNameOf(model, projectId);
  const words = platformCopy(copyPlatform);

  const [form, setForm] = useState<SpawnForm>(() => {
    const agent = projectSettingsOfOrDefault(model, projectId).defaultAgent;
    return {
      agent,
      worktree: 'new',
      branch: autoBranchFor(model, projectId, agent),
      firstMessage: '',
      toggles: defaultToggles(model, projectId),
    };
  });
  const [branchTouched, setBranchTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const worktreeId = useId();
  const branchId = useId();
  const messageId = useId();
  const chosenTile = useRef<HTMLButtonElement>(null);

  const close = () => popOverlay(id);
  const pickAgent = (agent: Agent) =>
    setForm((f) => ({
      ...f,
      agent,
      branch: branchTouched ? f.branch : autoBranchFor(model, projectId, agent),
    }));
  const missing = cliMissing(model, form.agent);
  const valid = spawnValid(model, form) && !busy;

  const spawn = useCallback(async () => {
    if (!spawnValid(model, form) || busy) return;
    setBusy(true);
    const r = await command('session.spawn', spawnPayload(model, projectId, form));
    setBusy(false);
    if (!r.ok) return;
    close();
    openSession(projectId, r.value.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, form, busy, projectId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      void spawn();
    }
  };
  /** OS file picker → `detect.setBinary`; the `discovery.set` delta clears the missing row when the probe succeeds. */
  const locateBinary = async () => {
    const r = await command('dialog.pickFile', { title: copy.errors.locateBinary });
    if (!r.ok || r.value.path === null) return;
    await command('detect.setBinary', { agent: form.agent, path: r.value.path });
  };
  const installGuide = () => {
    close();
    setOnboardingStep(3);
    setScreen('onboarding');
  };

  const worktrees = projectWorktrees(model, projectId).filter((w) => !w.isMain);
  const agentName = copy.agentProducts[form.agent];

  return (
    <Modal
      width={600}
      title={fill(copy.spawn.title, { project })}
      onClose={close}
      escapeEnabled={false}
      initialFocus={chosenTile}
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={close}>
            {copy.spawn.cancel}
          </Button>
          <Button size="footer" variant="primary" disabled={!valid} onClick={() => void spawn()}>
            {fill(copy.spawn.spawn, { mod: words.mod })}
          </Button>
        </>
      }
    >
      <div className={s['root']} onKeyDown={onKeyDown} data-spawn-modal="true">
        <div className={s['bleed']}>
          <div className={s['tiles']} role="radiogroup" aria-label={copy.spawn.title.split(' ·')[0]}>
            {SPAWN_AGENTS.map((a) => (
              <button
                key={a}
                ref={a === form.agent ? chosenTile : undefined}
                type="button"
                role="radio"
                aria-checked={a === form.agent}
                data-inv={a === form.agent ? 'true' : undefined}
                data-agent={a}
                className={s['tile']}
                onClick={() => pickAgent(a)}
              >
                <span className={s['tileName']}>{copy.agentProducts[a]}</span>
                <span className={s['tileVer']}>{cliVersionLabel(cliOf(model, a))}</span>
              </button>
            ))}
          </div>
          {missing ? (
            <div className={s['error']} role="alert">
              <StatusDot tone="accent" />
              <span className={s['errorText']}>{fill(copy.errors.spawnCliMissing, { cli: agentName })}</span>
              <Button onClick={installGuide}>{copy.errors.cliMissing.cta}</Button>
              <Button title={copy.errors.locateBinary} onClick={() => void locateBinary()}>
                {copy.errors.locateBinary}
              </Button>
            </div>
          ) : null}
        </div>

        <div className={s['two']}>
          <Field label={copy.spawn.worktree} htmlFor={worktreeId}>
            <Select
              id={worktreeId}
              className={s['worktree'] ?? ''}
              width="100%"
              value={form.worktree}
              onChange={(e) => setForm({ ...form, worktree: e.currentTarget.value })}
              options={[
                { value: 'new', label: copy.spawn.worktreeDefault },
                ...worktrees.map((w) => ({ value: w.id, label: w.branch })),
              ]}
            />
          </Field>
          <Field label={copy.spawn.branch} htmlFor={branchId}>
            <Input
              id={branchId}
              mono
              value={
                form.worktree === 'new'
                  ? form.branch
                  : (worktrees.find((w) => w.id === form.worktree)?.branch ?? '')
              }
              disabled={form.worktree !== 'new'}
              spellCheck={false}
              onChange={(e) => {
                setBranchTouched(true);
                setForm({ ...form, branch: e.currentTarget.value });
              }}
            />
          </Field>
        </div>

        <Field label={copy.spawn.firstMessage} htmlFor={messageId}>
          <Textarea
            id={messageId}
            className={s['firstMessage']}
            minHeight={64}
            placeholder={fill(copy.spawn.firstMessagePlaceholder, { agent: agentName })}
            value={form.firstMessage}
            onChange={(e) => setForm({ ...form, firstMessage: e.currentTarget.value })}
          />
        </Field>

        <div className={s['toggles']}>
          <Checkbox
            checked={form.toggles.autoApproveEdits}
            onChange={(v) => setForm({ ...form, toggles: { ...form.toggles, autoApproveEdits: v } })}
            label={copy.spawn.toggles.autoApproveEdits}
          />
          <Checkbox
            checked={form.toggles.mayRequestTargets}
            onChange={(v) => setForm({ ...form, toggles: { ...form.toggles, mayRequestTargets: v } })}
            label={copy.spawn.toggles.mayRequestTargets}
          />
          <Checkbox
            checked={form.toggles.notifyWhenNeedsMe}
            onChange={(v) => setForm({ ...form, toggles: { ...form.toggles, notifyWhenNeedsMe: v } })}
            label={copy.spawn.toggles.notifyWhenNeedsMe}
          />
        </div>
      </div>
    </Modal>
  );
}
