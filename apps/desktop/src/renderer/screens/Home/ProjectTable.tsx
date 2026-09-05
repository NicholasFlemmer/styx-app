import { copy, type HomeProjectRow, type ProjectId } from '@styx/core';
import { StatusDot, TABLE_COLUMNS, Table, TableCell, TableRow } from '@styx/ui';
import s from './Home.module.css';

const HEADER = [
  copy.home.columns.project,
  copy.home.columns.path,
  copy.home.columns.branch,
  copy.home.columns.agents,
  copy.home.columns.targets,
  copy.home.columns.last,
];

export interface ProjectTableProps {
  rows: readonly HomeProjectRow[];
  onOpen: (projectId: ProjectId) => void;
}

/** Home project table (spec §4.2): header always; rows `14px 20px` at 13px (agents/targets 12px), hover `--s2`, click opens Workspace. */
export function ProjectTable({ rows, onOpen }: ProjectTableProps) {
  return (
    <Table
      columns={TABLE_COLUMNS.home}
      fontSize="13px"
      header={HEADER}
      className={s['table']}
      aria-label={copy.counters.projects}
    >
      {rows.map((p) => (
        <TableRow key={p.projectId} onActivate={() => onOpen(p.projectId)} data-project-id={p.projectId}>
          <TableCell strong className={s['name']}>
            <StatusDot tone="hollow" on={p.needs} {...(p.needs ? { label: copy.counters.needsYou } : {})} />
            {p.name}
          </TableCell>
          <TableCell mono muted>
            {p.path}
          </TableCell>
          <TableCell mono>{p.branch}</TableCell>
          <TableCell small>{p.agents}</TableCell>
          <TableCell muted small>
            {p.targets}
          </TableCell>
          <TableCell mono muted>
            {p.last}
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}
