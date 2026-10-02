import {
  agentCard,
  copy,
  fill,
  readyAgents,
  type AgentCardAction,
  type ReadModel,
  type SetupAgent,
} from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import { LoginTerminal } from '../modals/LoginTerminal';
import s from './AgentSetupCard.module.css';

const MARK = { done: '✓', now: '●', todo: '○' } as const;

type Props = {
  agent: SetupAgent;
  /** Spans two columns in the onboarding grid while it runs (design frame 2). */
  wide?: boolean;
  /** A trailing link the host adds ("I'll do it myself" in the dialog). */
  extra?: ReactNode;
};

/**
 * One AI plan (owner request, design/next/styx-next-agent-setup.html): where it stands in plain words, a checklist
 * while it sets up, and one button. "Set up" runs install → sign in → test in main; the card follows the
 * `agentSetup` row. The installer and sign-in run out of sight; "Show details" attaches their terminal.
 */
export const AgentSetupCard = ({ agent, wide = false, extra }: Props) => {
  const card = useModel(useCallback((m: ReadModel) => agentCard(m, agent), [agent]));
  // The accent marks what asks for you: every Set up until one agent works, then only fixes (sign in, retry…).
  const anyReady = useModel(useCallback((m: ReadModel) => readyAgents(m).length > 0, []));
  const [details, setDetails] = useState(false);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const setup = card.setup;
  const working = card.state === 'working';
  const waiting = working && setup?.status === 'waiting';

  const act = (action: AgentCardAction) => {
    if (action === 'see-plans') void command('agent.setUpPlans', { agent });
    else void command('agent.setUp', { agent, update: action === 'update' });
    setDetails(false);
  };
  const copyLink = () => {
    if (setup?.url == null) return;
    void navigator.clipboard?.writeText(setup.url).then(() => setCopied(true));
  };
  const sendCode = () => {
    if (code.trim() === '') return;
    void command('agent.setUpCode', { agent, code: code.trim() });
    setCode('');
  };

  return (
    <section
      className={s['card']}
      data-state={card.state}
      data-wide={wide && working ? 'true' : undefined}
      data-agent-setup={agent}
      aria-label={card.name}
    >
      <div className={s['head']}>
        <span className={s['sq']} style={{ background: `var(--agent-${agent})` }} aria-hidden="true" />
        <span className={s['name']}>{card.name}</span>
        <span className={s['plan']}>{card.plan}</span>
        <span className={s['badge']} data-agent-badge="true">
          <i aria-hidden="true" />
          {card.badge}
        </span>
      </div>

      {card.what !== null ? <p className={s['what']}>{card.what}</p> : null}

      {card.checks.length > 0 ? (
        <ul className={s['checks']}>
          {card.checks.map((c) => (
            <li key={c.key} data-check={c.state}>
              <i aria-hidden="true">{MARK[c.state]}</i>
              <span className={s['checkText']}>{c.text}</span>
              {c.meta !== null ? <span className={s['meta']}>{c.meta}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {waiting ? (
        <div className={s['browser']} role="status">
          <span>
            <b>{fill(copy.agentSetup.browser.opened, { site: copy.agentSetup.sites[agent] })}</b>{' '}
            {copy.agentSetup.browser.then}
          </span>
          {setup?.url != null ? (
            <button type="button" className={s['link']} onClick={copyLink} data-agent-copy-link="true">
              {copied ? copy.agentSetup.browser.copied : copy.agentSetup.browser.copyLink}
            </button>
          ) : null}
        </div>
      ) : null}

      {waiting && setup?.wantsCode === true ? (
        <form
          className={s['code']}
          onSubmit={(e) => {
            e.preventDefault();
            sendCode();
          }}
        >
          <label>
            <span>{copy.agentSetup.browser.codeLabel}</span>
            <input
              className={s['codeInput']}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              data-agent-code="true"
            />
          </label>
          <Button type="submit" disabled={code.trim() === ''}>
            {copy.agentSetup.browser.codeSend}
          </Button>
        </form>
      ) : null}

      <div className={s['row']}>
        {card.primary !== null ? (
          <Button
            variant={card.primary.action === 'set-up' && anyReady ? 'secondary' : 'accent'}
            onClick={() => act(card.primary?.action ?? 'set-up')}
            data-agent-action={card.primary.action}
          >
            {card.primary.label}
          </Button>
        ) : null}
        {setup?.terminalId != null ? (
          <button
            type="button"
            className={s['link']}
            aria-expanded={details}
            onClick={() => setDetails((d) => !d)}
          >
            {details ? copy.agentSetup.actions.hideDetails : copy.agentSetup.actions.details}
          </button>
        ) : null}
        {working ? (
          <button
            type="button"
            className={s['link']}
            onClick={() => void command('agent.setUpCancel', { agent })}
            data-agent-cancel="true"
          >
            {copy.agentSetup.actions.cancel}
          </button>
        ) : null}
        {extra}
      </div>

      {details && setup?.terminalId != null ? (
        <LoginTerminal terminalId={setup.terminalId} label={card.badge} />
      ) : null}
    </section>
  );
};
