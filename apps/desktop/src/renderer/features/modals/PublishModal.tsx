import { copy, fill, projectSettingsOfOrDefault, type ReadModel, type WorktreeId } from '@styx/core';
import { Button, Checkbox, ChipGroup, Field, Input, Modal, Textarea } from '@styx/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './PublishModal.module.css';

export interface PublishModalProps {
  id: string;
  worktreeId: WorktreeId;
}

export type PublishThrough = 'commit' | 'push' | 'pr';
const ORDER: readonly PublishThrough[] = ['commit', 'push', 'pr'];

type DraftState = 'idle' | 'running' | 'done' | 'failed';

export interface StepLine {
  step: PublishThrough;
  state: 'running' | 'done' | 'failed';
  text: string;
}

/** Commit message textarea → `{ title, body }`: first line is the subject, the rest (after a blank) the body. */
export const splitMessage = (text: string): { title: string; body: string } => {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  const title = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n').trim();
  return { title, body };
};

const joinMessage = (m: { title: string; body: string }): string =>
  m.body.trim() === '' ? m.title : `${m.title}\n\n${m.body}`;

/** The default reach: a lane with an open PR only needs commit & push; without one, open the PR; main never PRs. */
export const defaultThrough = (
  wt: Pick<ReadModel['worktrees']['byId'][string], 'isMain' | 'pr'> | null,
): PublishThrough => {
  if (wt === null || wt.isMain) return 'push';
  return wt.pr !== null && (wt.pr.state === 'open' || wt.pr.state === 'draft') ? 'push' : 'pr';
};

/**
 * Commit, push and pull request in one step (owner request, modelled on t3code; ADR-0021). The message is drafted
 * by the project's default agent from the diff and is editable before anything is sent; the reach (commit only ·
 * commit & push · … & open PR) is a chip group. Publishing runs the steps as successive `worktree.publish` calls
 * (`through: 'commit'`, then `'push'`, then `'pr'`), each reusing what the previous one did, so the progress list
 * reports every step from the same command and a failure stops at the step that failed.
 */
export function PublishModal({ id, worktreeId }: PublishModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const wt = useModel(useCallback((m: ReadModel) => m.worktrees.byId[worktreeId] ?? null, [worktreeId]));
  const agent = useModel(
    useCallback(
      (m: ReadModel) =>
        wt === null ? null : copy.agentProducts[projectSettingsOfOrDefault(m, wt.projectId).defaultAgent],
      [wt],
    ),
  );
  const branch = wt?.branch ?? copy.general.none;
  const baseBranch = useModel(
    useCallback(
      (m: ReadModel) => (wt === null ? 'main' : projectSettingsOfOrDefault(m, wt.projectId).baseBranch),
      [wt],
    ),
  );
  // No remote (owner report): commit still works; push and PR wait on one, and the notice offers to connect it.
  const noRemote = useModel(
    useCallback((m: ReadModel) => wt !== null && (m.repos.byId[wt.repoId]?.remotes.length ?? 0) === 0, [wt]),
  );
  const [through, setThrough] = useState<PublishThrough>(() => (noRemote ? 'commit' : defaultThrough(wt)));
  const [message, setMessage] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [isDraft, setIsDraft] = useState(false);
  const [drafts, setDrafts] = useState<{ commit: DraftState; pr: DraftState }>({
    commit: 'idle',
    pr: 'idle',
  });
  const [draftError, setDraftError] = useState<{ commit: string | null; pr: string | null }>({
    commit: null,
    pr: null,
  });
  const touched = useRef({ commit: false, pr: false });
  const [phase, setPhase] = useState<'edit' | 'running' | 'done'>('edit');
  const [steps, setSteps] = useState<StepLine[]>([]);
  const [prResult, setPrResult] = useState<{ number: number; url: string } | null>(null);
  const messageId = useId();
  const prTitleId = useId();
  const prBodyId = useId();

  // The commit message draft starts at once; the PR draft when the reach first includes a PR. A draft never
  // overwrites text the user already typed, and one in flight outlives a reach change (switching chips must not
  // drop the reply); only unmount does.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const requested = useRef({ commit: false, pr: false });
  const draft = useCallback(
    (kind: 'commit' | 'pr') => {
      if (requested.current[kind]) return;
      requested.current[kind] = true;
      setDrafts((d) => ({ ...d, [kind]: 'running' }));
      void command('worktree.generateMessage', { worktreeId, kind }).then((r) => {
        if (!alive.current) return;
        if (r.ok) {
          if (!touched.current[kind]) {
            if (kind === 'commit') setMessage(joinMessage(r.value));
            else {
              setPrTitle(r.value.title);
              setPrBody(r.value.body);
            }
          }
          setDrafts((d) => ({ ...d, [kind]: 'done' }));
        } else {
          setDraftError((e) => ({ ...e, [kind]: r.error.message }));
          setDrafts((d) => ({ ...d, [kind]: 'failed' }));
        }
      });
    },
    [worktreeId],
  );
  useEffect(() => draft('commit'), [draft]);
  useEffect(() => {
    if (through === 'pr') draft('pr');
  }, [through, draft]);

  const close = () => popOverlay(id);
  const commitMessage = splitMessage(message);
  const canRun =
    phase === 'edit' &&
    wt !== null &&
    (commitMessage.title !== '' || (through === 'pr' && prTitle.trim() !== ''));

  const run = useCallback(async () => {
    if (!canRun || wt === null) return;
    setPhase('running');
    const priorPr = wt.pr?.number ?? null;
    const reach = ORDER.slice(0, ORDER.indexOf(through) + 1);
    const lines: StepLine[] = [];
    const show = () => setSteps([...lines]);
    for (const step of reach) {
      const line: StepLine = { step, state: 'running', text: copy.publish.running[step] };
      lines.push(line);
      show();
      // The PR step carries the PR title and description; the commit step the commit message (either one stands
      // in for the other when it is empty — a clean tree never uses the commit message anyway).
      const pr = { title: prTitle.trim() || commitMessage.title, body: prBody };
      const msg =
        step === 'pr' ? pr : commitMessage.title !== '' ? commitMessage : { title: pr.title, body: '' };
      const r = await command('worktree.publish', {
        worktreeId,
        through: step,
        message: msg,
        draft: isDraft,
      });
      if (!r.ok) {
        line.state = 'failed';
        line.text = fill(copy.publish.failed, { step: copy.publish.through[step], error: r.error.message });
        show();
        setPhase('done');
        return;
      }
      line.state = 'done';
      if (step === 'commit')
        line.text =
          r.value.commit === null
            ? copy.publish.nothingToCommit
            : fill(copy.publish.done.commit, { commit: r.value.commit.slice(0, 7) });
      else if (step === 'push')
        line.text =
          (r.value.synced !== undefined && r.value.synced > 0
            ? fill(copy.publish.synced, { n: r.value.synced, base: baseBranch })
            : r.value.syncSkipped !== undefined
              ? fill(copy.publish.syncSkipped, { base: baseBranch, reason: r.value.syncSkipped })
              : '') + fill(copy.publish.done.push, { branch });
      else if (r.value.pr !== null) {
        line.text =
          r.value.pr.number === priorPr
            ? fill(copy.publish.prExists, { number: r.value.pr.number })
            : fill(copy.publish.done.pr, { number: r.value.pr.number });
        setPrResult(r.value.pr);
      }
      show();
    }
    setPhase('done');
  }, [canRun, wt, through, prTitle, prBody, commitMessage, isDraft, worktreeId, branch, baseBranch]);

  const throughOptions = (['commit', 'push', 'pr'] as const).map((v) => ({
    value: v,
    label: copy.publish.through[v],
    ...(v === 'pr' && wt?.isMain === true ? { disabled: true } : {}),
  }));

  const hint = (kind: 'commit' | 'pr'): string | undefined => {
    if (drafts[kind] === 'running') return copy.publish.generating;
    if (drafts[kind] === 'failed')
      return fill(copy.publish.generateFailed, { error: draftError[kind] ?? '' });
    return undefined;
  };

  return (
    <Modal
      width={560}
      title={fill(copy.publish.title, { branch })}
      onClose={close}
      bodyPad="20px 16px"
      footer={
        phase === 'done' ? (
          <>
            {prResult !== null ? (
              <Button
                size="footer"
                variant="secondary"
                onClick={() => void command('link.open', { url: prResult.url })}
                data-publish-open-pr="true"
              >
                {fill(copy.publish.openPr, { number: prResult.number })}
              </Button>
            ) : null}
            <Button size="footer" variant="primary" onClick={close} data-publish-close="true">
              {copy.deploy.close}
            </Button>
          </>
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
              data-publish-run="true"
            >
              {copy.publish.run}
            </Button>
          </>
        )
      }
    >
      <div className={s['root']} data-publish-modal="true" data-phase={phase}>
        {phase === 'edit' ? (
          <>
            <p className={s['lead']}>{fill(copy.publish.lead, { agent: agent ?? copy.general.none })}</p>
            {noRemote && wt !== null ? (
              <div className={s['notice']} role="status" data-publish-no-remote="true">
                <span>{copy.publish.noRemoteHint}</span>
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => {
                    popOverlay(id);
                    pushOverlay({
                      kind: 'modal',
                      modal: 'connect-repo',
                      projectId: wt.projectId,
                      returnTo: { modal: 'publish', worktreeId },
                    });
                  }}
                  data-publish-connect="true"
                >
                  {copy.repo.connect}
                </Button>
              </div>
            ) : null}
            <ChipGroup
              layout="inline"
              size="env"
              aria-label={copy.publish.run}
              options={
                noRemote
                  ? throughOptions.map((o) => ({ ...o, disabled: o.value !== 'commit' }))
                  : throughOptions
              }
              value={through}
              onChange={(v) => setThrough(v as PublishThrough)}
              data-publish-through="true"
            />
            <Field
              label={copy.publish.messageLabel}
              htmlFor={messageId}
              {...(hint('commit') !== undefined ? { hint: hint('commit') } : {})}
              data-publish-draft={drafts.commit}
            >
              <Textarea
                id={messageId}
                mono
                minHeight={88}
                value={message}
                spellCheck={false}
                onChange={(e) => {
                  touched.current.commit = true;
                  setMessage(e.currentTarget.value);
                }}
              />
            </Field>
            {through === 'pr' ? (
              <>
                <Field
                  label={copy.publish.prTitleLabel}
                  htmlFor={prTitleId}
                  {...(hint('pr') !== undefined ? { hint: hint('pr') } : {})}
                  data-publish-draft-pr={drafts.pr}
                >
                  <Input
                    id={prTitleId}
                    value={prTitle}
                    spellCheck={false}
                    onChange={(e) => {
                      touched.current.pr = true;
                      setPrTitle(e.currentTarget.value);
                    }}
                  />
                </Field>
                <Field label={copy.publish.prBodyLabel} htmlFor={prBodyId}>
                  <Textarea
                    id={prBodyId}
                    mono
                    minHeight={120}
                    value={prBody}
                    onChange={(e) => {
                      touched.current.pr = true;
                      setPrBody(e.currentTarget.value);
                    }}
                  />
                </Field>
                <Checkbox
                  tone="accent"
                  checked={isDraft}
                  onChange={setIsDraft}
                  label={copy.publish.draft}
                  data-publish-draft-toggle="true"
                />
              </>
            ) : null}
          </>
        ) : null}
        {steps.length > 0 ? (
          <ol className={s['steps']} aria-label={copy.publish.run} data-publish-steps="true">
            {steps.map((l) => (
              <li
                key={l.step}
                className={s['step']}
                data-publish-step={l.step}
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
