import {
  cliAccountLabel,
  cliConnectionLabel,
  cliConnectionState,
  cliLocationLabel,
  copy,
  type Agent,
  type CliInstall,
  type ReadModel,
} from '@styx/core';
import { Label, StatusDot, Table, TableCell, TableRow, TABLE_COLUMNS } from '@styx/ui';
import { useState, type ReactNode } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './AgentsPane.module.css';

const selectClis = (m: ReadModel) => m.discovery.clis;

/** One row per agent kind, prototype order (`copy.agentProducts`), shell included. */
const AGENT_ORDER = Object.keys(copy.agentProducts) as Agent[];

/** A CLI nothing has detected yet renders as not installed rather than vanishing from the page. */
const undetected = (agent: Agent): CliInstall => ({
  agent,
  binary: null,
  version: null,
  found: false,
  authState: agent === 'shell' ? 'n/a' : 'unknown',
  capabilities: {},
  checkedAt: 0,
  account: null,
  verifiedAt: null,
  verifyError: null,
});

/**
 * Settings › App › Agents (owner addition): the app-level agent connections, mirroring the Targets table. Each CLI
 * is connected and verified once here (`agent.verify` asks the CLI who it is signed in as; Connect opens the
 * Connect agent modal), then spawned per project. The label/value preferences (default agent, worktree per agent,
 * detected binaries …) render below the table as `children`.
 */
export function AgentsPane({ children }: { children?: ReactNode }) {
  const clis = useModel(selectClis);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [checking, setChecking] = useState<readonly Agent[]>([]);

  const rows = AGENT_ORDER.map((agent) => clis.find((c) => c.agent === agent) ?? undetected(agent));

  const verify = async (agent: Agent) => {
    if (checking.includes(agent)) return;
    setChecking((list) => [...list, agent]);
    await command('agent.verify', { agent });
    setChecking((list) => list.filter((a) => a !== agent));
  };
  const connect = (agent: Agent) => pushOverlay({ kind: 'modal', modal: 'connect-agent', agent });

  const c = copy.agentsPage.columns;
  const a = copy.agentsPage.actions;
  return (
    <>
      <p className={s['lead']}>{copy.agentsPage.lead}</p>
      <Table
        columns={TABLE_COLUMNS.agents}
        header={[c.agent, c.version, c.account, c.state, '']}
        rowPad="12px 20px"
        aria-label={copy.agentsPage.title}
      >
        {rows.map((cli) => {
          const name = copy.agentProducts[cli.agent];
          const state = cliConnectionState(cli);
          const busy = checking.includes(cli.agent);
          const stateText = busy
            ? copy.agentsPage.state.checking
            : cli.verifyError !== null
              ? copy.agentsPage.state.failed
              : cliConnectionLabel(state);
          const ready = state === 'connected' || state === 'shell';
          const connectLabel = state === 'connected' ? a.reconnect : a.connect;
          return (
            <TableRow key={cli.agent} data-agent-row={cli.agent} data-agent-state={state}>
              <TableCell strong>{name}</TableCell>
              <TableCell mono muted>
                {cliLocationLabel(cli)}
              </TableCell>
              {/* A stale account on a row that is no longer installed is not an identity anyone can use. The
                  Codex verifier reports "email · plan", wider than the column: ellipsis, full text as title. */}
              <TableCell
                mono
                className={s['account']}
                title={cli.found ? cliAccountLabel(cli) : copy.general.none}
                data-agent-account="true"
              >
                {cli.found ? cliAccountLabel(cli) : copy.general.none}
              </TableCell>
              <TableCell mono muted className={s['state']} aria-busy={busy || undefined} aria-live="polite">
                <StatusDot tone="hollow" on={!ready} />
                <span>{stateText}</span>
              </TableCell>
              <TableCell label muted align="end" className={s['actions']}>
                {cli.agent === 'shell' ? null : (
                  <>
                    {cli.found ? (
                      <button
                        type="button"
                        className={s['action']}
                        aria-disabled={busy || undefined}
                        aria-label={`${a.verify} · ${name}`}
                        onClick={() => void verify(cli.agent)}
                      >
                        {a.verify}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={s['action']}
                      aria-label={`${connectLabel} · ${name}`}
                      onClick={() => connect(cli.agent)}
                    >
                      {connectLabel}
                    </button>
                  </>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </Table>
      <Label as="div" className={s['prefHead']}>
        {copy.agentsPage.preferences}
      </Label>
      {children}
    </>
  );
}
