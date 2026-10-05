import { ACCOUNT_PROVIDERS, copy, fill, type AccountProvider, type ReadModel } from '@styx/core';
import { Button, Modal, StatusDot } from '@styx/ui';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './SignInModal.module.css';

/** Why the dialog opened, which is the only thing that changes about it. */
export type SignInReason = 'welcome' | 'plain';

export interface SignInModalProps {
  id: string;
  reason?: SignInReason;
}

const selectAccount = (m: ReadModel) => m.account;

const LEAD: Record<SignInReason, string> = {
  welcome: copy.account.modal.welcome,
  plain: copy.account.modal.plain,
};

/**
 * The sign-in dialog (owner request, discrepancy row 113): the shape people already know — a modal, the providers
 * as two buttons, nothing else on screen. The device code appears in the same modal once a provider is picked,
 * so the person never loses the thread, and the modal closes itself the moment the browser side finishes.
 *
 * Settings › Account is where an account is *managed*; this is where one is got.
 */
export function SignInModal({ id, reason = 'plain' }: SignInModalProps) {
  const account = useModel(selectAccount);
  const popOverlay = useUi((u) => u.popOverlay);

  // The browser side finished: nothing left to ask, so the dialog gets out of the way.
  if (account.kind === 'signed-in') {
    popOverlay(id);
    return null;
  }

  const close = () => {
    // Abandoning the dialog abandons the flow with it; a code nobody is watching helps no one.
    if (account.kind === 'signing-in') void command('account.cancelSignIn', {});
    popOverlay(id);
  };

  const signingIn = account.kind === 'signing-in';

  return (
    <Modal
      width={560}
      title={copy.account.modal.title}
      onClose={close}
      bodyPad="20px 16px"
      footer={
        <Button size="footer" onClick={close} data-sign-in-later="true">
          {copy.account.modal.later}
        </Button>
      }
    >
      {signingIn ? (
        <div className={s['body']} data-sign-in-modal="code">
          <span className={['t-label', s['codeLabel']].join(' ')}>{copy.account.modal.codeLabel}</span>
          <span className={s['code']} data-sign-in-code="true">
            {account.userCode}
          </span>
          <div className={s['waiting']}>
            <StatusDot tone="accent" size={7} className={s['blink']} />
            <span className="t-meta">{copy.account.waiting}</span>
          </div>
          <div className={s['actions']}>
            <Button onClick={() => void command('account.openVerification', {})}>
              {copy.account.openAgain}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void command('account.cancelSignIn', {})}
              data-sign-in-switch="true"
            >
              {copy.account.modal.switchProvider}
            </Button>
          </div>
        </div>
      ) : (
        <div className={s['body']} data-sign-in-modal="providers">
          <p className={s['lead']}>{LEAD[reason]}</p>
          <div className={s['providers']}>
            {ACCOUNT_PROVIDERS.map((provider: AccountProvider) => (
              <Button
                key={provider}
                variant="secondary"
                className={s['provider'] ?? ''}
                onClick={() => void command('account.signIn', { provider })}
                data-sign-in-provider={provider}
              >
                {fill(copy.account.signInWith, { provider: copy.account.providers[provider] })}
              </Button>
            ))}
          </div>
          <p className={s['note']}>{copy.account.modal.note}</p>
          {account.error !== null && (
            <div className={s['waiting']} data-sign-in-error="true">
              <StatusDot tone="accent" size={7} />
              <span className="t-meta">{account.error}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
