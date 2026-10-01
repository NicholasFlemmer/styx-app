import {
  activeLanesLabel,
  laneLine,
  copy,
  fill,
  platformCopy,
  projectNameOf,
  type ProjectId,
} from '@styx/core';
import { Button, Checkbox, Field, Input, Modal, Select, StatusDot, Textarea } from '@styx/ui';
import { useId, useRef, type KeyboardEvent } from 'react';
import { invokerOf, rememberInvoker } from '../../overlays/stack';
import { useCopyPlatform, useUi } from '../../state/hooks';
import {
  decodeEffort,
  decodePermissionMode,
  effortOptionsFor,
  encodeNullable,
  modelOptionsFor,
  permissionModeHint,
  permissionModeOptionsFor,
} from '../chat/session-controls';
import { SPAWN_AGENTS, cliOf, cliVersionLabel } from './modals';
import { useSpawnForm } from './use-spawn-form';
import s from './SpawnModal.module.css';

export interface SpawnModalProps {
  id: string;
  projectId: ProjectId;
}

/**
 * Spawn agent (spec §4.11, modal 600): five agent tiles, inline CLI-missing row, Worktree / Branch / First message,
 * three toggles, Cancel / `Spawn · Mod⏎`. Spawning creates the worktree, starts the CLI and opens Workspace on it.
 */
export function SpawnModal({ id, projectId }: SpawnModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const openSession = useUi((u) => u.openSession);
  /** Keyboard Mod follows the OS; the `mod` glyph in the Spawn label follows the rendered chrome (spec §7). */
  const platform = useUi((u) => u.platform);
  const copyPlatform = useCopyPlatform();
  const words = platformCopy(copyPlatform);
  const {
    model,
    form,
    setForm,
    pickAgent,
    pickModel,
    setBranch,
    catalogue,
    missing,
    notConnected,
    valid,
    spawn: start,
    locateError,
    locateBinary,
    installGuide: openInstallGuide,
    worktrees,
    choices,
    lanes,
    settings,
  } = useSpawnForm(projectId);
  const project = projectNameOf(model, projectId);
  const worktreeId = useId();
  const branchId = useId();
  const messageId = useId();
  const modeId = useId();
  const modelId = useId();
  const effortId = useId();
  const chosenTile = useRef<HTMLButtonElement>(null);

  const close = () => popOverlay(id);
  const spawn = async () => {
    const sessionId = await start();
    if (sessionId === null) return;
    close();
    openSession(projectId, sessionId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      void spawn();
    }
  };
  const installGuide = () => {
    close();
    openInstallGuide();
  };
  /** Connect agent modal for this CLI; it re-opens this Spawn modal for the project when done. */
  const fixConnection = () => {
    const invoker = invokerOf(id);
    close();
    const next = pushOverlay({
      kind: 'modal',
      modal: 'connect-agent',
      agent: form.agent,
      returnTo: { modal: 'spawn', projectId },
    });
    if (invoker !== null) rememberInvoker(next, invoker);
  };
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
      <div
        className={s['root']}
        onKeyDown={onKeyDown}
        data-spawn-modal="true"
        data-plain-folder={choices.plainFolder ? 'true' : undefined}
      >
        <div className={s['bleed']}>
          <div className={s['tiles']} role="radiogroup" aria-label={copy.newTask.agent}>
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
          {lanes.length > 0 ? (
            <div className={s['lanes']} data-spawn-lanes={lanes.length}>
              <span className={s['lanesHead']}>{activeLanesLabel(lanes.length)}</span>
              {lanes.map((l) => (
                <span key={l.sessionId} className={s['lane']}>
                  {laneLine(l)}
                </span>
              ))}
            </div>
          ) : null}
          {missing || notConnected ? (
            <div className={s['error']} role="status" data-spawn-cli={missing ? 'missing' : 'not-connected'}>
              <StatusDot tone="accent" />
              <span className={s['errorText']}>
                {missing
                  ? fill(copy.errors.spawnCliMissing, { cli: agentName })
                  : fill(copy.errors.spawnNotConnected, { cli: agentName })}
              </span>
              {missing ? (
                <>
                  <Button onClick={installGuide}>{copy.errors.cliMissing.cta}</Button>
                  <Button title={copy.errors.locateBinary} onClick={() => void locateBinary()}>
                    {copy.errors.locateBinary}
                  </Button>
                </>
              ) : null}
              <Button onClick={fixConnection}>{copy.errors.fixConnection}</Button>
            </div>
          ) : null}
          {missing && locateError !== null ? (
            <div className={s['error']} role="alert" data-locate-error="true">
              <span className={s['errorText']}>{locateError}</span>
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
              options={choices.options}
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
              onChange={(e) => setBranch(e.currentTarget.value)}
            />
          </Field>
        </div>

        {(settings.mode || settings.model || settings.effort) && (
          // Session settings (owner addition, discrepancies #54 / #83): seeded from the project defaults; the
          // lists and the mode hint follow the chosen tile (Claude's aliases, Codex's catalogue, ACP's modes).
          <div className={s['three']} data-spawn-settings="true">
            {settings.mode && (
              <Field
                label={copy.chat.controls.permissions}
                htmlFor={modeId}
                hint={permissionModeHint(form.agent, form.permissionMode)}
              >
                <Select
                  id={modeId}
                  className={s['worktree'] ?? ''}
                  width="100%"
                  value={form.permissionMode}
                  onChange={(e) =>
                    setForm({ ...form, permissionMode: decodePermissionMode(e.currentTarget.value) })
                  }
                  options={permissionModeOptionsFor(form.agent).map((o) => ({
                    value: o.value,
                    label: o.label,
                  }))}
                />
              </Field>
            )}
            {settings.model && (
              <Field label={copy.chat.controls.model} htmlFor={modelId}>
                <Select
                  id={modelId}
                  className={s['worktree'] ?? ''}
                  width="100%"
                  value={encodeNullable(form.model)}
                  onChange={(e) => pickModel(e.currentTarget.value)}
                  options={modelOptionsFor(form.agent, form.model, catalogue)}
                />
              </Field>
            )}
            {settings.effort && (
              <Field label={copy.chat.controls.effort} htmlFor={effortId}>
                <Select
                  id={effortId}
                  className={s['worktree'] ?? ''}
                  width="100%"
                  value={encodeNullable(form.effort)}
                  onChange={(e) => setForm({ ...form, effort: decodeEffort(e.currentTarget.value) })}
                  options={effortOptionsFor(form.agent, form.model, catalogue, form.effort)}
                />
              </Field>
            )}
          </div>
        )}

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
