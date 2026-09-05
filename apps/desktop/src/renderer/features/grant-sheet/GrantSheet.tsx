import {
  branchOf,
  copy,
  fill,
  platformCopy,
  type AskId,
  type Duration,
  type Grant,
  type ReadModel,
  type Scope,
  type Session,
  type SessionId,
  type Target,
} from '@styx/core';
import { Button, Checkbox, ChipGroup, Label, Sheet, SheetAccentHeader, SheetFooter, Tag } from '@styx/ui';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { announce } from '../../app/announcer';
import { chromePlatform } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { useUiStore } from '../../state/ui-store';
import {
  DEFAULT_DURATION,
  DURATIONS,
  envTitle,
  grantAnnouncement,
  grantButtonLabel,
  grantPayload,
  providerKind,
  scopeRows,
} from './grant-sheet';
import s from './GrantSheet.module.css';

export interface GrantSheetProps {
  id: string;
  sessionId: SessionId;
  askId: AskId;
}

/** Inline error carried across the eager close → re-push cycle (plan §8: sheet re-opens with an inline error). */
const pendingErrors = new Map<string, string>();

/** Re-opens the sheet for `askId` showing `message` (MFA / issue failure). */
export const reopenGrantSheetWithError = (sessionId: SessionId, askId: AskId, message: string): void => {
  pendingErrors.set(askId, message);
  useUiStore.getState().pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId, askId });
};

/**
 * Grant sheet (spec §4.1 / §10): accent header, `{Target} / {env}` title, PROD + kind tags, quoted reason,
 * scope checkboxes (requested ones pre-checked, may only be unchecked), duration chips (default 1h), fine print,
 * Deny / `Grant {duration} · {MFA}`. Grant closes eagerly and sends `grant.approve`; Mod+⏎ / Mod+⌫ mirror the footer.
 */
export function GrantSheet({ id, sessionId, askId }: GrantSheetProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const model = useModel(useCallback((m: ReadModel) => m, []));
  const ask = model.pendingAsks.byId[askId];
  const grant = ask?.grantId == null ? undefined : model.grants.byId[ask.grantId];
  const target = grant === undefined ? undefined : model.targets.byId[grant.targetId];
  const session = model.sessions.byId[sessionId];
  const close = () => popOverlay(id);

  if (grant === undefined || target === undefined || session === undefined) {
    return (
      <Sheet
        header={<SheetAccentHeader label={copy.grantSheet.title} />}
        title={copy.accessRequest.title}
        onClose={close}
        escapeEnabled={false}
      >
        <div className={s['finePrint']}>{copy.general.none}</div>
      </Sheet>
    );
  }
  // Keyed on the grant so a different request re-seeds the scope/duration state.
  return (
    <GrantForm
      key={grant.id}
      id={id}
      sessionId={sessionId}
      askId={askId}
      grant={grant}
      target={target}
      session={session}
      model={model}
    />
  );
}

interface GrantFormProps extends GrantSheetProps {
  grant: Grant;
  target: Target;
  session: Session;
  model: ReadModel;
}

function GrantForm({ id, sessionId, askId, grant, target, session, model }: GrantFormProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  /** Keyboard Mod follows the OS; platform words (Touch ID / Windows Hello) follow the rendered chrome (spec §7). */
  const platform = useUi((u) => u.platform);
  const copyPlatform = chromePlatform();
  const grantButton = useRef<HTMLButtonElement>(null);
  const requested: readonly Scope[] = grant.scope;

  const [checked, setChecked] = useState<Scope[]>(() => [...requested]);
  const [duration, setDuration] = useState<Duration>(DEFAULT_DURATION);
  const [error, setError] = useState<string | null>(() => {
    const e = pendingErrors.get(askId) ?? null;
    pendingErrors.delete(askId);
    return e;
  });

  const close = () => popOverlay(id);

  /** The agent's verbatim reason: the transcript card carries the full text, the grant the short form. */
  const reason = useMemo(() => {
    const msg = (model.transcripts[sessionId] ?? []).find(
      (m) => m.payload.kind === 'access-request' && m.payload.grantId === grant.id,
    );
    return msg !== undefined && msg.payload.kind === 'access-request' ? msg.payload.reason : grant.reason;
  }, [model.transcripts, sessionId, grant.id, grant.reason]);

  const payload = grantPayload(requested, checked, duration);
  const agent = copy.agents[session.agent];
  const targetLabel = `${target.name} ${target.env}`;

  const deny = () => {
    close();
    void command('grant.deny', { grantId: grant.id });
  };

  const approve = () => {
    if (payload.scope.length === 0) return;
    close();
    void command('grant.approve', {
      grantId: grant.id,
      duration: payload.duration,
      scope: payload.scope,
    }).then((r) => {
      if (r.ok) {
        announce(grantAnnouncement(agent, payload.scope, targetLabel, payload.duration));
      } else {
        reopenGrantSheetWithError(sessionId, askId, r.error.message);
      }
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      approve();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      deny();
    }
  };

  const rows = scopeRows(target.provider, requested);

  return (
    <div onKeyDown={onKeyDown} className={s['root']} data-grant-sheet="true">
      <Sheet
        header={
          <SheetAccentHeader
            label={copy.grantSheet.title}
            meta={fill(copy.grantSheet.who, { agent, branch: branchOf(model, session) })}
          />
        }
        title={
          <>
            {target.name} <span className={s['slash']}>/</span> {envTitle(target.provider, target.env)}
          </>
        }
        onClose={close}
        escapeEnabled={false}
        initialFocus={grantButton}
        footer={
          <SheetFooter>
            <Button size="footer" grow={1} className={s['footerButton']} onClick={deny} data-grant-deny="true">
              {copy.grantSheet.deny}
            </Button>
            <Button
              ref={grantButton}
              size="footer"
              variant="accent"
              grow={1.4}
              className={s['footerButton']}
              onClick={approve}
              disabled={payload.scope.length === 0}
              data-grant-approve="true"
            >
              {grantButtonLabel(target.env, payload.scope, duration, copyPlatform)}
            </Button>
          </SheetFooter>
        }
      >
        <div className={s['tags']}>
          <Tag tone={target.env === 'prod' ? 'strong' : 'neutral'} size="md">
            {target.env}
          </Tag>
          <Tag tone="neutral" size="md">
            {providerKind(target.provider)}
          </Tag>
        </div>
        <div className={s['reason']}>&quot;{reason}&quot;</div>
        <Label as="div" className={s['sectionLabel']}>
          {copy.grantSheet.scopeLabel}
        </Label>
        <div className={s['scopeBox']} role="group" aria-label={copy.grantSheet.scopeLabel}>
          {rows.map((r) => {
            const on = r.requested && checked.includes(r.scope);
            return (
              <Checkbox
                key={r.scope}
                className={[s['scopeRow'], r.requested ? undefined : s['scopeRowOff']]
                  .filter(Boolean)
                  .join(' ')}
                label={r.label}
                labelSide="start"
                checked={on}
                aria-disabled={r.requested ? undefined : true}
                onChange={(next) => {
                  if (!r.requested) return;
                  setChecked((prev) => (next ? [...prev, r.scope] : prev.filter((x) => x !== r.scope)));
                }}
                data-scope={r.scope}
              />
            );
          })}
        </div>
        <Label as="div" className={s['sectionLabel']}>
          {copy.grantSheet.durationLabel}
        </Label>
        <ChipGroup
          aria-label={copy.grantSheet.durationLabel}
          options={DURATIONS.map((d) => ({ value: d, label: copy.grantSheet.durations[d] }))}
          value={duration}
          onChange={(v) => setDuration(v as Duration)}
        />
        {target.env === 'prod' && (
          <div className={s['finePrint']}>
            {fill(copy.grantSheet.prodNote, { mfa: platformCopy(copyPlatform).mfa })}
          </div>
        )}
        {error !== null && (
          <div className={s['error']} role="alert" data-grant-error="true">
            <span className={s['errorDot']} aria-hidden="true" />
            <span>{error}</span>
            <button
              type="button"
              className={s['errorClose']}
              aria-label={copy.general.close}
              onClick={() => setError(null)}
            >
              {copy.general.close}
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
