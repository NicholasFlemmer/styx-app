import { copy, fill, projectSettingsOfOrDefault, type ReadModel, type WorktreeId } from '@styx/core';
import { Button, Field, Modal, Textarea } from '@styx/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './LandModal.module.css';
import { splitMessage } from './PublishModal';

export interface LandModalProps {
  id: string;
  worktreeId: WorktreeId;
}

type DraftState = 'running' | 'done' | 'failed';

interface Preview {
  base: string;
  files: number;
  willPush: boolean;
  remote: string | null;
}

export interface LandStep {
  state: 'running' | 'done' | 'failed';
  text: string;
}

const joinMessage = (m: { title: string; body: string }): string =>
  m.body.trim() === '' ? m.title : `${m.title}\n\n${m.body}`;

/** `3 files changed` / `1 file changed`. */
export const filesLine = (n: number): string => (n === 1 ? copy.land.filesOne : fill(copy.land.files, { n }));

/**
 * Land a lane into the base branch (ADR-0025 phase C). The summary is drafted by the project's default agent from
 * the changes and is editable; the preview says how many files land and whether the base is pushed afterwards.
 * Land runs one `worktree.land` and lists what it did (or the reason it stopped) in place of the form.
 */
export function LandModal({ id, worktreeId }: LandModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const wt = useModel(useCallback((m: ReadModel) => m.worktrees.byId[worktreeId] ?? null, [worktreeId]));
  const settings = useModel(
    useCallback((m: ReadModel) => (wt === null ? null : projectSettingsOfOrDefault(m, wt.projectId)), [wt]),
  );
  const agent = settings === null ? copy.general.none : copy.agentProducts[settings.defaultAgent];
  const branch = wt?.branch ?? copy.general.none;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState('');
  // The draft is in flight from the first render (the effect below sends for it).
  const [draft, setDraft] = useState<DraftState>('running');
  const [draftError, setDraftError] = useState<string | null>(null);
  const touched = useRef(false);
  const [phase, setPhase] = useState<'edit' | 'running' | 'done'>('edit');
  const [steps, setSteps] = useState<LandStep[]>([]);
  const messageId = useId();
  const base = preview?.base ?? settings?.baseBranch ?? 'main';

  // The preview and the draft start at once; a draft never overwrites text the user already typed.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    void command('worktree.landPreview', { worktreeId }).then((r) => {
      if (!alive.current || !r.ok) return;
      setPreview({
        base: r.value.base,
        files: r.value.files.length,
        willPush: r.value.willPush,
        remote: r.value.remote,
      });
    });
    void command('worktree.generateMessage', { worktreeId, kind: 'commit' }).then((r) => {
      if (!alive.current) return;
      if (r.ok) {
        if (!touched.current) setMessage(joinMessage(r.value));
        setDraft('done');
      } else {
        setDraftError(r.error.message);
        setDraft('failed');
      }
    });
  }, [worktreeId]);

  const close = () => popOverlay(id);
  const parsed = splitMessage(message);
  const canRun = phase === 'edit' && wt !== null && parsed.title !== '';

  const run = useCallback(async () => {
    if (!canRun) return;
    setPhase('running');
    setSteps([{ state: 'running', text: fill(copy.land.landing, { branch }) }]);
    const r = await command('worktree.land', { worktreeId, message: parsed });
    if (!alive.current) return;
    if (!r.ok) {
      setSteps([{ state: 'failed', text: fill(copy.land.failed, { error: r.error.message }) }]);
      setPhase('done');
      return;
    }
    const pushed = r.value.pushed
      ? fill(copy.land.pushedSuffix, { remote: preview?.remote ?? 'origin' })
      : '';
    setSteps([
      ...r.value.steps.map((text): LandStep => ({ state: 'done', text })),
      { state: 'done', text: fill(copy.land.done, { branch, base, pushed }) },
    ]);
    setPhase('done');
  }, [canRun, worktreeId, parsed, branch, base, preview]);

  const hint =
    draft === 'running'
      ? copy.land.generating
      : draft === 'failed'
        ? fill(copy.publish.generateFailed, { error: draftError ?? '' })
        : undefined;

  return (
    <Modal
      width={560}
      title={fill(copy.land.title, { branch, base })}
      onClose={close}
      bodyPad="20px 16px"
      footer={
        phase === 'done' ? (
          <Button size="footer" variant="primary" onClick={close} data-land-close="true">
            {copy.deploy.close}
          </Button>
        ) : (
          <>
            <Button size="footer" variant="ghost" onClick={close} disabled={phase === 'running'}>
              {copy.general.cancel}
            </Button>
            <Button
              size="footer"
              variant="primary"
              disabled={!canRun}
              onClick={() => void run()}
              data-land-run="true"
            >
              {copy.land.run}
            </Button>
          </>
        )
      }
    >
      <div className={s['root']} data-land-modal="true" data-phase={phase}>
        {phase === 'edit' ? (
          <>
            <p className={s['lead']}>{fill(copy.land.lead, { branch, agent, base })}</p>
            <ul
              className={s['facts']}
              data-land-preview={preview === null ? 'loading' : 'ready'}
              data-loading={preview === null}
            >
              {preview === null ? (
                <li>{copy.land.loading}</li>
              ) : (
                <>
                  <li>{filesLine(preview.files)}</li>
                  <li>
                    {preview.willPush
                      ? fill(copy.land.willPush, { base: preview.base, remote: preview.remote ?? '' })
                      : fill(copy.land.noPush, { base: preview.base })}
                  </li>
                </>
              )}
            </ul>
            <Field
              label={copy.land.messageLabel}
              htmlFor={messageId}
              {...(hint !== undefined ? { hint } : {})}
              data-land-draft={draft}
            >
              <Textarea
                id={messageId}
                mono
                minHeight={88}
                value={message}
                spellCheck={false}
                onChange={(e) => {
                  touched.current = true;
                  setMessage(e.currentTarget.value);
                }}
              />
            </Field>
          </>
        ) : null}
        {steps.length > 0 ? (
          <ol className={s['steps']} aria-label={copy.land.run} data-land-steps="true">
            {steps.map((l, i) => (
              <li
                key={i}
                className={s['step']}
                data-land-step={i}
                data-state={l.state}
                {...(l.state === 'failed' ? { role: 'alert' } : {})}
              >
                <span className={s['dot']} aria-hidden="true" />
                <span className={s['stepText']}>{l.text}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </Modal>
  );
}
