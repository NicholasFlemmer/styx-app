import {
  DEFAULT_PROJECT_SETTINGS,
  copy,
  defaultProjectLocation,
  fill,
  platformCopy,
  projectNameOf,
  projectSettingsOfOrDefault,
  type ReadModel,
} from '@styx/core';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from '@styx/ui';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { env } from '../../state/bridge';
import { command } from '../../state/commands';
import { useCopyPlatform, useModel, useUi } from '../../state/hooks';
import {
  BUILTIN_TEMPLATES,
  START_FROM,
  createLabel,
  fallbackIde,
  githubNote,
  githubTargetOf,
  newProjectPayload,
  newProjectValid,
  type NewProjectForm,
  type StartFrom,
} from './modals';
import s from './NewProjectModal.module.css';

export interface NewProjectModalProps {
  id: string;
}

const selectModel = (m: ReadModel) => m;

/** Prototype hints set `styx-template` / `main` in JetBrains Mono; the §10 string stays verbatim in core. */
const monoHint = (text: string, token: string): ReactNode => {
  const i = text.indexOf(token);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span className={s['mono']}>{token}</span>
      {text.slice(i + token.length)}
    </>
  );
};

/**
 * HARNESS ONLY (`STYX_E2E=1` + `STYX_SCREEN=new-project`): the prototype's filled form (name, brief; the location, the
 * agent tile and the GitHub note derive from it), so the `new-project` baseline verifies real field rendering.
 */
const HARNESS_PREFILL = {
  name: 'orders-service',
  brief:
    'A TypeScript service that receives Shopify order webhooks, validates them, and writes to Supabase. Include tests and a Dockerfile.',
} as const;
const harnessPrefill = (): typeof HARNESS_PREFILL | null =>
  env().e2e === true && env().screen === 'new-project' ? HARNESS_PREFILL : null;

/**
 * New project (spec §4.12, modal 600): Name / Location, Start from tiles (empty · template · agent), per-start
 * field, four toggles, GitHub note, Cancel / `Create (· spawn {agent}) · Mod⏎`. Agent scaffolds land in Workspace.
 */
export function NewProjectModal({ id }: NewProjectModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const openSession = useUi((u) => u.openSession);
  const setProject = useUi((u) => u.setProject);
  const setScreen = useUi((u) => u.setScreen);
  /** Keyboard Mod follows the OS; words and the default location follow the rendered chrome (spec §7). */
  const platform = useUi((u) => u.platform);
  const copyPlatform = useCopyPlatform();
  const projectId = useUi((u) => u.projectId);
  const model = useModel(selectModel);
  const words = platformCopy(copyPlatform);
  const prefill = harnessPrefill();

  const github = githubTargetOf(model, projectId);
  const ide = fallbackIde(model);
  const agent =
    projectId === null
      ? DEFAULT_PROJECT_SETTINGS.defaultAgent
      : projectSettingsOfOrDefault(model, projectId).defaultAgent;

  const [form, setForm] = useState<NewProjectForm>(() => ({
    name: prefill?.name ?? '',
    location: defaultProjectLocation(prefill?.name ?? '', copyPlatform),
    startFrom: 'agent',
    template: BUILTIN_TEMPLATES[0]?.value ?? 'node',
    brief: prefill?.brief ?? '',
    gitInit: true,
    createGithubRepo: github !== undefined,
    copyTargets: false,
    openInIde: false,
  }));
  const [locationTouched, setLocationTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const locationId = useId();
  const templateId = useId();
  const briefId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  const close = () => popOverlay(id);
  const setName = (name: string) =>
    setForm((f) => ({
      ...f,
      name,
      location: locationTouched ? f.location : defaultProjectLocation(name.trim(), copyPlatform),
    }));
  /** Create stays enabled (prototype); an incomplete form moves focus to the first missing field instead. */
  const create = async () => {
    if (busy) return;
    if (!newProjectValid(form)) {
      if (form.name.trim() === '') nameRef.current?.focus();
      else if (form.startFrom === 'agent') briefRef.current?.focus();
      return;
    }
    setBusy(true);
    const r = await command('project.create', newProjectPayload(form, agent, projectId));
    setBusy(false);
    if (!r.ok) return;
    close();
    if (r.value.sessionId !== null) openSession(r.value.projectId, r.value.sessionId);
    else {
      setProject(r.value.projectId);
      setScreen('home');
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      void create();
    }
  };
  const connectGithub = () => pushOverlay({ kind: 'modal', modal: 'connect', projectId, provider: 'github' });

  const agentName = copy.agentProducts[agent];

  return (
    <Modal
      width={600}
      top={70}
      title={copy.newProject.title}
      onClose={close}
      escapeEnabled={false}
      initialFocus={nameRef}
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={close}>
            {copy.newProject.cancel}
          </Button>
          <Button size="footer" variant="primary" disabled={busy} onClick={() => void create()}>
            {createLabel(form.startFrom, agent, copyPlatform, words.mod)}
          </Button>
        </>
      }
    >
      <div className={s['root']} onKeyDown={onKeyDown} data-new-project-modal="true">
        <div className={s['head']}>
          <Field label={copy.newProject.name} htmlFor={nameId}>
            <Input
              ref={nameRef}
              id={nameId}
              mono
              value={form.name}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Field>
          <Field label={copy.newProject.location} htmlFor={locationId}>
            <Input
              id={locationId}
              mono
              value={form.location}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setLocationTouched(true);
                setForm({ ...form, location: e.currentTarget.value });
              }}
              trailing={
                // TODO(main): no folder-picker command in the contract yet; Browse stays disabled.
                <button type="button" className={s['browse']} disabled title={copy.newProject.browse}>
                  {copy.newProject.browse}
                </button>
              }
            />
          </Field>
        </div>

        <Field label={copy.newProject.startFrom}>
          <div className={s['starts']} role="radiogroup" aria-label={copy.newProject.startFrom}>
            {START_FROM.map((k: StartFrom) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={form.startFrom === k}
                data-inv={form.startFrom === k ? 'true' : undefined}
                data-start={k}
                className={s['start']}
                onClick={() => setForm({ ...form, startFrom: k })}
              >
                <span className={s['startLabel']}>{copy.newProject.starts[k].label}</span>
                <span className={s['startDesc']}>{copy.newProject.starts[k].desc}</span>
              </button>
            ))}
          </div>
        </Field>

        {form.startFrom === 'template' ? (
          <Field
            label={copy.newProject.templateLabel}
            htmlFor={templateId}
            hint={monoHint(copy.newProject.templateNote, 'styx-template')}
          >
            <Select
              id={templateId}
              className={s['template'] ?? ''}
              width="100%"
              value={form.template}
              onChange={(e) => setForm({ ...form, template: e.currentTarget.value })}
              options={BUILTIN_TEMPLATES.map((t) => ({ value: t.value, label: t.label }))}
            />
          </Field>
        ) : null}
        {form.startFrom === 'agent' ? (
          <Field
            label={fill(copy.newProject.briefLabel, { agent: agentName })}
            htmlFor={briefId}
            hint={monoHint(copy.newProject.agentNote, 'main')}
          >
            <Textarea
              ref={briefRef}
              id={briefId}
              minHeight={64}
              value={form.brief}
              onChange={(e) => setForm({ ...form, brief: e.currentTarget.value })}
            />
          </Field>
        ) : null}

        <div className={s['toggles']}>
          <Checkbox
            checked={form.gitInit}
            onChange={(v) => setForm({ ...form, gitInit: v })}
            label={copy.newProject.gitInit}
          />
          {github !== undefined ? (
            <Checkbox
              checked={form.createGithubRepo}
              onChange={(v) => setForm({ ...form, createGithubRepo: v })}
              label={copy.newProject.createGithubRepo}
            />
          ) : (
            <button type="button" className={s['link']} onClick={connectGithub}>
              {copy.newProject.connectGithub}
            </button>
          )}
          {projectId !== null ? (
            <Checkbox
              checked={form.copyTargets}
              onChange={(v) => setForm({ ...form, copyTargets: v })}
              label={fill(copy.newProject.copyTargets, { project: projectNameOf(model, projectId) })}
            />
          ) : null}
          {ide !== undefined ? (
            <Checkbox
              checked={form.openInIde}
              onChange={(v) => setForm({ ...form, openInIde: v })}
              label={fill(copy.newProject.openInIde, { ide: ide.product })}
            />
          ) : null}
        </div>

        {github !== undefined && form.createGithubRepo ? (
          <div className={s['note']}>{githubNote(github, form.name.trim())}</div>
        ) : null}
      </div>
    </Modal>
  );
}
