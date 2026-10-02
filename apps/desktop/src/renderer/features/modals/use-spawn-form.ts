import {
  activeLanes,
  copy,
  modelCatalogueFor,
  projectSettingsOfOrDefault,
  startingAgent,
  type Agent,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type TaskKind,
} from '@styx/core';
import { useCallback, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import {
  decodeModel,
  effortLevelsFor,
  reconcileSessionSettings,
  spawnControlsFor,
} from '../chat/session-controls';
import {
  autoBranchFor,
  cliMissing,
  cliNotConnected,
  defaultSessionSettings,
  defaultToggles,
  projectWorktrees,
  spawnPayload,
  spawnValid,
  worktreeChoices,
  type SpawnForm,
} from './modals';

const selectModel = (m: ReadModel) => m;

/**
 * Everything starting an agent needs (spec §4.11), shared by the Spawn dialog and the workspace's New task
 * (ADR-0027 §1): the form seeded from the project's defaults, the agent pick that reconciles model and effort
 * (#83), whether the CLI is missing or signed out, the worktree choices and the lanes already running (ADR-0025),
 * Locate binary, and the spawn itself. Each caller lays it out its own way.
 */
export function useSpawnForm(projectId: ProjectId, initialMessage = '') {
  const model = useModel(selectModel);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [form, setForm] = useState<SpawnForm>(() => {
    // Starts with an agent that works (owner request): the project's default when it is ready, else one that is.
    const preferred = projectSettingsOfOrDefault(model, projectId).defaultAgent;
    const agent = startingAgent(model, preferred);
    const base: SpawnForm = {
      agent,
      worktree: worktreeChoices(model, projectId).initial,
      branch: autoBranchFor(model, projectId, agent),
      firstMessage: initialMessage,
      toggles: defaultToggles(model, projectId),
      ...defaultSessionSettings(model, projectId),
    };
    return agent === preferred
      ? base
      : reconcileSessionSettings(agent, base, modelCatalogueFor(model, agent));
  });
  const [branchTouched, setBranchTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const catalogue = modelCatalogueFor(model, form.agent);
  /** The tile drives the model / effort lists: a pick the new agent does not offer resets to its default (#83). */
  const pickAgent = (agent: Agent) =>
    setForm((f) =>
      reconcileSessionSettings(
        agent,
        { ...f, agent, branch: branchTouched ? f.branch : autoBranchFor(model, projectId, agent) },
        modelCatalogueFor(model, agent),
      ),
    );
  /** A model without the current effort (Codex `gpt-5.5` has no `ultra`) drops the effort back to default. */
  const pickModel = (value: string) =>
    setForm((f) => {
      const next = { ...f, model: decodeModel(value) };
      return next.effort !== null && !effortLevelsFor(f.agent, next.model, catalogue).includes(next.effort)
        ? { ...next, effort: null }
        : next;
    });
  const setBranch = (branch: string) => {
    setBranchTouched(true);
    setForm((f) => ({ ...f, branch }));
  };

  const missing = cliMissing(model, form.agent);
  /** Installed but signed out: warns without blocking (the CLI may still hold an API key Styx cannot see). */
  const notConnected = !missing && cliNotConnected(model, form.agent);
  const valid = spawnValid(model, form) && !busy;

  /**
   * Starts the agent; resolves to the new session's id, or null when it did not start. `firstMessage` overrides the
   * form's (a starter task starts with its own words in one click); `kind` makes it a design or build task (#140).
   */
  const spawn = useCallback(
    async (firstMessage?: string, kind: TaskKind | null = null): Promise<SessionId | null> => {
      if (!spawnValid(model, form) || busy) return null;
      setBusy(true);
      const r = await command('session.spawn', {
        ...spawnPayload(model, projectId, firstMessage === undefined ? form : { ...form, firstMessage }),
        kind,
      });
      setBusy(false);
      return r.ok ? r.value.sessionId : null;
    },
    [model, form, busy, projectId],
  );

  /**
   * OS file picker → `detect.setBinary`; the `discovery.set` delta clears the missing row when the probe succeeds.
   * A refused pick (a folder, a file that does not run, another agent's CLI) says why, so the user can pick again.
   */
  const locateBinary = async () => {
    const r = await command('dialog.pickFile', { title: copy.errors.locateBinary });
    if (!r.ok || r.value.path === null) return;
    const set = await command('detect.setBinary', { agent: form.agent, path: r.value.path });
    setLocateError(set.ok ? null : set.error.message);
  };
  /** The agent's setup card (one place for every Set up / Install guide; owner request). */
  const installGuide = () => {
    if (form.agent === 'shell') return;
    pushOverlay({ kind: 'modal', modal: 'connect-agent', agent: form.agent });
  };

  return {
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
    busy,
    spawn,
    locateError,
    locateBinary,
    installGuide,
    worktrees: projectWorktrees(model, projectId),
    choices: worktreeChoices(model, projectId),
    lanes: activeLanes(model, projectId),
    settings: spawnControlsFor(form.agent),
  };
}
