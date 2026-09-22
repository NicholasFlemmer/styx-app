import { test, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSim } from './harness';

/**
 * User simulation · the Repo screen: lanes / worktrees, Connect to GitHub, Publish (commit · push · PR), Land /
 * Undo, keeping lanes current with the base, merge conflicts, lane awareness (handoff §4.4; ADR-0003, -0021,
 * -0023, -0025; discrepancy rows 90, 96, 99–104, 107). Git is real: every step is checked against the repo the
 * app materialised under userData, and `origin` is a bare repo under a temp dir that the sim moves by hand.
 */

const GIT_ID = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Sim', '-c', 'user.email=sim@localhost'];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...GIT_ID, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const tryGit = (cwd: string, ...args: string[]): string => {
  try {
    return git(cwd, ...args);
  } catch (e) {
    return `ERR ${(e as Error).message.split('\n')[0]}`;
  }
};
const mergeInProgress = (cwd: string): boolean =>
  existsSync(join(git(cwd, 'rev-parse', '--git-dir'), 'MERGE_HEAD'));

interface Snap {
  projects: { id: string; name: string; path: string }[];
  worktrees: {
    id: string;
    projectId: string;
    branch: string | null;
    path: string;
    isMain: boolean;
    archivedAt: number | null;
    behindBase: number;
    conflict: { file: string; against: string } | null;
    changes: { added: number; removed: number; files: number };
    pr: { number: number; state: string; url: string } | null;
    mergedAt: number | null;
    landing: { commit: string; undoneAt: number | null; pushed: boolean } | null;
    resolution: { state: string; sessionId: string | null; failure: string | null } | null;
    overlaps: { worktreeId: string; files: string[] }[];
    owner: { kind: string; sessionId?: string };
  }[];
  sessions: {
    id: string;
    agent: string;
    state: string;
    pausedReason: string | null;
    worktreeId: string;
    projectId: string;
    archivedAt: number | null;
  }[];
  repos: {
    id: string;
    projectId: string;
    remotes: { name: string; url: string }[];
    ahead: number;
    behind: number;
  }[];
  transcripts: Record<string, { body: string; payload: { kind: string } }[]>;
  activity: { who: string; what: string }[];
  pendingAsks: {
    id: string;
    sessionId: string;
    kind: string;
    state: string;
    payload: { kind: string; options?: string[] };
  }[];
  auditEntries: { action: string; triggeredBy: string | null; detail: Record<string, unknown> }[];
  settings: { project: Record<string, Record<string, { value: unknown }>> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
  every = 300,
): Promise<T> {
  const t0 = Date.now();
  let last: unknown = null;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out after ${ms} ms${last instanceof Error ? `: ${last.message}` : ''}`);
}
const text = async (l: Locator): Promise<string> => (await l.innerText()).replace(/\s+/g, ' ').trim();

test('sim: repo-publish', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'styx-sim-repo-'));
  await runSim('repo-publish', { screen: 'repo' }, async (sim) => {
    const page = () => sim.page;
    const snap = async (): Promise<Snap> => {
      const r = await sim.command<Snap>('store.snapshot', {});
      if (!r.ok || r.value === undefined)
        throw new Error(`store.snapshot failed: ${r.error?.message ?? '?'}`);
      return r.value;
    };
    const lane = (branch: string) => page().locator(`[data-lane="${branch}"]`);
    const dialog = () => page().getByRole('dialog');
    const toasts = async (): Promise<string> => {
      const t = page().locator('[data-toast]');
      const n = await t.count();
      const out: string[] = [];
      for (let i = 0; i < n; i += 1) out.push(await text(t.nth(i)));
      return out.join(' | ');
    };
    const wtOf = async (branch: string) => {
      const s = await snap();
      return s.worktrees.find((w) => w.branch === branch && w.archivedAt === null) ?? null;
    };
    const sessionOf = async (worktreeId: string) => {
      const s = await snap();
      return s.sessions.find((x) => x.worktreeId === worktreeId && x.archivedAt === null) ?? null;
    };
    const systemLines = async (sessionId: string): Promise<string[]> =>
      ((await snap()).transcripts[sessionId] ?? [])
        .filter((m) => m.payload.kind === 'system')
        .map((m) => m.body);
    const feed = async (): Promise<string[]> => (await snap()).activity.map((a) => `${a.who} · ${a.what}`);
    const ready = async (): Promise<void> => {
      await page().locator('[data-screen-ready="repo"]').waitFor({ state: 'attached', timeout: 20_000 });
      await page().locator('[data-repo]').waitFor({ timeout: 20_000 });
      const d = await sim.command<{ clis: { agent: string; binary: string | null }[] }>('detect.clis', {});
      const bins = d.value?.clis ?? [];
      for (const a of ['claude', 'codex']) {
        const b = bins.find((c) => c.agent === a)?.binary ?? '';
        if (!/e2e[/\\]fixtures[/\\]bin[/\\]/.test(b))
          throw new Error(`the fake ${a} is not the detected binary: ${b}`);
      }
    };

    // Bare remotes and a clone the sim uses to make `origin` move; never a real remote.
    const bare1 = join(tmp, 'origin-1.git');
    const bare2 = join(tmp, 'origin-2.git');
    execFileSync('git', ['init', '--bare', '-q', bare1]);
    execFileSync('git', ['init', '--bare', '-q', bare2]);
    let repo = '';
    let project = { id: '', name: '' };
    let claudeId = '';
    let codexId = '';

    // ------------------------------------------------------------------ 1. the lane table
    await sim.step('Repo opens with main and the three demo lanes', async () => {
      await ready();
      const s = await snap();
      const p = s.projects.find((x) => x.name === 'acme-shop');
      if (!p) throw new Error('acme-shop project missing');
      project = { id: p.id, name: p.name };
      repo = p.path;
      if (!existsSync(join(repo, '.git'))) throw new Error(`demo repo not materialised at ${repo}`);
      const rows: string[] = [];
      for (const b of ['main', 'fix/checkout', 'test/flaky', 'feat/promo']) {
        if ((await lane(b).count()) !== 1) throw new Error(`no row for ${b}`);
        rows.push(`${b}: ${await text(lane(b))}`);
      }
      const wt = await wtOf('fix/checkout');
      claudeId = (await sessionOf(wt?.id ?? ''))?.id ?? '';
      codexId = (await sessionOf((await wtOf('test/flaky'))?.id ?? ''))?.id ?? '';
      await sim.shot('lane-table');
      return rows.join(' || ');
    });

    await sim.step('the changes column agrees with git for each lane', async () => {
      const s = await snap();
      const off: string[] = [];
      for (const b of ['fix/checkout', 'test/flaky']) {
        const wt = s.worktrees.find((w) => w.branch === b);
        if (!wt) throw new Error(`no worktree row for ${b}`);
        // Files the lane changed against its base: committed, modified and untracked alike.
        const status = git(wt.path, 'status', '--porcelain')
          .split('\n')
          .filter((l) => l.trim() !== '');
        const numstat = git(wt.path, 'diff', '--numstat', 'main')
          .split('\n')
          .filter((l) => l.trim() !== '');
        let added = 0;
        let removed = 0;
        for (const l of numstat) {
          const [a, r] = l.split('\t');
          added += Number(a) || 0;
          removed += Number(r) || 0;
        }
        for (const l of status)
          if (l.startsWith('??')) {
            // untracked: every line counts as added
            const p = l.slice(3).trim();
            const wc = execFileSync('wc', ['-l', join(wt.path, p)], { encoding: 'utf8' })
              .trim()
              .split(' ')[0];
            added += Number(wc) || 0;
          }
        const row = await text(lane(b));
        const gitFiles = new Set([
          ...status.map((l) => l.slice(3).trim()),
          ...numstat.map((l) => l.split('\t')[2] ?? ''),
        ]);
        const cell = `+${wt.changes.added} −${wt.changes.removed} · ${wt.changes.files} files`;
        if (wt.changes.files !== gitFiles.size || Math.abs(wt.changes.added - added) > 2)
          off.push(`${b}: row "${row}" (store ${cell}) vs git ${gitFiles.size} files, +${added} −${removed}`);
      }
      if (off.length > 0) {
        sim.finding({
          severity: 'minor',
          title: 'the Changes column shows the fixture counters, not what git sees in the lane',
          repro:
            'open Repo on the demo project and compare a lane row with `git diff --numstat main` + `git status` in its worktree',
          expected:
            'the +added −removed · n files cell is measured from the worktree (Track agent edits is off by default, so nothing rescans the lane)',
          observed: off.join('; '),
          where:
            'apps/desktop/src/main/services/hunk-service.ts (enabled() gates the rescan) · seed-repos.ts re-points paths but leaves `changes`',
        });
        return `store vs git disagree: ${off.join('; ')}`;
      }
      return 'store counters match git';
    });

    await sim.step('verbs and PR cells read as the copy defines them', async () => {
      const want: Record<string, string[]> = {
        main: ['Commit & push', 'Open'],
        'fix/checkout': ['Commit & push', 'Land', 'Diff'],
        'test/flaky': ['Open PR', 'Land', 'Diff'],
        'feat/promo': ['Archive'],
      };
      const problems: string[] = [];
      for (const [b, verbs] of Object.entries(want)) {
        const row = lane(b);
        for (const v of verbs)
          if ((await row.getByRole('button', { name: v, exact: true }).count()) === 0)
            problems.push(`${b} lacks "${v}" (has: ${await text(row)})`);
      }
      const fix = await text(lane('fix/checkout'));
      if (!/#214 draft/.test(fix)) problems.push(`fix/checkout PR cell: ${fix}`);
      if (!/#212 ✓/.test(await text(lane('feat/promo')))) problems.push('feat/promo PR cell');
      if (!/merged yesterday/.test(await text(lane('feat/promo')))) problems.push('feat/promo changes cell');
      if (!/—/.test(await text(lane('test/flaky')))) problems.push('test/flaky PR cell');
      if (problems.length > 0) throw new Error(problems.join('; '));
      return 'fix/checkout: Commit & push (seeded PR #214 draft) — the brief expected Open PR; that is the fixture, not the app';
    });

    await sim.step('clicking a lane shows its diff below', async () => {
      await lane('test/flaky').click();
      const head = page().locator('[data-lane-diff-head]');
      await until(async () => /test\/flaky/.test(await text(head)));
      const diff = page().getByRole('region', { name: 'test/flaky' });
      await until(async () => /orders\.test\.ts|retry/.test(await text(diff)), 10_000);
      await sim.shot('lane-diff');
      return await text(head);
    });

    await sim.step('the header names the remote and the connect verb matches git', async () => {
      const remotes = tryGit(repo, 'remote');
      const header = await text(page().locator('[data-repo-remote]'));
      const connect = await page().locator('[data-repo-connect]').getAttribute('data-repo-connect');
      if (remotes === '' && !/Connect to GitHub/.test(await text(page().locator('[data-repo-connect]')))) {
        sim.finding({
          severity: 'major',
          title: 'Repo says the demo project is on github.com/acme/shop while its git has no remote',
          repro:
            'boot the demo fixture, open Repo: header + Connect/Reconnect button; then `git remote -v` in <userData>/demo-repos/acme-shop',
          expected:
            'a repo with no remote reads "— · main ↑0 ↓0" and offers Connect to GitHub; the Publish modal shows the no-remote notice',
          observed: `header "${header}", button data-repo-connect="${connect}", git remotes: (none)`,
          where:
            'seed-repos.ts re-points project/worktree rows but not repos.remotes; LaneSyncService.refresh writes only ahead/behind',
        });
        return `MISMATCH header "${header}" / ${connect} vs git remotes "(none)"`;
      }
      return `header "${header}", ${connect}, git remotes "${remotes || '(none)'}"`;
    });

    await sim.step('Fetch runs without a remote and leaves the header sane', async () => {
      await page().getByRole('button', { name: 'Fetch', exact: true }).click();
      await sleep(1500);
      const t = await toasts();
      if (/fail|error/i.test(t)) throw new Error(`toast after Fetch: ${t}`);
      return `header "${await text(page().locator('[data-repo-remote]'))}"${t ? ` · toast: ${t}` : ''}`;
    });

    await sim.step('+ Worktree adds a lane on disk and in the table', async () => {
      await page().getByRole('button', { name: '+ Worktree', exact: true }).click();
      const wt = await until(async () => await wtOf('wt-1'));
      await lane('wt-1').waitFor({ timeout: 10_000 });
      const list = git(repo, 'worktree', 'list', '--porcelain');
      if (!list.includes(wt.path)) throw new Error(`git worktree list lacks ${wt.path}`);
      if (!/refs\/heads\/wt-1/.test(list)) throw new Error('branch wt-1 not in worktree list');
      return `wt-1 at ${wt.path} · row: ${await text(lane('wt-1'))} (the brief expected agent/…; + Worktree makes wt-<n>, Spawn makes agent/<name>-<n>)`;
    });

    await sim.step('Archive on a merged lane removes the row and the folder', async () => {
      const wt = await wtOf('feat/promo');
      if (!wt) throw new Error('feat/promo missing');
      await lane('feat/promo').getByRole('button', { name: 'Archive', exact: true }).click();
      await until(async () => (await lane('feat/promo').count()) === 0);
      await until(async () => !existsSync(wt.path), 10_000);
      const list = git(repo, 'worktree', 'list', '--porcelain');
      if (list.includes(wt.path)) throw new Error('git worktree list still has the folder');
      return `folder gone; branch kept: ${tryGit(repo, 'rev-parse', '--verify', 'feat/promo').slice(0, 7)}`;
    });

    await sim.step('a lane whose folder was deleted by hand: how the row reads', async () => {
      const wt = await wtOf('wt-1');
      if (!wt) throw new Error('wt-1 missing');
      rmSync(wt.path, { recursive: true, force: true });
      await page().getByRole('button', { name: 'Fetch', exact: true }).click();
      await sleep(2000);
      const row = await text(lane('wt-1'));
      await lane('wt-1').click();
      await sleep(800);
      const head = await text(page().locator('[data-lane-diff-head]'));
      const t = await toasts();
      const prunable = /prunable/.test(git(repo, 'worktree', 'list', '--porcelain'));
      sim.finding({
        severity: 'minor',
        title: 'a lane whose folder is gone still reads like a healthy lane',
        repro: 'Repo › + Worktree, delete the new folder in Finder, click Fetch, then the row',
        expected:
          'the row says the folder is missing (git lists it as prunable) and offers to recreate or archive it',
        observed: `row "${row}", diff head "${head}", toast "${t}", git prunable: ${prunable}`,
        where:
          'LaneSyncService.refresh measures branches, never the folder; repo-data.ts has no missing state',
      });
      // Tidy: archive it so later refreshes do not trip on the missing folder.
      await sim.command('worktree.archive', { worktreeId: wt.id });
      return `row "${row}" · git prunable: ${prunable}`;
    });

    // ------------------------------------------------------------------ 2. no remote → Connect
    await sim.step('Publish on a lane with no remote: commit-only and a Connect offer', async () => {
      await lane('test/flaky').getByRole('button', { name: 'Open PR', exact: true }).click();
      await dialog().locator('[data-publish-modal]').waitFor({ timeout: 10_000 });
      const notice = dialog().locator('[data-publish-no-remote]');
      const hasNotice = (await notice.count()) === 1;
      const chips = dialog().locator('[data-publish-through] [role="radio"]');
      const states: string[] = [];
      for (let i = 0; i < (await chips.count()); i += 1)
        states.push(
          `${await text(chips.nth(i))}=${(await chips.nth(i).isDisabled()) ? 'off' : 'on'}/${await chips.nth(i).getAttribute('aria-checked')}`,
        );
      await sim.shot('publish-no-remote');
      if (!hasNotice) {
        // Try to push anyway, the way a person would, and see what the modal says.
        await until(
          async () =>
            (await dialog().locator('[data-publish-draft="done"], [data-publish-draft="failed"]').count()) >
            0,
          30_000,
        );
        await dialog().locator('[data-publish-through]').getByText('Commit & push', { exact: true }).click();
        const run = dialog().locator('[data-publish-run]');
        if (await run.isDisabled())
          await dialog().getByLabel('Commit message').fill('sim: try to push with no remote');
        await run.click();
        const failed = await until(async () => {
          const f = dialog().locator('[data-publish-step][data-state="failed"]');
          return (await f.count()) > 0 ? await text(f) : null;
        }, 30_000);
        await sim.shot('publish-no-remote-failed');
        await dialog().locator('[data-publish-close]').click();
        throw new Error(`no no-remote notice (chips ${states.join(', ')}); pushing failed with: ${failed}`);
      }
      return `notice: "${await text(notice)}" · chips ${states.join(', ')}`;
    });

    await sim.step('Connect (existing repo, a bare path) sets origin and brings Publish back', async () => {
      // The modal is open in either case; reach Connect from it when the notice is there, else from the header.
      const fromModal = (await dialog().locator('[data-publish-connect]').count()) === 1;
      if (fromModal) await dialog().locator('[data-publish-connect]').click();
      else {
        if ((await dialog().count()) > 0) await page().keyboard.press('Escape');
        await page().locator('[data-repo-connect]').click();
      }
      const form = page().locator('[data-connect-repo]');
      await form.waitFor({ timeout: 10_000 });
      const noGithub = await form.locator('[data-connect-repo-no-github]').count();
      const kind = await form.getAttribute('data-connect-repo-kind');
      await form
        .locator('[data-connect-repo-kinds]')
        .getByText('Use an existing repo', { exact: true })
        .click();
      await form.locator('[data-connect-repo-url]').fill(bare1);
      await sim.shot('connect-existing');
      await page().locator('[data-connect-repo-cta]').click();
      await until(async () => (await form.count()) === 0, 15_000);
      const origin = tryGit(repo, 'remote', 'get-url', 'origin');
      if (origin !== bare1)
        throw new Error(`origin is "${origin}", wanted ${bare1} · toast: ${await toasts()}`);
      const header = await until(async () => {
        const h = await text(page().locator('[data-repo-remote]'));
        return h.includes('origin-1') ? h : null; // the header drops `.git`
      }, 10_000);
      const connect = await page().locator('[data-repo-connect]').getAttribute('data-repo-connect');
      const back = fromModal ? (await dialog().locator('[data-publish-modal]').count()) === 1 : null;
      if (fromModal && !back) throw new Error('Publish did not come back after Connect');
      if ((await dialog().count()) > 0) await page().keyboard.press('Escape');
      return `origin=${origin} · header "${header}" · button ${connect} · default kind ${kind} (GitHub target ${noGithub ? 'not ' : ''}connected → hint ${noGithub ? 'shown' : 'hidden'}) · Publish returned: ${back}`;
    });

    await sim.step('Reconnect replaces origin with the second bare path', async () => {
      await page().locator('[data-repo-connect="reconnect"]').click();
      const form = page().locator('[data-connect-repo]');
      await form.waitFor({ timeout: 10_000 });
      const current = await text(form.locator('[data-connect-repo-current]'));
      if (!current.includes(bare1)) throw new Error(`current line "${current}" does not name ${bare1}`);
      await form
        .locator('[data-connect-repo-kinds]')
        .getByText('Use an existing repo', { exact: true })
        .click();
      await form.locator('[data-connect-repo-url]').fill(bare2);
      const cta = await text(page().locator('[data-connect-repo-cta]'));
      await page().locator('[data-connect-repo-cta]').click();
      await until(async () => (await form.count()) === 0, 15_000);
      const origin = tryGit(repo, 'remote', 'get-url', 'origin');
      if (origin !== bare2) throw new Error(`origin is "${origin}", wanted ${bare2}`);
      const rows = (await feed()).filter((w) => /connected/.test(w));
      return `cta "${cta}" · origin=${origin} · feed: ${rows.join(' | ') || '(no row)'}`;
    });
    const bare = bare2;

    // ------------------------------------------------------------------ 3. Publish
    await sim.step(
      'Publish fix/checkout through Open PR: drafted, editable, then commit · push · PR #7',
      async () => {
        const row = lane('fix/checkout');
        const verb = await text(row.locator('[data-action="publish"]'));
        await row.locator('[data-action="publish"]').click();
        const d = dialog();
        await d.locator('[data-publish-modal]').waitFor({ timeout: 10_000 });
        if (!/Publish · fix\/checkout/.test(await text(d)))
          throw new Error('title is not "Publish · fix/checkout"');
        const drafting = await d.locator('[data-publish-draft="running"]').count();
        await d
          .locator('[data-publish-through]')
          .getByText('Commit, push & open PR', { exact: true })
          .click();
        await until(async () => (await d.locator('[data-publish-draft="done"]').count()) === 1, 30_000);
        const msg = await d.getByLabel('Commit message').inputValue();
        if (!/Cover order retries/.test(msg)) throw new Error(`commit draft: ${JSON.stringify(msg)}`);
        if (!/checkout\.ts/.test(msg))
          throw new Error(`the draft does not name the changed files: ${JSON.stringify(msg)}`);
        await until(async () => (await d.locator('[data-publish-draft-pr="done"]').count()) === 1, 30_000);
        const title = await d.getByLabel('Pull request title').inputValue();
        const body = await d.getByLabel('Description').inputValue();
        if (title === '' || !/## Summary/.test(body))
          throw new Error(`PR draft title "${title}" body ${JSON.stringify(body.slice(0, 60))}`);
        // Editable: change the commit subject and see it land.
        await d
          .getByLabel('Commit message')
          .fill(`Validate the cart before paying\n\n${msg.split('\n').slice(2).join('\n')}`);
        await sim.shot('publish-edit');
        await d.locator('[data-publish-run]').click();
        const step = (n: string) => d.locator(`[data-publish-step="${n}"]`);
        for (const n of ['commit', 'push', 'pr']) {
          const state = await until(async () => {
            const s = await step(n).getAttribute('data-state');
            return s === 'done' || s === 'failed' ? s : null;
          }, 40_000);
          if (state !== 'done') throw new Error(`${n} step: ${await text(step(n))}`);
        }
        const lines = [await text(step('commit')), await text(step('push')), await text(step('pr'))];
        await sim.shot('publish-done');
        const openPr = await text(d.locator('[data-publish-open-pr]'));
        const wt = await wtOf('fix/checkout');
        const status = git(wt?.path ?? '', 'status', '--porcelain');
        const subject = tryGit(bare, 'log', '-1', '--format=%s', 'refs/heads/fix/checkout');
        await d.locator('[data-publish-close]').click();
        await until(async () => (await d.count()) === 0, 5000);
        const after = await text(row);
        if (status !== '') throw new Error(`lane not clean after commit: ${status}`);
        if (subject !== 'Validate the cart before paying')
          throw new Error(`bare fix/checkout subject "${subject}"`);
        if (!/#7 open/.test(after)) throw new Error(`row after publish: ${after}`);
        return `verb "${verb}" · drafting shown: ${drafting === 1} · ${lines.join(' / ')} · ${openPr} · row "${after}"`;
      },
    );

    await sim.step('Publish again with nothing to commit', async () => {
      const row = lane('fix/checkout');
      const verb = await text(row.locator('[data-action="publish"]'));
      await row.locator('[data-action="publish"]').click();
      const d = dialog();
      await d.locator('[data-publish-modal]').waitFor({ timeout: 10_000 });
      await until(
        async () =>
          (await d.locator('[data-publish-draft="done"], [data-publish-draft="failed"]').count()) === 1,
        30_000,
      );
      const draftState = await d.locator('[data-publish-draft]').getAttribute('data-publish-draft');
      const msg = await d.getByLabel('Commit message').inputValue();
      const hint = await text(d.locator('[data-publish-draft]'));
      const disabled = await d.locator('[data-publish-run]').isDisabled();
      if (disabled) {
        sim.finding({
          severity: 'minor',
          title:
            'a clean lane cannot be pushed until a commit message is typed for a commit that will not happen',
          repro: 'Repo › fix/checkout (clean, pushed) › Commit & push › Publish',
          expected: 'Publish is enabled: the commit step reports "Nothing to commit" and the push goes ahead',
          observed: `draft ${draftState}, message ${JSON.stringify(msg)}, hint "${hint}", Publish disabled`,
          where:
            'PublishModal.tsx canRun requires commitMessage.title; PublishService.generateMessage on a clean tree',
        });
        await d.getByLabel('Commit message').fill('sim: nothing to commit');
      }
      await d.locator('[data-publish-run]').click();
      await until(
        async () =>
          (await d
            .locator(
              '[data-publish-step="push"][data-state="done"], [data-publish-step][data-state="failed"]',
            )
            .count()) > 0,
        30_000,
      );
      const commit = await text(d.locator('[data-publish-step="commit"]'));
      const push = await text(d.locator('[data-publish-step="push"]'));
      await d.locator('[data-publish-close]').click();
      if (!/Nothing to commit/.test(commit)) throw new Error(`commit line: ${commit}`);
      if (!/Pushed fix\/checkout/.test(push)) throw new Error(`push line: ${push}`);
      return `verb "${verb}" · draft ${draftState} "${msg.slice(0, 40)}" · ${commit} / ${push}`;
    });

    await sim.step('Commit only: the lane commits, the bare stays behind', async () => {
      const wt = await wtOf('fix/checkout');
      if (!wt) throw new Error('fix/checkout missing');
      writeFileSync(join(wt.path, 'NOTES.md'), '# notes\n\nwritten by the sim\n');
      await lane('fix/checkout').locator('[data-action="publish"]').click();
      const d = dialog();
      await d.locator('[data-publish-modal]').waitFor({ timeout: 10_000 });
      await d.locator('[data-publish-through]').getByText('Commit only', { exact: true }).click();
      await until(
        async () =>
          (await d.locator('[data-publish-draft="done"], [data-publish-draft="failed"]').count()) === 1,
        30_000,
      );
      const msg = await d.getByLabel('Commit message').inputValue();
      if (msg.trim() === '') await d.getByLabel('Commit message').fill('Add notes');
      await d.locator('[data-publish-run]').click();
      await until(
        async () =>
          (await d
            .locator(
              '[data-publish-step="commit"][data-state="done"], [data-publish-step][data-state="failed"]',
            )
            .count()) > 0,
        30_000,
      );
      const commit = await text(d.locator('[data-publish-step="commit"]'));
      const pushCount = await d.locator('[data-publish-step="push"]').count();
      await d.locator('[data-publish-close]').click();
      const local = git(wt.path, 'rev-parse', 'HEAD');
      // the bare may not have the branch at all yet (an earlier push failed): that is "behind" too
      const remote = tryGit(bare, 'rev-parse', 'refs/heads/fix/checkout') ?? '(no branch)';
      if (local === remote) throw new Error('the bare moved on a commit-only publish');
      if (git(wt.path, 'status', '--porcelain') !== '') throw new Error('NOTES.md not committed');
      const named = git(wt.path, 'log', '-1', '--format=%s');
      return `${commit} · push line shown: ${pushCount === 1} · lane HEAD ${local.slice(0, 7)} vs bare ${remote.slice(0, 7)} · subject "${named}" · draft ${JSON.stringify(msg.split('\n')[0])}`;
    });

    await sim.step('Home feed has a row per Publish step', async () => {
      const rows = (await feed()).filter((w) => /published fix\/checkout/.test(w));
      const want = [/\(commit [0-9a-f]{7}\)$/, /\(push\)$/, /\(PR #7\)$/];
      const missing = want.filter((re) => !rows.some((w) => re.test(w)));
      if (missing.length > 0)
        throw new Error(`feed rows: ${rows.join(' | ')}; missing ${missing.map(String).join(', ')}`);
      return `${rows.length} rows: ${rows.join(' | ')}`;
    });

    await sim.step('Publish on main: push only, PR chip off', async () => {
      await lane('main').locator('[data-action="publish"]').click();
      const d = dialog();
      await d.locator('[data-publish-modal]').waitFor({ timeout: 10_000 });
      const pr = d
        .locator('[data-publish-through] [role="radio"]')
        .filter({ hasText: 'Commit, push & open PR' });
      const prOff = await pr.isDisabled();
      const checked = await d
        .locator('[data-publish-through] [role="radio"][aria-checked="true"]')
        .innerText();
      await until(
        async () =>
          (await d.locator('[data-publish-draft="done"], [data-publish-draft="failed"]').count()) === 1,
        30_000,
      );
      if ((await d.getByLabel('Commit message').inputValue()).trim() === '')
        await d.getByLabel('Commit message').fill('sim: push main');
      await d.locator('[data-publish-run]').click();
      await until(
        async () =>
          (await d
            .locator(
              '[data-publish-step="push"][data-state="done"], [data-publish-step][data-state="failed"]',
            )
            .count()) > 0,
        30_000,
      );
      const lines = [
        await text(d.locator('[data-publish-step="commit"]')),
        await text(d.locator('[data-publish-step="push"]')),
      ];
      const prStep = await d.locator('[data-publish-step="pr"]').count();
      await d.locator('[data-publish-close]').click();
      const bareMain = tryGit(bare, 'rev-parse', 'refs/heads/main');
      const localMain = git(repo, 'rev-parse', 'main');
      const upstream = tryGit(repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}');
      if (bareMain !== localMain)
        throw new Error(
          `bare main ${bareMain.slice(0, 7)} vs local ${localMain.slice(0, 7)}: ${lines.join(' / ')}`,
        );
      if (!prOff) throw new Error('the PR chip is enabled for main');
      return `default chip "${checked.trim()}" · ${lines.join(' / ')} · PR step shown: ${prStep === 1} · upstream ${upstream}`;
    });

    await sim.step('Escape closes the Publish modal and returns focus to its verb', async () => {
      await lane('fix/checkout').locator('[data-action="publish"]').click();
      await dialog().locator('[data-publish-modal]').waitFor({ timeout: 10_000 });
      await page().keyboard.press('Escape');
      await until(async () => (await dialog().count()) === 0, 5000);
      const focused = await page().evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a
          ? `${a.tagName.toLowerCase()}[data-action=${a.getAttribute('data-action')}] "${a.textContent?.trim()}"`
          : 'none';
      });
      if (!/data-action=publish/.test(focused))
        sim.finding({
          severity: 'polish',
          title: 'Escape on the Publish modal does not hand focus back to the verb that opened it',
          repro: 'Repo › Commit & push › Escape',
          expected: "focus returns to the lane's publish verb (README: Escape returns focus to its invoker)",
          observed: `active element: ${focused}`,
          where: 'ui-store pushOverlay/popOverlay invoker handling for the Repo lane buttons',
        });
      return `focus after Escape: ${focused}`;
    });

    // ------------------------------------------------------------------ 4. Land / Undo
    const spawnCodex = async (
      branch: string,
      firstMessage: string,
    ): Promise<{ sessionId: string; worktreeId: string }> => {
      const r = await sim.command<{ sessionId: string; worktreeId: string }>('session.spawn', {
        projectId: project.id,
        agent: 'codex',
        worktree: { kind: 'new', base: 'main', branch },
        firstMessage,
        toggles: { autoApproveEdits: false, mayRequestTargets: true, notifyWhenNeedsMe: true },
      });
      if (!r.ok || !r.value) throw new Error(`spawn failed: ${r.error?.message ?? '?'}`);
      const { sessionId, worktreeId } = r.value;
      const ask = await until(
        async () =>
          (await snap()).pendingAsks.find(
            (a) => a.sessionId === sessionId && a.state === 'open' && a.kind === 'decision',
          ) ?? null,
        30_000,
      );
      const allow =
        (ask.payload.options ?? []).find((o) => /^allow/i.test(o)) ?? ask.payload.options?.[0] ?? 'Allow';
      const a = await sim.command('ask.respond', {
        askId: ask.id,
        resolution: { kind: 'decision', chosen: allow },
      });
      if (!a.ok) throw new Error(`ask.respond failed: ${a.error?.message}`);
      await until(
        async () => ((await snap()).sessions.find((s) => s.id === sessionId)?.state ?? '') === 'idle',
        30_000,
      );
      return { sessionId, worktreeId };
    };
    /**
     * A landed lane with nothing new is tidied away once main moves on (its folder goes with it). The later steps
     * need a live codex lane with work of its own: the landed one while it is still there, else a fresh spawn.
     */
    let landedLane = { sessionId: '', worktreeId: '', path: '' };
    let liveLaneN = 4;
    const liveCodexLane = async (): Promise<{ sessionId: string; worktreeId: string; path: string }> => {
      if (landedLane.path !== '' && existsSync(landedLane.path)) return landedLane;
      const branch = `agent/codex-${liveLaneN}`;
      liveLaneN += 1;
      const { sessionId, worktreeId } = await spawnCodex(branch, `write ${branch.replace('/', '-')}.txt`);
      const wt = (await snap()).worktrees.find((w) => w.id === worktreeId);
      if (!wt) throw new Error('lane row missing after spawn');
      landedLane = { sessionId, worktreeId, path: wt.path };
      return landedLane;
    };

    await sim.step('Land on test/flaky while its agent is waiting on you', async () => {
      await page()
        .locator('[data-nav-item="repo"]')
        .click()
        .catch(() => undefined);
      const before = (await snap()).sessions.find((s) => s.id === codexId)?.state;
      await lane('test/flaky').locator('[data-action="land"]').click();
      const d = dialog();
      await d.locator('[data-land-modal]').waitFor({ timeout: 10_000 });
      await until(async () => (await d.locator('[data-land-preview="ready"]').count()) === 1, 20_000);
      const facts = await text(d.locator('[data-land-preview]'));
      await until(
        async () => (await d.locator('[data-land-draft="done"], [data-land-draft="failed"]').count()) === 1,
        30_000,
      );
      if ((await d.getByLabel('Summary').inputValue()).trim() === '')
        await d.getByLabel('Summary').fill('sim: land flaky');
      const mainBefore = git(repo, 'rev-parse', 'main');
      await d.locator('[data-land-run]').click();
      const outcome = await until(async () => {
        const s = d.locator('[data-land-step][data-state="failed"], [data-land-close]');
        return (await s.count()) > 0 ? await text(d.locator('[data-land-steps]')) : null;
      }, 40_000);
      await sim.shot('land-flaky');
      await d.locator('[data-land-close]').click();
      const moved = git(repo, 'rev-parse', 'main') !== mainBefore;
      if (moved) return `landed although the session was ${before}: ${outcome}`;
      if (!/waiting on you/.test(outcome)) {
        if (!/mid-turn/.test(outcome)) throw new Error(`unexpected refusal: ${outcome}`);
        sim.finding({
          severity: 'polish',
          title: 'Land calls an agent that is waiting on a grant "mid-turn"',
          repro: 'Repo › test/flaky (Codex asking for Supabase) › Land › Land',
          expected:
            'the refusal says the agent is waiting on you (approve or deny first), not that it is mid-turn',
          observed: `session state ${before}; facts "${facts}"; steps "${outcome}"`,
          where: 'land-service.ts doLand: working and needs-you share copy.land.busy',
        });
      }
      return `refused (session ${before}): ${outcome}`;
    });

    await sim.step('spawn Codex on a fresh lane and let it write a file', async () => {
      const { sessionId, worktreeId } = await spawnCodex('agent/codex-1', 'write landed.txt');
      const wt = (await snap()).worktrees.find((w) => w.id === worktreeId);
      if (!wt) throw new Error('lane row missing after spawn');
      landedLane = { sessionId, worktreeId, path: wt.path };
      if (!existsSync(join(wt.path, 'landed.txt')))
        throw new Error('the fake Codex did not write landed.txt');
      await page().locator('[data-nav-item="repo"]').click();
      await lane('agent/codex-1').waitFor({ timeout: 10_000 });
      return `lane ${wt.branch} at ${wt.path} · row "${await text(lane('agent/codex-1'))}"`;
    });

    await sim.step('Land agent/codex-1: modal, summary, steps, merge commit on main, pushed', async () => {
      const row = lane('agent/codex-1');
      const verb = await text(row.locator('[data-action="land"]'));
      if (verb !== 'Land') throw new Error(`land verb reads "${verb}"`);
      await row.locator('[data-action="land"]').click();
      const d = dialog();
      await d.locator('[data-land-modal]').waitFor({ timeout: 10_000 });
      if (!/Land agent\/codex-1 into main/.test(await text(d))) throw new Error('title');
      await until(async () => (await d.locator('[data-land-preview="ready"]').count()) === 1, 20_000);
      const facts = await text(d.locator('[data-land-preview]'));
      if (!/1 file changed/.test(facts) || !/pushed to origin/.test(facts))
        throw new Error(`facts: ${facts}`);
      await until(async () => (await d.locator('[data-land-draft="done"]').count()) === 1, 30_000);
      const summary = await d.getByLabel('Summary').inputValue();
      if (!/landed\.txt/.test(summary))
        throw new Error(`summary does not name the file: ${JSON.stringify(summary)}`);
      await d.getByLabel('Summary').fill('Add landed.txt from the codex lane');
      await sim.shot('land-modal');
      const mainBefore = git(repo, 'rev-parse', 'main');
      await d.locator('[data-land-run]').click();
      const steps = await until(
        async () =>
          (await d.locator('[data-land-close]').count()) === 1
            ? await text(d.locator('[data-land-steps]'))
            : null,
        60_000,
      );
      await sim.shot('land-done');
      await d.locator('[data-land-close]').click();
      const head = git(repo, 'rev-parse', 'main');
      const parents = git(repo, 'log', '-1', '--format=%P', 'main').split(' ').length;
      const subject = git(repo, 'log', '-1', '--format=%s', 'main');
      const bareMain = tryGit(bare, 'rev-parse', 'refs/heads/main');
      if (head === mainBefore) throw new Error(`main did not move: ${steps}`);
      if (parents !== 2) throw new Error(`main HEAD has ${parents} parent(s), not a --no-ff merge`);
      if (subject !== 'Add landed.txt from the codex lane') throw new Error(`merge subject "${subject}"`);
      if (bareMain !== head) throw new Error(`bare main ${bareMain.slice(0, 7)} ≠ local ${head.slice(0, 7)}`);
      if (!existsSync(join(repo, 'landed.txt'))) throw new Error('landed.txt not in the main folder');
      const after = await until(async () => {
        const t = await text(row);
        return /landed today/.test(t) ? t : null;
      }, 10_000);
      if ((await row.getByRole('button', { name: 'Undo landing', exact: true }).count()) !== 1)
        throw new Error(`no Undo landing: ${after}`);
      const chat = (await systemLines(landedLane.sessionId)).filter((l) => /now in main/.test(l));
      const home = (await feed()).filter((w) => /landed agent\/codex-1 into main/.test(w));
      if (chat.length === 0) throw new Error('no "now in main" line in the lane\'s chat');
      if (home.length === 0) throw new Error('no Home row for the landing');
      return `${steps} · row "${after}" · chat "${chat[0]}" · home "${home[0]}"`;
    });

    await sim.step('Undo landing reverts on main, pushes, and the lane is live again', async () => {
      const row = lane('agent/codex-1');
      const before = git(repo, 'rev-parse', 'main');
      await row.getByRole('button', { name: 'Undo landing', exact: true }).click();
      await until(async () => git(repo, 'rev-parse', 'main') !== before, 20_000);
      const subject = git(repo, 'log', '-1', '--format=%s', 'main');
      const bareMain = tryGit(bare, 'rev-parse', 'refs/heads/main');
      const head = git(repo, 'rev-parse', 'main');
      const present = existsSync(join(repo, 'landed.txt'));
      const after = await until(async () => {
        const t = await text(row);
        return /landed/.test(t) ? null : t;
      }, 10_000);
      const chat = (await systemLines(landedLane.sessionId)).filter((l) => /back out of main/.test(l));
      const home = (await feed()).filter((w) => /took agent\/codex-1 back out of main/.test(w));
      if (!/^Revert/.test(subject)) throw new Error(`main subject "${subject}"`);
      if (bareMain !== head) throw new Error('the revert was not pushed');
      if (present) throw new Error('landed.txt still in the main folder after the revert');
      if ((await row.getByRole('button', { name: 'Land', exact: true }).count()) !== 1)
        throw new Error(`no Land verb: ${after}`);
      return `main "${subject}" pushed · row "${after}" · chat ${chat.length} · home ${home.length}`;
    });

    await sim.step('Land again right after Undo', async () => {
      const row = lane('agent/codex-1');
      const ahead = git(repo, 'rev-list', '--count', 'main..agent/codex-1');
      await row.locator('[data-action="land"]').click();
      const d = dialog();
      await d.locator('[data-land-modal]').waitFor({ timeout: 10_000 });
      await until(async () => (await d.locator('[data-land-preview="ready"]').count()) === 1, 20_000);
      const facts = await text(d.locator('[data-land-preview]'));
      await until(
        async () => (await d.locator('[data-land-draft="done"], [data-land-draft="failed"]').count()) === 1,
        30_000,
      );
      if ((await d.getByLabel('Summary').inputValue()).trim() === '')
        await d.getByLabel('Summary').fill('sim: land again');
      const before = git(repo, 'rev-parse', 'main');
      await d.locator('[data-land-run]').click();
      const steps = await until(
        async () =>
          (await d.locator('[data-land-close]').count()) === 1
            ? await text(d.locator('[data-land-steps]'))
            : null,
        40_000,
      );
      await sim.shot('land-after-undo');
      await d.locator('[data-land-close]').click();
      const moved = git(repo, 'rev-parse', 'main') !== before;
      if (moved) {
        // the work is back in main: the lane's files are in main's tree again
        const inMain = tryGit(repo, 'show', 'main:landed.txt');
        if (/^ERR/.test(inMain)) throw new Error(`main moved (${steps}) but landed.txt is not in it`);
        return `re-landed: ${steps}`;
      }
      sim.finding({
        severity: 'major',
        title:
          'after Undo landing the lane reads live and offers Land, but landing again does nothing useful',
        repro: 'Land a lane › Undo landing › Land again',
        expected:
          "the lane's work can go back in (its commit is already an ancestor of main, so a re-land needs a revert of the revert or a cherry-pick)",
        observed: `git rev-list main..lane = ${ahead}; facts "${facts}"; result "${steps}"; main moved: ${moved}`,
        where: 'land-service.ts undo() clears mergedAt; doLand counts commits base lacks → land.nothing',
      });
      return `ahead ${ahead} · "${facts}" · ${steps} · main moved: ${moved}`;
    });

    await sim.step('a fresh lane with nothing to land refuses honestly', async () => {
      await page().getByRole('button', { name: '+ Worktree', exact: true }).click();
      const wt = await until(async () => await wtOf('wt-2'));
      const row = lane('wt-2');
      await row.waitFor({ timeout: 10_000 });
      const hasLand = (await row.locator('[data-action="land"]').count()) === 1;
      if (!hasLand) return `wt-2 offers no Land (row "${await text(row)}")`;
      await row.locator('[data-action="land"]').click();
      const d = dialog();
      await d.locator('[data-land-modal]').waitFor({ timeout: 10_000 });
      await until(async () => (await d.locator('[data-land-preview="ready"]').count()) === 1, 20_000);
      const facts = await text(d.locator('[data-land-preview]'));
      await until(
        async () => (await d.locator('[data-land-draft="done"], [data-land-draft="failed"]').count()) === 1,
        30_000,
      );
      const draft = await d.locator('[data-land-draft]').getAttribute('data-land-draft');
      const hint = await text(d.locator('[data-land-draft]'));
      const disabled = await d.locator('[data-land-run]').isDisabled();
      let result = '';
      if (!disabled) {
        await d.locator('[data-land-run]').click();
        result = await until(
          async () =>
            (await d.locator('[data-land-close]').count()) === 1
              ? await text(d.locator('[data-land-steps]'))
              : null,
          40_000,
        );
        await d.locator('[data-land-close]').click();
      } else {
        await d.getByLabel('Summary').fill('sim: nothing');
        await d.locator('[data-land-run]').click();
        result = await until(
          async () =>
            (await d.locator('[data-land-close]').count()) === 1
              ? await text(d.locator('[data-land-steps]'))
              : null,
          40_000,
        );
        await d.locator('[data-land-close]').click();
      }
      await sim.command('worktree.archive', { worktreeId: wt.id });
      if (!/Nothing to land/.test(result))
        throw new Error(
          `facts "${facts}" · draft ${draft} "${hint}" · Land ${disabled ? 'disabled' : 'enabled'} · result "${result}"`,
        );
      return `facts "${facts}" · draft ${draft} · Land ${disabled ? 'disabled until a summary is typed' : 'enabled'} · "${result}"`;
    });

    await sim.step('review mode swaps Land for Merge into main and keeps Open PR', async () => {
      const r = await sim.command('project.settings.set', {
        projectId: project.id,
        patch: { integration: 'review' },
      });
      if (!r.ok) throw new Error(`settings.set: ${r.error?.message}`);
      const row = lane('test/flaky');
      await until(
        async () => (await row.getByRole('button', { name: 'Merge into main', exact: true }).count()) === 1,
        10_000,
      );
      const openPr = await row.getByRole('button', { name: 'Open PR', exact: true }).count();
      const land = await row.getByRole('button', { name: 'Land', exact: true }).count();
      await sim.shot('review-mode');
      const back = await sim.command('project.settings.set', {
        projectId: project.id,
        patch: { integration: 'auto' },
      });
      if (!back.ok) throw new Error('could not restore auto');
      await until(
        async () => (await row.getByRole('button', { name: 'Land', exact: true }).count()) === 1,
        10_000,
      );
      if (openPr !== 1 || land !== 0) throw new Error(`review mode row: ${await text(row)}`);
      return 'Merge into main + Open PR in review; Land back in auto';
    });

    // ------------------------------------------------------------------ 5. keep lanes current
    const clone = join(tmp, 'clone');
    const moveOrigin = (file: string, msg: string): string => {
      // the bare's HEAD points at an unborn `master`: clone main by name or the clone has no history to push
      if (!existsSync(clone)) execFileSync('git', ['clone', '-q', '-b', 'main', bare, clone]);
      else git(clone, 'pull', '-q', '--ff-only', 'origin', 'main');
      writeFileSync(join(clone, file), `${msg}\n`);
      git(clone, 'add', '-A');
      git(clone, 'commit', '-q', '-m', msg);
      git(clone, 'push', '-q', 'origin', 'HEAD:main');
      return git(clone, 'rev-parse', 'HEAD');
    };

    await sim.step('origin moves → Fetch fast-forwards main and the lane rows show ↓N main', async () => {
      await page().getByRole('button', { name: 'Fetch', exact: true }).click();
      await sleep(1500);
      const fix = await wtOf('fix/checkout');
      const b0 = fix?.behindBase ?? 0;
      const chat0 = (await systemLines(claudeId)).filter((l) => /main moved/.test(l)).length;
      const tip = moveOrigin('upstream.txt', 'upstream: a commit from another machine');
      await page().getByRole('button', { name: 'Fetch', exact: true }).click();
      const row = await until(async () => {
        const t = await text(lane('fix/checkout'));
        return new RegExp(`↓${b0 + 1} main`).test(t) ? t : null;
      }, 20_000);
      const localMain = git(repo, 'rev-parse', 'main');
      const gitBehind = git(repo, 'rev-list', '--count', 'fix/checkout..main');
      if (localMain !== tip)
        throw new Error(`main not fast-forwarded: ${localMain.slice(0, 7)} vs origin ${tip.slice(0, 7)}`);
      if (Number(gitBehind) !== b0 + 1) throw new Error(`git says ${gitBehind} behind, row ${row}`);
      const header = await text(page().locator('[data-repo-remote]'));
      const chat = (await systemLines(claudeId)).filter((l) => /main moved/.test(l));
      await sim.shot('behind-main');
      if (chat.length !== chat0 + 1)
        throw new Error(`claude chat "main moved" lines: ${chat.length} (was ${chat0}): ${chat.join(' | ')}`);
      return `row "${row}" · header "${header}" · chat "${chat.at(-1)}"`;
    });

    await sim.step("the Workspace status bar shows the same ↓N main for the editor's lane", async () => {
      await page().locator('[data-nav-item="workspace"]').click();
      await page().locator(`[data-session-tab="${claudeId}"]`).click();
      const bar = page().locator('[data-status-bar]');
      const t = await until(async () => {
        const s = await text(bar);
        return /↓\d+ main/.test(s) ? s : null;
      }, 10_000);
      await sim.shot('status-bar-behind');
      await page().locator('[data-nav-item="repo"]').click();
      await page().locator('[data-repo]').waitFor({ timeout: 10_000 });
      return t;
    });

    await sim.step('Bring in main on fix/checkout (its agent reads as working)', async () => {
      const row = lane('fix/checkout');
      const state = (await snap()).sessions.find((s) => s.id === claudeId)?.state;
      await row.locator('[data-action="sync"]').click();
      await sleep(2500);
      const t = await toasts();
      const after = await text(row);
      const merged = git(repo, 'rev-list', '--count', 'fix/checkout..main');
      if (merged === '0') return `merged although the session was ${state}: row "${after}"`;
      if (!/mid-turn/.test(t))
        throw new Error(`no busy toast (session ${state}); toast "${t}", row "${after}"`);
      sim.finding({
        severity: 'minor',
        title:
          'the demo\'s Claude lane cannot bring main in: its session is "working" with no process behind it',
        repro: 'demo fixture › Repo › fix/checkout › ↓N main',
        expected:
          'a seeded session with no live process should not count as mid-turn, or the row should say why the click will not work before it is clicked',
        observed: `session ${state}, toast "${t}"`,
        where:
          'lane-sync-service.ts sync(): live.state === "working" · session rows seeded working without a runner',
      });
      return `refused: "${t}"`;
    });

    await sim.step('Bring in main on the codex lane merges and clears the count', async () => {
      const live = await liveCodexLane();
      const branchOf = (await snap()).worktrees.find((w) => w.id === live.worktreeId)?.branch ?? '';
      const row = lane(branchOf);
      // New work on the lane makes (or keeps) it live; origin moving on makes it behind main.
      writeFileSync(join(live.path, 'after-landing.txt'), 'more\n');
      git(live.path, 'add', '-A');
      git(live.path, 'commit', '-q', '-m', 'more work after the landing');
      moveOrigin('upstream-sync.txt', 'upstream: moves before the lane syncs');
      await page().getByRole('button', { name: 'Fetch', exact: true }).click();
      const t0 = await until(async () => {
        const t = await text(row);
        return /↓\d+ main/.test(t) ? t : null;
      }, 20_000);
      if (t0 === null) throw new Error(`no ↓ on the codex lane: ${await text(row)}`);
      await row.locator('[data-action="sync"]').click();
      const after = await until(async () => {
        const t = await text(row);
        return /↓\d+ main/.test(t) ? null : t;
      }, 20_000);
      const behind = git(repo, 'rev-list', '--count', `${branchOf}..main`);
      const subject = git(landedLane.path, 'log', '-1', '--format=%s');
      if (behind !== '0') throw new Error(`git still says ${behind} behind`);
      const chat = (await systemLines(landedLane.sessionId)).filter((l) => /Brought in main/.test(l));
      return `row "${after}" · lane HEAD "${subject}" · chat ${chat.length ? `"${chat.at(-1)}"` : '(no line)'}`;
    });

    await sim.step(
      'dirty main folder: Land refuses with the dirty-base message and moves nothing',
      async () => {
        // Something to land: a hand commit on the codex lane.
        const live = await liveCodexLane();
        const liveBranch = (await snap()).worktrees.find((w) => w.id === live.worktreeId)?.branch ?? '';
        writeFileSync(join(live.path, 'second.txt'), 'second\n');
        git(live.path, 'add', '-A');
        git(live.path, 'commit', '-q', '-m', 'second file on the codex lane');
        writeFileSync(join(repo, 'README.md'), '# acme-shop\n\nedited by hand in the main folder\n');
        await page().getByRole('button', { name: 'Fetch', exact: true }).click();
        await sleep(1500);
        const before = git(repo, 'rev-parse', 'main');
        await lane(liveBranch).locator('[data-action="land"]').click();
        const d = dialog();
        await d.locator('[data-land-modal]').waitFor({ timeout: 10_000 });
        await until(
          async () => (await d.locator('[data-land-draft="done"], [data-land-draft="failed"]').count()) === 1,
          30_000,
        );
        if ((await d.getByLabel('Summary').inputValue()).trim() === '')
          await d.getByLabel('Summary').fill('sim: dirty base');
        await d.locator('[data-land-run]').click();
        const steps = await until(
          async () =>
            (await d.locator('[data-land-close]').count()) === 1
              ? await text(d.locator('[data-land-steps]'))
              : null,
          40_000,
        );
        await sim.shot('land-dirty-base');
        await d.locator('[data-land-close]').click();
        git(repo, 'checkout', '--', 'README.md');
        if (git(repo, 'rev-parse', 'main') !== before) throw new Error(`main moved: ${steps}`);
        if (!/uncommitted changes on main/.test(steps)) throw new Error(`refusal: ${steps}`);
        return steps;
      },
    );

    await sim.step('diverged main: Land refuses with the diverged message; nothing moved', async () => {
      writeFileSync(join(repo, 'local.txt'), 'local only\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'local: a commit not pushed');
      moveOrigin('upstream-2.txt', 'upstream: moves again');
      await page().getByRole('button', { name: 'Fetch', exact: true }).click();
      const header = await until(async () => {
        const h = await text(page().locator('[data-repo-remote]'));
        return /↑1 ↓1/.test(h) ? h : null;
      }, 20_000);
      const before = git(repo, 'rev-parse', 'main');
      const live = await liveCodexLane();
      const liveBranch = (await snap()).worktrees.find((w) => w.id === live.worktreeId)?.branch ?? '';
      const laneBefore = git(live.path, 'rev-parse', 'HEAD');
      await lane(liveBranch).locator('[data-action="land"]').click();
      const d = dialog();
      await d.locator('[data-land-modal]').waitFor({ timeout: 10_000 });
      await until(
        async () => (await d.locator('[data-land-draft="done"], [data-land-draft="failed"]').count()) === 1,
        30_000,
      );
      if ((await d.getByLabel('Summary').inputValue()).trim() === '')
        await d.getByLabel('Summary').fill('sim: diverged');
      await d.locator('[data-land-run]').click();
      const steps = await until(
        async () =>
          (await d.locator('[data-land-close]').count()) === 1
            ? await text(d.locator('[data-land-steps]'))
            : null,
        40_000,
      );
      await sim.shot('land-diverged');
      await d.locator('[data-land-close]').click();
      const moved =
        git(repo, 'rev-parse', 'main') !== before || git(landedLane.path, 'rev-parse', 'HEAD') !== laneBefore;
      // Tidy: put main back on its upstream so the rest of the run is not on a diverged base.
      git(repo, 'checkout', '-q', '-B', 'main', 'origin/main');
      if (moved) throw new Error(`something moved: ${steps}`);
      if (!/each moved on/.test(steps)) throw new Error(`refusal: ${steps} (header ${header})`);
      return `${header} · ${steps}`;
    });

    // ------------------------------------------------------------------ 7. lane awareness
    await sim.step(
      'two lanes touching the same file: overlaps tag on both rows, a line in each chat',
      async () => {
        const a = await spawnCodex('agent/codex-2', 'write same.txt');
        const b = await spawnCodex('agent/codex-3', 'write same.txt');
        await page().locator('[data-nav-item="repo"]').click();
        await page().locator('[data-repo]').waitFor({ timeout: 10_000 });
        let tags = await Promise.all([
          lane('agent/codex-2').locator('[data-lane-overlaps]').count(),
          lane('agent/codex-3').locator('[data-lane-overlaps]').count(),
        ]);
        let via = 'after the turns';
        if (tags[0] === 0 || tags[1] === 0) {
          await page().getByRole('button', { name: 'Fetch', exact: true }).click();
          await until(
            async () =>
              (await lane('agent/codex-2').locator('[data-lane-overlaps]').count()) === 1 &&
              (await lane('agent/codex-3').locator('[data-lane-overlaps]').count()) === 1,
            15_000,
          ).catch(() => undefined);
          tags = await Promise.all([
            lane('agent/codex-2').locator('[data-lane-overlaps]').count(),
            lane('agent/codex-3').locator('[data-lane-overlaps]').count(),
          ]);
          via = 'only after Fetch';
        }
        await sim.shot('overlaps');
        const t2 = await text(lane('agent/codex-2'));
        const t3 = await text(lane('agent/codex-3'));
        const chatA = (await systemLines(a.sessionId)).filter((l) => /also changed|Shared file/.test(l));
        const chatB = (await systemLines(b.sessionId)).filter((l) => /also changed|Shared file/.test(l));
        if (tags[0] === 0 || tags[1] === 0) throw new Error(`no overlaps tag: "${t2}" / "${t3}"`);
        if (!/overlaps agent\/codex-3/.test(t2) || !/overlaps agent\/codex-2/.test(t3))
          throw new Error(`tags read: "${t2}" / "${t3}"`);
        if (via === 'only after Fetch')
          sim.finding({
            severity: 'minor',
            title: 'overlaps appear only after Fetch when Track agent edits is off',
            repro: 'spawn two Codex sessions that each write same.txt on their own lanes; look at Repo',
            expected:
              'the rows read "overlaps <branch>" once both agents have written the file (ADR-0025: after every hunk rescan)',
            observed: `tags ${via}; chat lines: ${chatA.length}/${chatB.length}`,
            where:
              'lane-ledger-service.ts laneChanged is fed by HunkService.onRescanned, gated by trackAgentEdits=false; refreshProject runs on Fetch',
          });
        if (chatA.length === 0 || chatB.length === 0)
          throw new Error(
            `tags ${via} but chat lines ${chatA.length}/${chatB.length}: "${chatA[0] ?? ''}" / "${chatB[0] ?? ''}"`,
          );
        return `tags ${via} · "${t2}" · chat "${chatA[0]}"`;
      },
    );

    // ------------------------------------------------------------------ 8. layout at the window minimum
    await sim.step('lane rows fit at 1100×680', async () => {
      await sim.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w?.setSize(1100, 680);
      });
      await sleep(800);
      const over = await page().evaluate(() => {
        const out: string[] = [];
        for (const row of Array.from(document.querySelectorAll('[data-lane]'))) {
          const cells = Array.from(row.children) as HTMLElement[];
          for (const c of cells) {
            // what is drawn: the children's boxes (scrollWidth also counts the verbs' invisible ±6px hit areas)
            const box = c.getBoundingClientRect();
            const kids = Array.from(c.children) as HTMLElement[];
            const right = Math.max(box.left, ...kids.map((k) => k.getBoundingClientRect().right));
            const textWide = kids.length === 0 && c.scrollWidth > c.clientWidth + 1;
            // the verbs cell keeps the prototype's column width and may spill a few px into the PR column's
            // empty right half at the minimum (a second line would break the baked layout); more is a fault
            const slack = c === cells[cells.length - 1] ? 8 : 1;
            if (right > box.right + slack || textWide)
              out.push(
                `${row.getAttribute('data-lane')}: "${c.textContent?.trim().slice(0, 40)}" ${Math.round(right - box.left)}>${Math.round(box.width)}`,
              );
          }
        }
        if (document.documentElement.scrollWidth > window.innerWidth)
          out.push(`document ${document.documentElement.scrollWidth}>${window.innerWidth}`);
        return out;
      });
      await sim.shot('layout-1100x680');
      if (over.length > 0) throw new Error(`overflow: ${over.join('; ')}`);
      return 'no cell overflows';
    });

    // ------------------------------------------------------------------ 6. conflicts (error fixture)
    await sim.relaunch({ fixture: 'error', screen: 'repo' });
    let conflictLane = { id: '', path: '', sessionId: '' };
    await sim.step(
      'error fixture: the lane reads CONFLICT and its session is paused with the banner',
      async () => {
        await ready();
        const s = await snap();
        const p = s.projects.find((x) => x.name === 'acme-shop');
        if (!p) throw new Error('acme-shop missing');
        repo = p.path;
        const row = await until(async () => {
          const t = await text(lane('fix/checkout'));
          return /CONFLICT/.test(t) ? t : null;
        }, 20_000);
        const wt = await wtOf('fix/checkout');
        if (!wt) throw new Error('fix/checkout missing');
        const owner = await sessionOf(wt.id);
        conflictLane = { id: wt.id, path: wt.path, sessionId: owner?.id ?? '' };
        const state = await until(async () => {
          const o = await sessionOf(wt.id);
          return o?.state === 'paused' ? `${o.state}/${o.pausedReason}` : null;
        }, 15_000).catch(() => `${owner?.state}/${owner?.pausedReason}`);
        const banners = page().locator('[data-banner-key^="conflict:"]');
        let bannerText = (await banners.count()) > 0 ? await text(banners.first()) : '';
        if (bannerText === '') {
          await page().locator('[data-nav-item="workspace"]').click();
          await sleep(800);
          bannerText =
            (await banners.count()) > 0 ? await text(banners.first()) : '(no banner on Workspace either)';
          await page().locator('[data-nav-item="repo"]').click();
          await page().locator('[data-repo]').waitFor({ timeout: 10_000 });
        }
        await sim.shot('conflict-row');
        if (!/CONFLICT · checkout\.ts vs main/.test(row)) throw new Error(`row: ${row}`);
        if (!/paused\/conflict/.test(state)) throw new Error(`session ${state}`);
        if (!/conflicts with main in checkout\.ts/.test(bannerText)) throw new Error(`banner: ${bannerText}`);
        return `row "${row}" · session ${state} · banner "${bannerText}"`;
      },
    );

    await sim.step("Resolve hands the merge to the lane's agent: what the state reads", async () => {
      const row = lane('fix/checkout');
      const dirtyBefore = git(conflictLane.path, 'status', '--porcelain').split('\n').filter(Boolean).length;
      const headBefore = git(conflictLane.path, 'rev-parse', 'HEAD');
      await row.getByRole('button', { name: 'Resolve', exact: true }).click();
      await sleep(4000);
      const t = await toasts();
      const after = await text(row);
      const wt = (await snap()).worktrees.find((w) => w.id === conflictLane.id);
      const owner = await sessionOf(conflictLane.id);
      const lines = (await systemLines(conflictLane.sessionId)).slice(-3);
      const inMerge = mergeInProgress(conflictLane.path);
      const dirtyAfter = git(conflictLane.path, 'status', '--porcelain').split('\n').filter(Boolean).length;
      await sim.shot('resolve-clicked');
      const summary = `row "${after}" · toast "${t}" · resolution ${JSON.stringify(wt?.resolution)} · session ${owner?.state}/${owner?.pausedReason} · merge in progress: ${inMerge} · dirty ${dirtyBefore}→${dirtyAfter} · HEAD ${headBefore.slice(0, 7)}→${git(conflictLane.path, 'rev-parse', 'HEAD').slice(0, 7)} · chat: ${lines.join(' | ')}`;
      if (/git-error|would be overwritten|error/i.test(t) && !inMerge) {
        sim.finding({
          severity: 'major',
          title:
            'Resolve on a conflicting lane with uncommitted edits fails with a raw git error and nothing starts',
          repro: 'error fixture › Repo › fix/checkout (CONFLICT, uncommitted edits to checkout.ts) › Resolve',
          expected:
            'the resolver checkpoints the tree, starts the merge, and hands the conflicted files to the agent (ADR-0025 phase B)',
          observed: summary,
          where:
            'merge-resolve-service.ts resolve(): git.merge on a dirty tree → "local changes would be overwritten" → mergeAbort → fail(git-error)',
        });
        return `did not start: ${summary}`;
      }
      if (!inMerge && wt?.resolution === null)
        sim.finding({
          severity: 'major',
          title: 'Resolve did nothing visible on the conflicting lane',
          repro: 'error fixture › Repo › fix/checkout › Resolve',
          expected:
            'the row reads "merging main with Claude Code…" and the chat gets the resolve.started line',
          observed: summary,
          where: 'merge-resolve-service.ts resolve()',
        });
      return summary;
    });

    await sim.step(
      'the fake agent cannot finish: does the lane get stuck, and does Undo merge leave the tree clean',
      async () => {
        const row = lane('fix/checkout');
        await sleep(6000);
        const wt = (await snap()).worktrees.find((w) => w.id === conflictLane.id);
        const owner = await sessionOf(conflictLane.id);
        const before = `row "${await text(row)}" · resolution ${wt?.resolution?.state ?? 'null'} · session ${owner?.state}/${owner?.pausedReason} · merge in progress: ${mergeInProgress(conflictLane.path)}`;
        const undoBtn = row.getByRole('button', { name: 'Undo merge', exact: true });
        let how = '';
        if ((await undoBtn.count()) === 1) {
          await undoBtn.click();
          how = 'Undo merge button';
        } else {
          const r = await sim.command('worktree.undoResolve', { worktreeId: conflictLane.id });
          how = `worktree.undoResolve → ${r.ok ? 'ok' : `${r.error?.code}: ${r.error?.message}`}`;
          if (!r.ok && mergeInProgress(conflictLane.path)) {
            // A person's last resort: nothing in the UI aborts it.
            sim.finding({
              severity: 'major',
              title: 'a merge the agent could not finish stays in progress with no way out from the UI',
              repro: 'error fixture › Resolve with an agent that never answers (fake claude) › wait',
              expected:
                'the row offers Undo merge (or the resolver gives up after its attempts) and git status shows no merge',
              observed: `${before} · ${how}`,
              where:
                'merge-resolve-service.ts: undo() requires resolution.state done; a resolving lane offers no verb',
            });
          }
        }
        await sleep(2000);
        const inMerge = mergeInProgress(conflictLane.path);
        const status = git(conflictLane.path, 'status', '--porcelain');
        const markers =
          existsSync(join(conflictLane.path, 'checkout.ts')) &&
          /^<<<<<<<|^>>>>>>>/m.test(
            execFileSync('cat', [join(conflictLane.path, 'checkout.ts')], { encoding: 'utf8' }),
          );
        const after = await text(row);
        await sim.shot('after-undo-merge');
        const s = `${before} → ${how} → row "${after}" · merge in progress: ${inMerge} · markers in checkout.ts: ${markers} · status: ${status.replace(/\n/g, ', ') || 'clean'}`;
        if (inMerge || markers) throw new Error(s);
        return s;
      },
    );

    await sim.step(
      'Bring in main on the conflicting lane (auto mode) goes to the resolver, not a silent abort',
      async () => {
        const row = lane('fix/checkout');
        const sync = row.locator('[data-action="sync"]');
        if ((await sync.count()) === 0) return `no ↓N main on the row: "${await text(row)}"`;
        await sync.click();
        await sleep(4000);
        const t = await toasts();
        const after = await text(row);
        const inMerge = mergeInProgress(conflictLane.path);
        const lines = (await systemLines(conflictLane.sessionId)).slice(-2);
        await sim.shot('sync-conflict');
        if (inMerge) await sim.command('worktree.undoResolve', { worktreeId: conflictLane.id });
        return `row "${after}" · toast "${t}" · merge in progress: ${inMerge} · chat: ${lines.join(' | ')}`;
      },
    );
  });
  rmSync(tmp, { recursive: true, force: true });
});
