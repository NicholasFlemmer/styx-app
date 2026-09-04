import {
  auditDetailRows,
  auditRow,
  canRevokeFromAudit,
  copy,
  platformCopy,
  rows,
  type AuditId,
  type ReadModel,
} from '@styx/core';
import { Button, Drawer, DrawerRow } from '@styx/ui';
import { useEffect, useRef } from 'react';
import { env } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useNow, useUi } from '../../state/hooks';
import { clockOffsetMinutes } from '../../screens/Approvals/approvals-data';
import s from './AuditDrawer.module.css';

export interface AuditDrawerProps {
  id: string;
  auditId: AuditId;
}

/** Provenance label written to the revoke audit row (spec §4.8 footer). */
const REVOKE_TRIGGER = 'audit drawer';

const identity = (m: ReadModel) => m;

/**
 * Audit entry drawer (spec §4.8): 380px over the Approvals content. Action as title, `time · actor → target`
 * mono meta, Actor … Policy rows from the structured entry, Copy JSON / Revoke now footer.
 */
export function AuditDrawer({ id, auditId }: AuditDrawerProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const platform = useUi((u) => u.platform);
  const model = useModel(identity);
  const now = useNow();
  // Initial focus lands on the (labelled) dialog body, not the ✕, so opening the drawer paints no focus ring.
  const body = useRef<HTMLDivElement | null>(null);
  const entry = model.auditEntries.byId[auditId];

  // The audit log is append-only, so a missing entry means the drawer outlived its snapshot: close it.
  useEffect(() => {
    if (entry === undefined) popOverlay(id);
  }, [entry, id, popOverlay]);
  if (entry === undefined) return null;

  const policies = rows(model.policies);
  const offset = clockOffsetMinutes(typeof env().now === 'number', now);
  const row = auditRow(entry, policies, now, offset);
  // Policy rule text keeps `{mfa}` until rendered (core `policyRuleText`); the drawer row is built in core, so fill it here.
  const details = auditDetailRows(entry, policies, offset).map((d) =>
    d.k === copy.audit.rows.policy ? { ...d, v: d.v.replaceAll('{mfa}', platformCopy(platform).mfa) } : d,
  );
  const revocable = canRevokeFromAudit(entry, model);
  const close = () => popOverlay(id);

  const copyJson = async () => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
  };
  const revoke = async () => {
    if (entry.grantId === null) return;
    const result = await command('grant.revoke', { grantId: entry.grantId, triggeredBy: REVOKE_TRIGGER });
    if (result.ok) close();
  };

  return (
    <Drawer
      heading={copy.audit.drawerTitle}
      title={<span className={s['title']}>{row.what}</span>}
      meta={
        <span className={s['meta']} data-audit-meta="true">
          {row.t} · {row.who} → {row.target}
        </span>
      }
      onClose={close}
      escapeEnabled={false}
      initialFocus={body}
      footer={
        <>
          <Button size="footer" onClick={() => void copyJson()}>
            {copy.audit.copyJson}
          </Button>
          <Button size="footer" disabled={!revocable} onClick={() => void revoke()}>
            {copy.audit.revokeNow}
          </Button>
        </>
      }
    >
      <div ref={body} tabIndex={-1} className={s['rows']} data-audit-id={entry.id}>
        {details.map((d) => (
          <DrawerRow key={d.k} label={d.k}>
            {d.v}
          </DrawerRow>
        ))}
      </div>
    </Drawer>
  );
}
