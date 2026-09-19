import {
  copy,
  limitRows,
  usageByAgent,
  usageByProject,
  usageCells,
  type LimitRow,
  type ReadModel,
  type UsageTable,
} from '@styx/core';
import { Button, Label, TABLE_COLUMNS, Table, TableCell, TableRow } from '@styx/ui';
import { useCallback, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useNow } from '../../state/hooks';
import s from './Usage.module.css';

const selectByAgent = (m: ReadModel) => usageByAgent(m);
const selectByProject = (m: ReadModel) => usageByProject(m);

const c = copy.usage.columns;

/** By agent / By project: name · sessions · turns · tokens · cost, a Total row last; "No sessions yet." when empty. */
function UsageBlock({
  id,
  title,
  first,
  table,
}: {
  id: string;
  title: string;
  first: string;
  table: UsageTable;
}) {
  const total = usageCells(table.total);
  return (
    <section className={s['block']} data-usage-block={id}>
      <Label as="h3" className={s['blockHead']} id={`usage-${id}-label`}>
        {title}
      </Label>
      {table.rows.length === 0 ? (
        <p className={s['empty']} data-usage-empty={id}>
          {copy.usage.empty}
        </p>
      ) : (
        <Table
          columns={TABLE_COLUMNS.usage}
          header={[first, c.sessions, c.turns, c.tokens, c.cost]}
          rowPad="12px 20px"
          aria-labelledby={`usage-${id}-label`}
          data-usage-table={id}
        >
          {table.rows.map((row) => {
            const cells = usageCells(row);
            return (
              <TableRow key={row.key} data-usage-row={row.key}>
                <TableCell strong>{row.label}</TableCell>
                <TableCell mono className={s['num']}>
                  {cells.sessions}
                </TableCell>
                <TableCell mono className={s['num']}>
                  {cells.turns}
                </TableCell>
                <TableCell mono className={s['num']}>
                  {cells.tokens}
                </TableCell>
                <TableCell mono className={s['num']}>
                  {cells.cost}
                </TableCell>
              </TableRow>
            );
          })}
          <TableRow data-usage-total={id}>
            <TableCell strong>{table.total.label}</TableCell>
            <TableCell mono strong className={s['num']}>
              {total.sessions}
            </TableCell>
            <TableCell mono strong className={s['num']}>
              {total.turns}
            </TableCell>
            <TableCell mono strong className={s['num']}>
              {total.tokens}
            </TableCell>
            <TableCell mono strong className={s['num']}>
              {total.cost}
            </TableCell>
          </TableRow>
        </Table>
      )}
    </section>
  );
}

/** One agent's report: plan, each window as "5 h · 42% used · resets in 2h 10m" over a small bar, and the report's age. */
function LimitRowView({ row }: { row: LimitRow }) {
  return (
    <TableRow data-usage-limit={row.agent}>
      <TableCell strong>{row.label}</TableCell>
      <TableCell mono muted>
        {row.plan ?? copy.general.none}
      </TableCell>
      <TableCell className={s['windows']}>
        {row.windows.map((w) => (
          <span key={w.label} className={s['window']} data-usage-window={w.label}>
            <span className={s['bar']} aria-hidden="true">
              <span className={s['fill']} style={{ width: `${w.usedPercent}%` }} data-usage-fill="true" />
            </span>
            <span className={s['windowText']}>{w.resets === null ? w.used : `${w.used} · ${w.resets}`}</span>
          </span>
        ))}
      </TableCell>
      <TableCell mono muted>
        {row.reported}
      </TableCell>
    </TableRow>
  );
}

/**
 * Usage (owner request after t3code): tokens, cost, turns and sessions summed across every agent and project
 * from the sessions Styx ran, plus each CLI's own account limits with a Refresh (Codex on demand; Claude Code
 * reports while its sessions run).
 */
export function Usage() {
  const now = useNow();
  const byAgent = useModel(selectByAgent);
  const byProject = useModel(selectByProject);
  const limits = useModel(useCallback((m: ReadModel) => limitRows(m, now), [now]));
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await command('usage.refreshLimits', {});
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={s['screen']} data-usage="true">
      <header className={s['header']}>
        <h2 className={s['title']}>{copy.usage.title}</h2>
      </header>
      <p className={s['lead']}>{copy.usage.lead}</p>

      <UsageBlock id="agent" title={copy.usage.byAgent} first={c.agent} table={byAgent} />
      <UsageBlock id="project" title={copy.usage.byProject} first={c.project} table={byProject} />

      <section className={s['block']} data-usage-block="limits">
        <div className={s['limitsHead']}>
          <Label as="h3" className={s['blockHead']} id="usage-limits-label">
            {copy.usage.limits}
          </Label>
          <Button
            size="compact"
            onClick={() => void refresh()}
            aria-busy={refreshing || undefined}
            aria-disabled={refreshing || undefined}
            data-usage-refresh="true"
          >
            {refreshing ? copy.usage.refreshing : copy.usage.refresh}
          </Button>
        </div>
        <p className={s['lead']}>
          {copy.usage.limitsLead} {copy.usage.refreshNote}
        </p>
        {limits.length === 0 ? (
          <p className={s['empty']} data-usage-empty="limits">
            {copy.usage.noLimits}
          </p>
        ) : (
          <Table
            columns={TABLE_COLUMNS.usageLimits}
            header={[c.agent, c.plan, c.windows, c.reported]}
            rowPad="12px 20px"
            aria-labelledby="usage-limits-label"
            data-usage-table="limits"
          >
            {limits.map((row) => (
              <LimitRowView key={row.agent} row={row} />
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
