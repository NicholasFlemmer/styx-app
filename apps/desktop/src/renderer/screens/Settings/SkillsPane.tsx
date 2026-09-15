import {
  copy,
  fill,
  INSTALLABLE_SKILL_HOSTS,
  type ProjectId,
  type SkillHost,
  type SkillSummary,
} from '@styx/core';
import {
  Banner,
  ChipGroup,
  EmptyState,
  Input,
  Label,
  Table,
  TableCell,
  TableRow,
  TABLE_COLUMNS,
  Tag,
} from '@styx/ui';
import { useEffect, useId, useState } from 'react';
import { useSkillsStore } from '../../features/skills/skills-store';
import { command } from '../../state/commands';
import { useUi } from '../../state/hooks';
import s from './SkillsPane.module.css';

type InstallHost = Exclude<SkillHost, 'agents'>;
export type HostFilter = 'all' | InstallHost;

/** One installed row per skill and scope; a skill installed for several agents lists each as a tag. */
export interface InstalledRow {
  key: string;
  name: string;
  directory: string;
  description: string;
  scope: 'global' | 'project';
  hosts: SkillHost[];
}

type Catalogue =
  | { state: 'loading' }
  | { state: 'ready'; skills: readonly SkillSummary[] }
  | { state: 'failed'; message: string };

const HOST_FILTERS: readonly HostFilter[] = ['all', ...INSTALLABLE_SKILL_HOSTS];
const isHostFilter = (v: string): v is HostFilter => (HOST_FILTERS as readonly string[]).includes(v);

export const groupInstalled = (skills: readonly SkillSummary[]): InstalledRow[] => {
  const rows = new Map<string, InstalledRow>();
  for (const skill of skills) {
    if (skill.scope === 'catalogue' || skill.host === null) continue;
    const key = `${skill.scope}:${skill.directory}`;
    const row = rows.get(key);
    if (row === undefined) {
      rows.set(key, {
        key,
        name: skill.name,
        directory: skill.directory,
        description: skill.description,
        scope: skill.scope,
        hosts: [skill.host],
      });
    } else if (!row.hosts.includes(skill.host)) row.hosts.push(skill.host);
  }
  return [...rows.values()];
};

/** Case-insensitive match on name or description; an empty query matches everything. */
export const matchesQuery = (skill: { name: string; description: string }, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === '' || skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q);
};

/** Shared `.agents` skills are read by Codex, Gemini CLI and Cursor, so they show under each of those filters. */
export const matchesHost = (row: InstalledRow, host: HostFilter): boolean =>
  host === 'all' || row.hosts.includes(host) || (row.hosts.includes('agents') && host !== 'claude');

function HostTag({ host }: { host: SkillHost }) {
  return host === 'agents' ? (
    <Tag tone="neutral" title={copy.skills.sharedHint}>
      {copy.skills.hostsShort.agents}
    </Tag>
  ) : (
    <Tag tone="neutral">{copy.skills.hostsShort[host]}</Tag>
  );
}

/** Skill cell: the name with its description underneath, one line, ellipsised. */
function SkillCell({ name, description }: { name: string; description: string }) {
  return (
    <TableCell>
      <span className={s['who']}>
        <span className={s['name']}>{name}</span>
        <span className={s['desc']} title={description}>
          {description}
        </span>
      </span>
    </TableCell>
  );
}

const HEADER = [copy.skills.columns.skill, copy.skills.columns.for, copy.skills.columns.where, ''];
const ROW_PAD = '12px 20px';

/**
 * Settings › App › Skills (owner addition). Installed skills across every agent CLI's own dir plus the shared
 * `.agents` dir, searchable and filterable by agent; the pinned catalogue underneath, read-first: Read opens the
 * SkillDrawer, and only there can a skill be installed.
 */
export function SkillsPane({ projectId }: { projectId: ProjectId | null }) {
  const version = useSkillsStore((st) => st.version);
  const bump = useSkillsStore((st) => st.bump);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [installed, setInstalled] = useState<readonly SkillSummary[] | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue>({ state: 'loading' });
  const [query, setQuery] = useState('');
  const [host, setHost] = useState<HostFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const installedId = useId();
  const catalogueId = useId();

  // Installed: refetched for a new project and whenever the skills store moves (drawer installs, pane removes).
  useEffect(() => {
    let live = true;
    void command('skills.list', { projectId }).then((r) => {
      if (live && r.ok) setInstalled(r.value.skills);
    });
    return () => {
      live = false;
    };
  }, [projectId, version]);

  // Catalogue: loads on mount; Retry flips it back to loading and bumps `attempt`, which re-runs the fetch.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void command('skills.catalogue', {}).then((r) => {
      if (!live) return;
      setCatalogue(
        r.ok ? { state: 'ready', skills: r.value.skills } : { state: 'failed', message: r.error.message },
      );
    });
    return () => {
      live = false;
    };
  }, [attempt]);
  const retryCatalogue = () => {
    setCatalogue({ state: 'loading' });
    setAttempt((n) => n + 1);
  };

  const remove = async (row: InstalledRow) => {
    setError(null);
    for (const h of row.hosts) {
      const r = await command('skills.remove', {
        directory: row.directory,
        scope: row.scope,
        host: h,
        projectId: row.scope === 'project' ? projectId : null,
      });
      if (!r.ok) {
        setError(r.error.message);
        bump();
        return;
      }
    }
    bump();
    pushOverlay({
      kind: 'toast',
      toast: {
        kind: 'info',
        heading: copy.skills.title,
        title: fill(copy.skills.removedToast, { name: row.name }),
      },
    });
  };

  const read = (directory: string) => pushOverlay({ kind: 'drawer', drawer: 'skill', directory });

  const installedRows = installed === null ? null : groupInstalled(installed);
  const visibleRows =
    installedRows?.filter((row) => matchesQuery(row, query) && matchesHost(row, host)) ?? [];
  const installedHostsOf = (directory: string): SkillHost[] =>
    [...new Set((installed ?? []).filter((i) => i.directory === directory).map((i) => i.host))].filter(
      (h): h is SkillHost => h !== null,
    );
  const noMatchLabel =
    query.trim() !== '' ? query.trim() : host === 'all' ? '' : copy.skills.hostsShort[host];
  const catalogueRows =
    catalogue.state === 'ready' ? catalogue.skills.filter((sk) => matchesQuery(sk, query)) : [];

  return (
    <div className={s['pane']} data-skills-pane="true">
      <p className={s['lead']}>{copy.skills.lead}</p>
      <div className={s['controls']}>
        <Input
          className={s['search'] ?? ''}
          aria-label={copy.skills.search}
          placeholder={copy.skills.search}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          data-skills-search="true"
        />
        <ChipGroup
          layout="inline"
          size="env"
          aria-label={copy.skills.filterLabel}
          options={HOST_FILTERS.map((h) => ({
            value: h,
            label: h === 'all' ? copy.skills.filterAll : copy.skills.hostsShort[h],
          }))}
          value={host}
          onChange={(v) => setHost(isHostFilter(v) ? v : 'all')}
          data-skills-host-filter="true"
        />
      </div>
      {error !== null && (
        <Banner className={s['banner']} tone="error" text={error} onDismiss={() => setError(null)} />
      )}

      <section className={s['section']} aria-labelledby={installedId}>
        <Label as="h3" id={installedId} className={s['sectionHead']}>
          {copy.skills.installed}
        </Label>
        {installedRows === null ? null : installedRows.length === 0 ? (
          <EmptyState headline={copy.skills.empty} body={copy.skills.emptyBody} data-skills-empty="true" />
        ) : visibleRows.length === 0 ? (
          <p className={s['note']} data-skills-nomatch="true">
            {fill(copy.skills.noMatch, { query: noMatchLabel })}
          </p>
        ) : (
          <Table
            columns={TABLE_COLUMNS.skills}
            header={HEADER}
            rowPad={ROW_PAD}
            aria-labelledby={installedId}
            data-skills-installed="true"
          >
            {visibleRows.map((row) => (
              <TableRow key={row.key} data-skill={row.directory} data-skill-scope={row.scope}>
                <SkillCell name={row.name} description={row.description} />
                <TableCell className={s['tags']}>
                  {row.hosts.map((h) => (
                    <HostTag key={h} host={h} />
                  ))}
                </TableCell>
                <TableCell mono muted>
                  {copy.skills.scopes[row.scope]}
                </TableCell>
                <TableCell label muted align="end" className={s['actions']}>
                  <button
                    type="button"
                    className={s['action']}
                    aria-label={`${copy.skills.remove} · ${row.name}`}
                    onClick={() => void remove(row)}
                  >
                    {copy.skills.remove}
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      <section className={s['section']} aria-labelledby={catalogueId}>
        <Label as="h3" id={catalogueId} className={s['sectionHead']}>
          {copy.skills.scopes.catalogue}
        </Label>
        {catalogue.state === 'failed' && (
          <Banner
            className={s['banner']}
            tone="error"
            text={catalogue.message}
            action={{ label: copy.skills.retry, onClick: retryCatalogue }}
            data-skills-catalogue-error="true"
          />
        )}
        {catalogue.state === 'ready' && catalogue.skills.length === 0 ? (
          <p className={s['note']}>{copy.skills.catalogueEmpty}</p>
        ) : catalogue.state === 'ready' && catalogueRows.length === 0 ? (
          <p className={s['note']} data-skills-nomatch="true">
            {fill(copy.skills.noMatch, { query: query.trim() })}
          </p>
        ) : catalogue.state === 'failed' ? null : (
          <Table
            columns={TABLE_COLUMNS.skills}
            header={HEADER}
            rowPad={ROW_PAD}
            aria-labelledby={catalogueId}
            aria-busy={catalogue.state === 'loading' ? true : undefined}
            data-skills-catalogue="true"
          >
            {catalogue.state === 'loading' ? (
              <TableRow>
                <TableCell label muted className={s['loadingRow']}>
                  {copy.skills.loading}
                </TableCell>
              </TableRow>
            ) : (
              catalogueRows.map((skill) => (
                <TableRow key={skill.directory} data-catalogue-skill={skill.directory}>
                  <SkillCell name={skill.name} description={skill.description} />
                  <TableCell className={s['tags']}>
                    {installedHostsOf(skill.directory).map((h) => (
                      <Tag
                        key={h}
                        tone="strong"
                        title={h === 'agents' ? copy.skills.sharedHint : copy.skills.hosts[h]}
                        data-skill-installed={h}
                      >
                        {copy.skills.installedTag} · {copy.skills.hostsShort[h]}
                      </Tag>
                    ))}
                  </TableCell>
                  <TableCell />
                  <TableCell label muted align="end" className={s['actions']}>
                    <button
                      type="button"
                      className={s['action']}
                      aria-label={`${copy.skills.read} · ${skill.name}`}
                      onClick={() => read(skill.directory)}
                    >
                      {copy.skills.read}
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </Table>
        )}
      </section>
    </div>
  );
}
