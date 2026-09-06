import { copy, fill } from '@styx/core';
import { Button, Checkbox, Modal, Table, TableCell, TableRow, TABLE_COLUMNS } from '@styx/ui';
import { useEffect, useState } from 'react';
import { command } from '../../state/commands';
import { useNow, useUi } from '../../state/hooks';
import { enterProject, openFolderAsProject } from '../../state/project-entry';
import s from './AddExistingModal.module.css';
import { rowMeta, type RepoRow } from './scanned-repos';

export interface AddExistingModalProps {
  id: string;
}

/**
 * "Add existing projects" (owner addition, docs/handoff-discrepancies #53): the onboarding step-2 list — editor
 * recents plus repos found on this machine, known projects hidden — with checkboxes, reachable any time from the
 * rail "+", Home and the palette. Scans on open; `Add n` runs `project.add` per checked row and lands in the
 * Workspace when exactly one project was added.
 */
export function AddExistingModal({ id }: AddExistingModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const screen = useUi((u) => u.screen);
  const now = useNow();
  /** Scan result for `scanKey`; a stale key means a rescan is in flight. */
  const [result, setResult] = useState<{ key: number; repos: RepoRow[]; error: string | null } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [scanKey, setScanKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void command('project.scan', { includeIdeRecents: true }).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setResult({ key: scanKey, repos: [], error: fill(copy.addExisting.failed, { message: r.error.message }) });
        return;
      }
      setResult({ key: scanKey, repos: r.value.repos, error: null });
      setChecked(new Set(r.value.repos.filter((x) => x.suggested).map((x) => x.path)));
    });
    return () => {
      cancelled = true;
    };
  }, [scanKey]);

  const scanning = result === null || result.key !== scanKey;
  const repos: RepoRow[] | null = scanning ? null : result.repos;
  const error = scanning ? null : result.error;

  const close = () => popOverlay(id);
  const toggle = (path: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const add = async () => {
    if (busy || checked.size === 0) return;
    setBusy(true);
    const added: string[] = [];
    try {
      for (const repo of repos ?? []) {
        if (!checked.has(repo.path)) continue;
        const r = await command('project.add', { path: repo.path });
        if (r.ok && r.value.projectId !== null) added.push(r.value.projectId);
      }
    } finally {
      setBusy(false);
    }
    close();
    const only = added.length === 1 ? added[0] : undefined;
    if (only !== undefined && screen !== 'onboarding') enterProject(only);
  };
  const openFolder = async () => {
    close();
    await openFolderAsProject();
  };

  const n = checked.size;
  const empty = repos !== null && repos.length === 0 && error === null;

  return (
    <Modal
      width={600}
      top={70}
      title={copy.addExisting.title}
      onClose={close}
      initialFocus="first"
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={() => void openFolder()}>
            {copy.addExisting.openFolder}
          </Button>
          <Button size="footer" variant="ghost" onClick={close}>
            {copy.general.cancel}
          </Button>
          <Button size="footer" variant="primary" disabled={busy || n === 0} onClick={() => void add()}>
            {n === 0 ? copy.addExisting.addNone : fill(copy.addExisting.add, { n: String(n) })}
          </Button>
        </>
      }
    >
      <div className={s['root']} data-add-existing-modal="true">
        <p className={s['lead']}>{copy.addExisting.lead}</p>
        {scanning ? (
          <div className={s['note']} role="status">
            {copy.addExisting.scanning}
          </div>
        ) : null}
        {error !== null ? (
          <div className={s['noteRow']}>
            <span className={s['note']} role="status">
              {error}
            </span>
            <Button onClick={() => setScanKey((k) => k + 1)}>{copy.addExisting.rescan}</Button>
          </div>
        ) : null}
        {empty ? (
          <div className={s['noteRow']}>
            <span className={s['note']} role="status">
              {copy.addExisting.empty}
            </span>
            <Button onClick={() => setScanKey((k) => k + 1)}>{copy.addExisting.rescan}</Button>
          </div>
        ) : null}
        {repos !== null && repos.length > 0 ? (
          <div className={s['tableFrame']}>
            <Table
              columns={TABLE_COLUMNS.onboardingRepos}
              rowPad="10px 14px"
              gap="14px"
              aria-label={copy.addExisting.title}
            >
              {repos.map((r) => (
                <TableRow key={r.path} data-repo-path={r.path}>
                  <TableCell>
                    <Checkbox
                      tone="accent"
                      checked={checked.has(r.path)}
                      aria-label={r.path}
                      onChange={(v) => toggle(r.path, v)}
                    />
                  </TableCell>
                  <TableCell className={s['monoCell']}>{r.path}</TableCell>
                  <TableCell muted className={s['monoCell']}>
                    {rowMeta(r, now)}
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
