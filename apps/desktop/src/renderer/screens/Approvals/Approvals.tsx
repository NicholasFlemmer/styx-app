import {
  auditRows,
  copy,
  fill,
  inboxRows,
  policyRuleText,
  type AuditRow,
  type InboxRow,
  type Policy,
  type ReadModel,
} from '@styx/core';
import { Button, Checkbox, Label, Tab, TabRow, Table, TableCell, TableRow, Tag } from '@styx/ui';
import { useCallback, useEffect } from 'react';
import { env } from '../../state/bridge';
import { command } from '../../state/commands';
import { useCopyPlatform, useModel, useNow, useUi } from '../../state/hooks';
import type { ApprovalsTab } from '../../state/ui-store';
import { askForGrant, clockOffsetMinutes, inboxFooter, policiesInOrder, policyMeta } from './approvals-data';
import s from './Approvals.module.css';

const INBOX_COLUMNS = '1fr auto';
/** Prototype audit columns: time 52 · actor 80 · target 140 · action. */
const AUDIT_COLUMNS = '52px 80px 140px 1fr';

const identity = (m: ReadModel) => m;

/** Approvals (spec §4.5): Inbox · N / Policies / Audit log tabs with the policies pane always on the right. */
export function Approvals() {
  const model = useModel(identity);
  const now = useNow();
  const tab = useUi((u) => u.approvalsTab);
  const setApprovalsTab = useUi((u) => u.setApprovalsTab);
  const platform = useCopyPlatform();
  const openSession = useUi((u) => u.openSession);
  const setProject = useUi((u) => u.setProject);
  const setScreen = useUi((u) => u.setScreen);
  const pushOverlay = useUi((u) => u.pushOverlay);

  // Visual-harness state `approvals-audit` lands on the Audit log tab (the drawer itself is pushed by AppRoot).
  useEffect(() => {
    if (env().screen === 'approvals-audit') setApprovalsTab('audit');
  }, [setApprovalsTab]);

  const inbox = inboxRows(model, now);
  const policies = policiesInOrder(model);
  const frozen = typeof env().now === 'number';
  const audit = auditRows(model, now, clockOffsetMinutes(frozen, now));

  const review = useCallback(
    (row: InboxRow) => {
      if (row.sessionId === null) {
        setProject(row.projectId);
        setScreen('workspace');
        return;
      }
      openSession(row.projectId, row.sessionId);
      const ask = askForGrant(model, row.grantId);
      if (ask !== null) {
        pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId: row.sessionId, askId: ask.id });
      }
    },
    [model, openSession, pushOverlay, setProject, setScreen],
  );

  const tabs: { id: ApprovalsTab; label: string }[] = [
    { id: 'inbox', label: fill(copy.approvals.tabs.inboxCount, { n: inbox.length }) },
    { id: 'policies', label: copy.approvals.tabs.policies },
    { id: 'audit', label: copy.approvals.tabs.auditLog },
  ];

  return (
    <div className={s['screen']}>
      <div className={s['main']}>
        <TabRow variant="approvals" aria-label={copy.nav.approvals}>
          {tabs.map((t) => (
            <Tab
              key={t.id}
              variant="approvals"
              label={t.label}
              inv={tab === t.id}
              onClick={() => setApprovalsTab(t.id)}
              id={`approvals-tab-${t.id}`}
              aria-controls="approvals-panel"
              data-approvals-tab={t.id}
            />
          ))}
        </TabRow>
        <div
          id="approvals-panel"
          className={s['pane']}
          role="tabpanel"
          aria-labelledby={`approvals-tab-${tab}`}
          data-approvals-panel={tab}
        >
          {tab === 'inbox' && <Inbox rows={inbox} policies={policies} onReview={review} />}
          {tab === 'policies' && <div className={s['intro']}>{copy.policies.intro}</div>}
          {tab === 'audit' && (
            <AuditLog
              rows={audit}
              onOpen={(row) => pushOverlay({ kind: 'drawer', drawer: 'audit', auditId: row.id })}
            />
          )}
        </div>
      </div>
      <PoliciesPane policies={policies} platform={platform} />
    </div>
  );
}

interface InboxProps {
  rows: InboxRow[];
  policies: Policy[];
  onReview: (row: InboxRow) => void;
}

function Inbox({ rows, policies, onReview }: InboxProps) {
  return (
    <>
      <Table
        columns={INBOX_COLUMNS}
        rowPad="16px 20px"
        gap="14px"
        className={s['inbox']}
        aria-label={copy.approvals.tabs.inbox}
      >
        {rows.map((r) => (
          <TableRow key={r.grantId} className={s['request']} data-grant-id={r.grantId}>
            <TableCell className={s['requestBody']}>
              <span className={s['requestHead']}>
                <span>{r.agent}</span>
                <span className={s['requestProject']}>{r.project}</span>
                <span className={s['requestArrow']} aria-hidden="true">
                  →
                </span>
                <span>{r.target}</span>
                <Tag tone={r.prod ? 'accent' : 'neutral'}>{r.env}</Tag>
                <Tag>{r.scope}</Tag>
              </span>
              <span className={s['requestReason']}>
                "{r.reason}" · {r.age}
              </span>
            </TableCell>
            <TableCell className={s['requestActions']}>
              <Button variant="primary" size="regular" onClick={() => onReview(r)}>
                {copy.approvals.review}
              </Button>
              <Button size="regular" onClick={() => void command('grant.deny', { grantId: r.grantId })}>
                {copy.approvals.deny}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </Table>
      <div className={s['footer']}>{inboxFooter(policies)}</div>
    </>
  );
}

interface AuditLogProps {
  rows: AuditRow[];
  onOpen: (row: AuditRow) => void;
}

function AuditLog({ rows, onOpen }: AuditLogProps) {
  const openId = useUi((u) => {
    for (let i = u.overlays.length - 1; i >= 0; i--) {
      const o = u.overlays[i];
      if (o?.kind === 'drawer' && o.drawer === 'audit') return o.auditId;
    }
    return null;
  });
  return (
    <Table
      columns={AUDIT_COLUMNS}
      rowPad="0 20px"
      gap="16px"
      className={s['audit']}
      aria-label={copy.approvals.tabs.auditLog}
    >
      {rows.map((r) => (
        <TableRow
          key={r.id}
          className={s['auditRow']}
          inv={openId === r.id}
          onActivate={() => onOpen(r)}
          data-audit-id={r.id}
        >
          <TableCell className={s['auditCell']}>{r.t}</TableCell>
          <TableCell className={[s['auditCell'], s['auditWho']].join(' ')}>{r.who}</TableCell>
          <TableCell className={s['auditCell']}>{r.target}</TableCell>
          <TableCell className={s['auditCell']}>{r.what}</TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

interface PoliciesPaneProps {
  policies: Policy[];
  platform: 'darwin' | 'win32';
}

function PoliciesPane({ policies, platform }: PoliciesPaneProps) {
  const exportJson = async () => {
    const result = await command('policy.export', {});
    if (result.ok && typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(result.value.json);
    }
  };
  return (
    <aside className={s['policies']} aria-label={copy.policies.heading}>
      <Label as="h2" strong className={s['policiesHead']}>
        {copy.policies.heading}
      </Label>
      <div className={s['policyList']}>
        {policies.map((p) => (
          <Checkbox
            key={p.id}
            size={16}
            tone="accent"
            checked={p.enabled}
            onChange={(enabled) => void command('policy.toggle', { policyId: p.id, enabled })}
            className={s['policy']}
            data-policy-id={p.id}
            label={
              <span className={s['policyText']}>
                <span className={s['policyRule']}>{policyRuleText(p, platform)}</span>
                <span className={s['policyMeta']}>{policyMeta(p)}</span>
              </span>
            }
          />
        ))}
      </div>
      <div className={s['policiesFoot']}>
        {/* TODO(policy.add): the rule editor is not designed yet; the button is a no-op until it is. */}
        <Button size="regular" onClick={() => undefined}>
          {copy.policies.addRule}
        </Button>
        <Button variant="ghost" size="regular" onClick={() => void exportJson()}>
          {copy.policies.exportJson}
        </Button>
      </div>
    </aside>
  );
}
