import { copy, fill, type ReadModel } from '@styx/core';
import { Button, Checkbox, Field, Input, Modal, Textarea } from '@styx/ui';
import { useId, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './FeedbackModal.module.css';

export interface FeedbackModalProps {
  id: string;
}

type Phase = { kind: 'editing'; error: string | null } | { kind: 'sending' } | { kind: 'sent' };

const selectEmail = (m: ReadModel): string => (m.account.kind === 'signed-in' ? m.account.account.email : '');

/**
 * Feedback (owner request, #123): a message box, an optional email for a reply (the account's, when signed in),
 * and one line saying what goes with it. Sent through main to the Styx API; the owner reads it on /admin.
 */
export function FeedbackModal({ id }: FeedbackModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const accountEmail = useModel(selectEmail);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState(accountEmail);
  // Off unless ticked (#125): the log goes only when the person chooses to send it.
  const [diagnostics, setDiagnostics] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing', error: null });
  const messageId = useId();
  const emailId = useId();
  const close = () => popOverlay(id);
  const canSend = phase.kind === 'editing' && message.trim() !== '';

  const send = async () => {
    if (!canSend) return;
    setPhase({ kind: 'sending' });
    const r = await command('feedback.send', { message: message.trim(), email: email.trim(), diagnostics });
    setPhase(r.ok ? { kind: 'sent' } : { kind: 'editing', error: r.error.message });
  };

  return (
    <Modal
      width={560}
      title={copy.feedback.title}
      onClose={close}
      bodyPad="20px 16px"
      footer={
        phase.kind === 'sent' ? (
          <Button size="footer" variant="primary" onClick={close} data-feedback-close="true">
            {copy.feedback.close}
          </Button>
        ) : (
          <>
            <Button size="footer" variant="ghost" onClick={close}>
              {copy.general.cancel}
            </Button>
            <Button
              size="footer"
              variant="primary"
              disabled={!canSend}
              onClick={() => void send()}
              data-feedback-send="true"
            >
              {phase.kind === 'sending' ? copy.feedback.sending : copy.feedback.send}
            </Button>
          </>
        )
      }
    >
      {phase.kind === 'sent' ? (
        <p className={s['lead']} data-feedback-sent="true">
          {copy.feedback.sent}
        </p>
      ) : (
        <div className={s['body']} data-feedback-modal="true">
          <p className={s['lead']}>{copy.feedback.lead}</p>
          <Field label={copy.feedback.message} htmlFor={messageId}>
            <Textarea
              id={messageId}
              autoFocus
              minHeight={140}
              maxLength={5000}
              placeholder={copy.feedback.placeholder}
              value={message}
              onChange={(e) => setMessage(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </Field>
          <Field label={copy.feedback.email} htmlFor={emailId}>
            <Input
              id={emailId}
              type="email"
              maxLength={200}
              value={email}
              spellCheck={false}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </Field>
          <Checkbox
            checked={diagnostics}
            onChange={setDiagnostics}
            label={copy.feedback.diagnostics}
            data-feedback-diagnostics="true"
          />
          <p className={s['note']}>{diagnostics ? copy.feedback.diagnosticsNote : copy.feedback.note}</p>
          {phase.kind === 'editing' && phase.error !== null && (
            <p className={s['error']} role="alert" data-feedback-error="true">
              {fill(copy.feedback.failed, { reason: phase.error })}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
