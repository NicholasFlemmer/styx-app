/**
 * User simulation · the Workspace: files, editor, hunks / Diff review, terminal, and the chat pane with a live
 * agent (queue, steer, checkpoints, attachments, pop-out). Drives the built app over the demo fixture the way a
 * person would, with the fake `codex` / `gemini` CLIs (e2e/fixtures/bin) standing in for the real ones. Every
 * step asserts an outcome a person can see (DOM, screenshot) or check (a file on disk, a git status), and a step
 * that fails is recorded with a screenshot while the walkthrough goes on. Findings land in
 * docs/reports/user-sim/workspace-chat.md (written by the harness).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSim, type SimContext } from './harness';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

interface SessionRow {
  id: string;
  agent: string;
  state: string;
  worktreeId: string;
  firstMessage: string | null;
  runner: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  slashCommands: string[];
  archivedAt: number | null;
  pid: number | null;
}
interface WorktreeRow {
  id: string;
  path: string;
  branch: string | null;
  isMain: boolean;
  projectId: string;
}
interface HunkRow {
  id: string;
  file: string;
  patch: string;
  status: string;
  sessionId: string;
  worktreeId: string;
}
interface Model {
  sessions: SessionRow[];
  worktrees: WorktreeRow[];
  hunks: Record<string, HunkRow[]>;
  checkpoints: Record<string, { id: string; turn: number; files: number; screens: string[] }[]>;
  queues: Record<string, unknown[]>;
  popouts: string[];
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** 1×1 transparent PNG, enough for the composer's image reader to accept. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const snapshot = async (sim: SimContext): Promise<Model> => {
  const r = await sim.command<Model>('store.snapshot', {});
  if (!r.ok || r.value === undefined) throw new Error(`store.snapshot failed: ${r.error?.message ?? '?'}`);
  return r.value;
};

/** The persisted `ui` block main hands the renderer at boot (pane sizes, screen, project). */
const persistedUi = (page: Page): Promise<{ paneSizes: Record<string, number> }> =>
  page.evaluate(async () => {
    const w = window as unknown as {
      styx: { snapshot: () => Promise<{ ui: { paneSizes: Record<string, number> } }> };
    };
    const s = await w.styx.snapshot();
    return { paneSizes: s.ui.paneSizes };
  });

/** Text of the xterm rows: the DOM renderer's rows, else the accessibility tree (screen-reader mode). */
const terminalRows = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const root = document.querySelector('[data-terminal] .xterm');
    if (root === null) return [];
    const clean = (s: string | null) => (s ?? '').replace(/ /g, ' ').trimEnd();
    const dom = Array.from(root.querySelectorAll('.xterm-rows > div')).map((d) => clean(d.textContent));
    if (dom.some((r) => r.trim() !== '')) return dom;
    return Array.from(root.querySelectorAll('.xterm-accessibility-tree > div')).map((d) =>
      clean(d.textContent),
    );
  });

const monacoText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const lines = document.querySelector('[data-editor-file] .view-lines');
    return (lines?.textContent ?? '').replace(/ /g, ' ');
  });

const addedLines = (patch: string): string[] =>
  patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));

/** Dispatches a paste or drop carrying one PNG file on the composer (a File built in the page). */
const attachImage = async (page: Page, how: 'paste' | 'drop', name: string): Promise<void> => {
  if (how === 'paste') {
    await page.evaluate(
      ([name, b64]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type: 'image/png' }));
        const ta = document.querySelector<HTMLTextAreaElement>('[data-keyscope="composer"] textarea');
        if (ta === null) throw new Error('no composer textarea');
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      [name, PNG_1PX] as const,
    );
    return;
  }
  // Chromium drops the `dataTransfer` of a script-made DragEvent; Playwright's dispatchEvent carries a real one.
  const dt = await page.evaluateHandle(
    ([name, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'image/png' }));
      return dt;
    },
    [name, PNG_1PX] as const,
  );
  // dispatched on the textarea; the drop bubbles to the composer's handler (its root is not the first child)
  const root = '[data-keyscope="composer"] textarea';
  await page.dispatchEvent(root, 'dragenter', { dataTransfer: dt });
  await page.dispatchEvent(root, 'dragover', { dataTransfer: dt });
  await page.dispatchEvent(root, 'drop', { dataTransfer: dt });
};

/** Opens a lane from the project nav (ADR-0027 §1: every lane is listed there; there is no overflow). */
const clickTab = async (page: Page, sessionId: string): Promise<void> => {
  await page.locator(`[data-nav-lane="${sessionId}"]`).click();
};

const drag = async (page: Page, handle: Locator, dx: number, dy: number): Promise<void> => {
  const box = await handle.boundingBox();
  if (box === null) throw new Error('handle has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
};

test('sim: workspace-chat', async () => {
  await runSim('workspace-chat', { screen: 'workspace' }, async (sim) => {
    const page = () => sim.page;
    const chat = () => page().locator('[data-chat-pane]');
    const composer = () => page().locator('[data-keyscope="composer"] textarea');
    const ids = {
      claudeDemo: '',
      codexDemo: '',
      geminiDemo: '',
      codexNew: '',
      geminiNew: '',
    };
    const lane = { path: '', branch: '' };
    const codexLane = { path: '', branch: '' };

    // ------------------------------------------------------------------ 1. files & editor
    await sim.step('boots on the Workspace with files, editor, terminal, chat and status bar', async () => {
      await page().waitForSelector('[data-screen-ready="workspace"]', { timeout: 20_000 });
      for (const sel of [
        '[data-files-pane]',
        '[data-editor-file]',
        '[data-terminal]',
        '[data-chat-pane]',
        '[data-status-bar]',
      ])
        await page().locator(sel).first().waitFor({ state: 'visible', timeout: 10_000 });
      const m = await snapshot(sim);
      const claude = m.sessions.find((s) => s.agent === 'claude' && s.state === 'working');
      const codex = m.sessions.find((s) => s.agent === 'codex' && s.state === 'needs-you');
      const gemini = m.sessions.find((s) => s.agent === 'gemini' && s.state === 'idle');
      if (!claude || !codex || !gemini) throw new Error('demo sessions missing');
      ids.claudeDemo = claude.id;
      ids.codexDemo = codex.id;
      ids.geminiDemo = gemini.id;
      const wt = m.worktrees.find((w) => w.id === claude.worktreeId);
      if (!wt) throw new Error('claude worktree missing');
      lane.path = wt.path;
      lane.branch = wt.branch ?? '';
      await sim.shot('workspace-boot');
      return `editor lane ${lane.branch} at ${lane.path}`;
    });

    await sim.step("the tree shows acme-shop's files with git marks", async () => {
      const tree = page().locator('[data-files-pane] [role="treeitem"]');
      await expect(tree.first()).toBeVisible({ timeout: 10_000 });
      const paths = await tree.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['path']));
      for (const f of [
        'README.md',
        'app.ts',
        'cart.ts',
        'checkout.ts',
        'pay.ts',
        'orders.test.ts',
        'validate.ts',
        'checkout.test.ts',
      ])
        if (!paths.includes(f)) throw new Error(`tree misses ${f}; has ${paths.join(', ')}`);
      const marks = await tree.evaluateAll((els) =>
        els.map((e) => `${(e as HTMLElement).dataset['path']}:${e.lastElementChild?.textContent ?? ''}`),
      );
      const changes = await page().locator('[data-files-pane]').innerText();
      const header = /Changes · (\d+)/.exec(changes)?.[1] ?? '?';
      return `marks ${marks.filter((m) => !m.endsWith(':')).join(' ')} · Changes · ${header}`;
    });

    await sim.step(
      'opening a file shows its content in Monaco and the status bar reads the editor line',
      async () => {
        await page().locator('[data-files-pane] [role="treeitem"][data-path="cart.ts"]').click();
        await page().locator('[data-editor-file="cart.ts"]').waitFor({ timeout: 10_000 });
        await expect.poll(() => monacoText(page()), { timeout: 10_000 }).toContain('items.reduce');
        const bar = page().locator('[data-status-bar]');
        await expect(bar).toContainText('Monaco · LF · TS', { timeout: 5000 });
        await expect(bar).toContainText(/Ln \d+, Col \d+/, { timeout: 5000 });
        // Click into the editor's first line, press End: the readout follows the caret.
        await page().locator('[data-editor-file="cart.ts"] .view-line').first().click();
        await page().keyboard.press('End');
        await expect(bar).toContainText(/Ln 1, Col (?!1\b)\d+/, { timeout: 5000 });
        const text = await bar.innerText();
        return text.replace(/\s+/g, ' ');
      },
    );

    let hunkCount = 0;
    await sim.step('the gutter marks agent hunks on checkout.ts and the hunk bar counts them', async () => {
      await page().locator('[data-files-pane] [role="treeitem"][data-path="checkout.ts"]').click();
      await page().locator('[data-editor-file="checkout.ts"]').waitFor({ timeout: 10_000 });
      await expect
        .poll(() => page().locator('[data-editor-file] .styx-hunk-line').count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
      const labels = await page().locator('[data-editor-file] .styx-hunk-label').allTextContents();
      if (!labels.some((l) => /Claude · /.test(l)))
        throw new Error(`no "Claude · age" label; got ${labels.join('|')}`);
      const bar = page().locator('[data-hunk-bar]');
      await expect(bar).toBeVisible({ timeout: 5000 });
      const barText = await bar.innerText();
      const n = Number(/(\d+) hunks? from Claude/.exec(barText)?.[1] ?? NaN);
      if (!Number.isFinite(n)) throw new Error(`hunk bar reads "${barText}"`);
      const m = await snapshot(sim);
      const laneWt = m.worktrees.find((w) => w.path === lane.path);
      const inLane = Object.values(m.hunks)
        .flat()
        .filter((h) => h.status === 'pending' && h.worktreeId === laneWt?.id);
      if (inLane.length !== n)
        throw new Error(`bar says ${n}, store has ${inLane.length} pending in the lane`);
      hunkCount = n;
      await sim.shot('editor-hunks');
      return `${barText.replace(/\s+/g, ' ')} · labels ${labels.join(' | ')}`;
    });

    await sim.step('Review opens the Diff review with one card per hunk and the keys legend', async () => {
      await page().locator('[data-hunk-bar]').getByRole('button', { name: 'Review', exact: true }).click();
      await page().locator('[data-diff-review]').waitFor({ timeout: 10_000 });
      await expect(page().locator('[data-hunk]')).toHaveCount(hunkCount, { timeout: 5000 });
      const legend = (await page().locator('[data-diff-keys]').innerText()).replace(/\s+/g, ' ');
      const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl';
      if (
        !legend.includes('r revert') ||
        !legend.includes('j / k next · prev') ||
        !legend.includes(`${mod}⏎ done`)
      )
        throw new Error(`legend reads "${legend}"`);
      const meta = await page().locator('[data-diff-meta]').innerText();
      await sim.shot('diff-review');
      return `${meta} · legend "${legend}"`;
    });

    await sim.step('j / k move the focused hunk', async () => {
      const focused = () =>
        page().evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['hunk'] ?? null);
      const idsInOrder = await page()
        .locator('[data-hunk]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['hunk']));
      await page().keyboard.press('j');
      await expect.poll(focused, { timeout: 3000 }).toBe(idsInOrder[1]);
      await page().keyboard.press('k');
      await expect.poll(focused, { timeout: 3000 }).toBe(idsInOrder[0]);
    });

    let fixtureHunkDrift = false;
    await sim.step('r reverts the focused hunk and the file on disk changes back', async () => {
      const id = await page().evaluate(
        () => (document.activeElement as HTMLElement | null)?.dataset['hunk'] ?? null,
      );
      if (id === null) throw new Error('no focused hunk');
      const m = await snapshot(sim);
      const hunk = Object.values(m.hunks)
        .flat()
        .find((h) => h.id === id);
      if (!hunk) throw new Error(`hunk ${id} not in store`);
      const file = join(lane.path, hunk.file);
      const added = addedLines(hunk.patch).filter((l) => l.trim() !== '');
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (before !== null && added[0] !== undefined && !before.includes(added[0])) {
        // Fixture drift, not an app fault: the demo's hunk rows are prototype text (double quotes) while the
        // seeded lane file is single-quoted, so `git apply -R` of that hunk cannot match. A real lane's hunks
        // come from the watcher's own diff. Noted; the revert path is covered by the unit tests.
        sim.finding({
          severity: 'polish',
          title: 'demo fixture: the seeded lane file and the fixture hunk rows disagree (quote style)',
          repro: 'demo fixture › Workspace › Review › r on the first checkout.ts hunk',
          expected: 'the hunk applies in reverse to the file on disk',
          observed: `${hunk.file} does not contain "${added[0]}"`,
          where:
            'apps/desktop/src/main/db/seed-repos.ts FIX_CHECKOUT vs packages/core/src/fixtures/demo.ts demoHunks',
        });
        fixtureHunkDrift = true;
        return `skipped: fixture hunk text does not match the seeded file`;
      }
      await page().keyboard.press('r');
      await expect(page().locator(`[data-hunk="${id}"]`)).toHaveAttribute('data-status', 'rejected', {
        timeout: 10_000,
      });
      await expect(page().locator(`[data-hunk="${id}"] [data-hunk-status]`)).toHaveText('reverted');
      await expect
        .poll(
          () => {
            if (!existsSync(file)) return 'gone';
            const after = readFileSync(file, 'utf8');
            return added[0] !== undefined && after.includes(added[0]) ? 'still-there' : 'reverted';
          },
          { timeout: 10_000 },
        )
        .not.toBe('still-there');
      return `${hunk.file}: ${existsSync(file) ? 'edit removed' : 'file removed'} (${added.length} added lines)`;
    });

    await sim.step('Revert all reverts the rest; the lane is clean on disk', async () => {
      await page()
        .locator('[data-diff-review]')
        .getByRole('button', { name: 'Revert all', exact: true })
        .click();
      if (fixtureHunkDrift) {
        // the same drift: the reverse patches cannot apply; the app must say so rather than pretend
        await page().waitForTimeout(1500);
        const toast = await page().locator('[data-toast]').allInnerTexts();
        await sim.shot('diff-revert-all-refused');
        if (toast.length === 0) throw new Error('Revert all failed on every hunk with no word to the person');
        return `refused (fixture drift), said: ${toast.join(' | ').replace(/\s+/g, ' ').slice(0, 160)}`;
      }
      await expect(page().locator('[data-hunk][data-status="pending"]')).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => git(['status', '--porcelain'], lane.path), { timeout: 10_000 }).toBe('');
      await sim.shot('diff-reverted-all');
    });

    await sim.step('Mod+Enter is Done: back on the Workspace with no hunk bar', async () => {
      await page().keyboard.press(`${MOD}+Enter`);
      await page().locator('[data-screen-ready="workspace"]').waitFor({ timeout: 10_000 });
      await expect(page().locator('[data-hunk-bar]')).toHaveCount(0, { timeout: 5000 });
      await expect(page().locator('[data-files-pane]')).toContainText('Changes · 0', { timeout: 10_000 });
    });

    // Files that appear on disk after the tree loaded (an agent creating them, a checkout): does the tree notice?
    const binFile = join(lane.path, 'logo.bin');
    const bigFile = join(lane.path, 'big.txt');
    await sim.step('the file tree picks up files that appear on disk', async () => {
      writeFileSync(binFile, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 0)]));
      writeFileSync(bigFile, `${'x'.repeat(99)}\n`.repeat(11_000));
      const shows = async () =>
        (await page().locator('[data-files-pane] [role="treeitem"][data-path="logo.bin"]').count()) > 0;
      let seen = false;
      for (let i = 0; i < 8 && !seen; i += 1) {
        await page().waitForTimeout(500);
        seen = await shows();
      }
      if (!seen) {
        sim.finding({
          severity: 'major',
          title: 'the file tree does not refresh when files appear on disk',
          repro:
            'Workspace on a lane; create a file in the lane folder (an agent does this every turn); wait 4 s',
          expected:
            'the tree lists the new file (git marks it A / ?), like the hunk watcher already notices it',
          observed:
            'the tree is loaded once per worktree on mount; the new file only shows after leaving and re-entering the Workspace',
          where:
            'apps/desktop/src/renderer/screens/Workspace/Workspace.tsx (loadWorktreeTree in a [worktreeId] effect; no fs watcher)',
        });
        throw new Error('new file not listed after 4 s');
      }
    });

    await sim.step(
      'after a trip to Settings and back, a binary file opens read-only with a notice',
      async () => {
        await page().locator('[data-app-rail-item="app:general"]').click();
        await page().locator('[data-screen-ready="settings"]').waitFor({ timeout: 10_000 });
        await page().locator('[data-nav-item="workspace"]').click();
        await page().locator('[data-screen-ready="workspace"]').waitFor({ timeout: 10_000 });
        const node = page().locator('[data-files-pane] [role="treeitem"][data-path="logo.bin"]');
        await expect(node).toBeVisible({ timeout: 10_000 });
        await node.click();
        await expect(page().locator('[data-status-bar]')).toContainText('Binary file', { timeout: 10_000 });
        const text = await monacoText(page());
        if (text.trim() !== '') throw new Error(`binary file shows text "${text.slice(0, 40)}"`);
      },
    );

    await sim.step(
      'a file over 1 MB opens read-only with a notice; the hunk bar reports the new files',
      async () => {
        await page().locator('[data-files-pane] [role="treeitem"][data-path="big.txt"]').click();
        await expect(page().locator('[data-status-bar]')).toContainText('Large file · read-only', {
          timeout: 15_000,
        });
        await sim.shot('editor-large-readonly');
        const bar = page().locator('[data-hunk-bar]');
        const barText =
          (await bar.count()) > 0 ? (await bar.innerText()).replace(/\s+/g, ' ') : '(no hunk bar)';
        return barText;
      },
    );

    await sim.step('Mark reviewed clears the hunk bar and leaves the files as they are', async () => {
      const bar = page().locator('[data-hunk-bar]');
      if ((await bar.count()) === 0) return 'no hunk bar to clear (the new files produced no hunks)';
      await bar.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
      await expect(bar).toHaveCount(0, { timeout: 10_000 });
      if (!existsSync(bigFile)) throw new Error('Mark reviewed removed big.txt');
      const m = await snapshot(sim);
      const st = Object.values(m.hunks)
        .flat()
        .filter((h) => h.file === 'big.txt')
        .map((h) => h.status);
      return `big.txt hunk status ${st.join(',') || 'none'}`;
    });
    // Tidy: the two probe files would otherwise ride along in every later snapshot.
    for (const f of [binFile, bigFile]) if (existsSync(f)) unlinkSync(f);

    // ------------------------------------------------------------------ 2. working line on the demo Claude tab
    await sim.step('a working session shows the working line with elapsed seconds that tick', async () => {
      await clickTab(page(), ids.claudeDemo);
      const line = chat().locator('[data-working-line]');
      await expect(line).toBeVisible({ timeout: 10_000 });
      const first = await line.innerText();
      // `12s` under a minute, `40m 00s` past it
      const seconds = (t: string): number => {
        const long = /(\d+)m (\d+)s/.exec(t);
        if (long) return Number(long[1]) * 60 + Number(long[2]);
        return Number(/(\d+)s/.exec(t)?.[1] ?? NaN);
      };
      const s0 = seconds(first);
      if (!Number.isFinite(s0)) throw new Error(`working line reads "${first}"`);
      // The harness freezes the clock (STYX_NOW), so the count cannot tick here; the format is what is checked.
      if (s0 > 600 && !/\d+m \d\ds/.test(first))
        sim.finding({
          severity: 'polish',
          title: 'the working line counts a long think in raw seconds',
          repro: 'open a session that has been working for a while (demo Claude tab)',
          expected: 'a readable duration once past a minute (e.g. 14m 03s)',
          observed: `"${first.replace(/\s+/g, ' ')}"`,
          where:
            'packages/core/src/copy.ts chat.working.elapsed + features/chat/stream-state.ts wholeSeconds',
        });
      return first.replace(/\s+/g, ' ');
    });

    // ------------------------------------------------------------------ 3. terminal
    let termRows: string[] = [];
    await sim.step(
      'the terminal strip opens a shell in the editor lane; a typed command prints and pwd is the lane',
      async () => {
        const term = page().locator('[data-terminal]');
        await expect(term).toContainText(`Terminal, ${lane.branch}`, { timeout: 5000 });
        // A prompt means the pty is up; xterm needs focus before keys reach it.
        await page()
          .locator('[data-terminal] .xterm-helper-textarea, [data-terminal] .xterm')
          .first()
          .click();
        const marker = `styx-sim-${process.pid}`;
        await page().keyboard.type(`echo ${marker} && pwd`);
        await page().keyboard.press('Enter');
        let rows = await terminalRows(page());
        const has = (rs: string[]) => rs.some((r) => r.includes(marker) && !r.includes('echo'));
        const deadline = Date.now() + 10_000;
        while (!has(rows) && Date.now() < deadline) {
          await page().waitForTimeout(300);
          rows = await terminalRows(page());
        }
        if (!has(rows)) {
          // WebGL renderer: rows live on a canvas. Screen-reader mode mirrors them into the DOM; a legitimate setting.
          await sim.command('settings.set', { patch: { screenReader: true } });
          await page().keyboard.type(`echo ${marker} && pwd`);
          await page().keyboard.press('Enter');
          const d2 = Date.now() + 10_000;
          while (!has(rows) && Date.now() < d2) {
            await page().waitForTimeout(300);
            rows = await terminalRows(page());
          }
          if (!has(rows))
            throw new Error(
              `no "${marker}" echoed in the terminal; rows: ${rows
                .filter((r) => r.trim())
                .slice(-6)
                .join(' | ')}`,
            );
        }
        termRows = rows;
        const at = rows.findIndex((r) => r.includes(marker) && !r.includes('echo'));
        // a long lane path wraps over several terminal rows: glue the rows up to the next prompt
        const after = rows.slice(at + 1);
        const start = after.findIndex((r) => r.trim().startsWith('/'));
        let pwd = '';
        for (const r of start === -1 ? [] : after.slice(start)) {
          if (/[%$#] ?$/.test(r.trimEnd()) && pwd !== '') break;
          if (/^\S+@\S+ /.test(r.trim())) break;
          pwd += r.trimEnd();
        }
        pwd = pwd.trim();
        if (pwd === '' || !existsSync(pwd))
          throw new Error(`no pwd line after the echo; rows: ${rows.slice(at, at + 4).join(' | ')}`);
        if (realpathSync(pwd) !== realpathSync(lane.path))
          throw new Error(`pwd ${pwd} is not the lane ${lane.path}`);
        await sim.shot('terminal-echo');
        return `pwd ${pwd}`;
      },
    );

    await sim.step(
      'the terminal handle resizes by drag and by keyboard, and the height is persisted',
      async () => {
        const term = page().locator('[data-terminal]');
        const h0 = (await term.boundingBox())?.height ?? 0;
        await drag(page(), term.locator('[role="separator"]'), 0, -60);
        const h1 = (await term.boundingBox())?.height ?? 0;
        if (!(h1 > h0 + 40)) throw new Error(`drag up 60 → ${h0} → ${h1}`);
        await term.locator('[role="separator"]').focus();
        await page().keyboard.press('ArrowUp');
        const h2 = (await term.boundingBox())?.height ?? 0;
        if (!(h2 >= h1 + 15)) throw new Error(`ArrowUp → ${h1} → ${h2}`);
        await expect
          .poll(async () => (await persistedUi(page())).paneSizes['terminal'] ?? null, { timeout: 5000 })
          .toBe(h2);
        return `${h0} → ${h1} (drag) → ${h2} (↑)`;
      },
    );

    await sim.step('the terminal survives switching to Design and back', async () => {
      await page().locator('[data-workspace-mode="design"]').click();
      await expect(page().locator('[data-design-pane]')).toBeVisible({ timeout: 10_000 });
      await expect(page().locator('[data-terminal]')).toBeVisible();
      await page().locator('[data-workspace-mode="code"]').click();
      await expect(page().locator('[data-editor-file]')).toBeVisible({ timeout: 10_000 });
      const rows = await terminalRows(page());
      const marker = `styx-sim-${process.pid}`;
      if (!rows.some((r) => r.includes(marker))) throw new Error('earlier output gone after Design → Code');
      if (termRows.length === 0) throw new Error('no rows recorded');
    });

    // ------------------------------------------------------------------ 4. chat with Codex
    await sim.step('re-detecting CLIs picks the fake codex and gemini on PATH', async () => {
      const r = await sim.command<{
        clis: { agent: string; binary: string; capabilities: Record<string, unknown> }[];
      }>('detect.clis', {});
      const clis = r.value?.clis ?? [];
      const codex = clis.find((c) => c.agent === 'codex');
      const gemini = clis.find((c) => c.agent === 'gemini');
      if (!/fixtures[/\\]bin[/\\]codex$/.test(codex?.binary ?? ''))
        throw new Error(`codex binary ${codex?.binary}`);
      if (!/fixtures[/\\]bin[/\\]gemini$/.test(gemini?.binary ?? ''))
        throw new Error(`gemini binary ${gemini?.binary}`);
      return `codex appServer=${String(codex?.capabilities['appServer'])} · gemini acp=${String(gemini?.capabilities['acp'])}`;
    });

    await sim.step('the chat + spawns Codex on acme-shop with a first message', async () => {
      await chat().getByRole('button', { name: 'Spawn agent', exact: true }).click();
      const dialog = page().getByRole('dialog');
      await expect(dialog.locator('[data-spawn-modal]')).toBeVisible({ timeout: 5000 });
      await dialog.locator('[data-agent="codex"]').click();
      await dialog.getByLabel('First message').fill('write sim-a.txt');
      await sim.shot('spawn-modal-codex');
      await dialog.getByRole('button', { name: /^Spawn/ }).click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(
          async () =>
            (await snapshot(sim)).sessions.find(
              (s) => s.agent === 'codex' && s.firstMessage === 'write sim-a.txt',
            )?.id ?? null,
          { timeout: 20_000 },
        )
        .not.toBeNull();
      const m = await snapshot(sim);
      const s = m.sessions.find((x) => x.agent === 'codex' && x.firstMessage === 'write sim-a.txt');
      if (!s) throw new Error('codex session missing');
      ids.codexNew = s.id;
      const wt = m.worktrees.find((w) => w.id === s.worktreeId);
      if (!wt) throw new Error('codex worktree missing');
      codexLane.path = wt.path;
      codexLane.branch = wt.branch ?? '';
      await expect(page().locator(`[data-nav-lane="${ids.codexNew}"]`)).toHaveAttribute('data-inv', 'true', {
        timeout: 10_000,
      });
      return `session ${s.id} runner ${s.runner} on ${codexLane.branch} (${codexLane.path})`;
    });

    await sim.step('the editor column, terminal and status bar follow the active chat tab', async () => {
      const bar = (await page().locator('[data-status-bar]').innerText()).replace(/\s+/g, ' ');
      const term = (await page().locator('[data-terminal]').innerText()).split('\n')[0] ?? '';
      if (!bar.startsWith(codexLane.branch) || !term.includes(codexLane.branch)) {
        sim.finding({
          severity: 'major',
          title:
            "files, editor, terminal and status bar stay on the first session's lane when another tab is active",
          repro: `spawn Codex on acme-shop (new lane ${codexLane.branch}); its tab is active`,
          expected: `the Workspace mirrors what the person is looking at (discrepancy #103): status bar and terminal read ${codexLane.branch}, the tree shows that lane`,
          observed: `status bar "${bar}", terminal "${term}" — the lane of the earliest live session (${lane.branch})`,
          where:
            'apps/desktop/src/renderer/screens/Workspace/Workspace.tsx editorWorktree() (earliest non-done session, not the active tab)',
        });
        throw new Error(`status bar "${bar}" / terminal "${term}" vs active lane ${codexLane.branch}`);
      }
    });

    await sim.step(
      'the first turn: user row, pong, tool row, inline approval; Allow runs the command and writes the file',
      async () => {
        await expect(chat().locator('[data-kind="user"]').filter({ hasText: 'write sim-a.txt' })).toBeVisible(
          { timeout: 20_000 },
        );
        await expect(chat().locator('[data-kind="agent"]').filter({ hasText: 'pong' })).toBeVisible({
          timeout: 20_000,
        });
        const decision = chat().locator('[data-kind="decision"]');
        await expect(decision).toBeVisible({ timeout: 20_000 });
        await expect(decision).toContainText('echo hi > sim-a.txt');
        await expect(chat().locator('[data-lane-meta]')).toContainText('waiting on you', { timeout: 10_000 });
        await expect(
          page().locator(`[data-nav-lane="${ids.codexNew}"][data-lane-status="your-turn"]`),
        ).toHaveCount(1);
        await sim.shot('codex-approval');
        await decision.getByRole('button', { name: 'Allow', exact: true }).click();
        await expect(chat().locator('[data-kind="tool"][data-status="ok"]')).toBeVisible({ timeout: 20_000 });
        const tool = chat().locator('[data-kind="tool"]').first();
        await expect(tool).toContainText('Bash');
        await expect(tool).toContainText('echo hi > sim-a.txt');
        await expect
          .poll(() => existsSync(join(codexLane.path, 'sim-a.txt')), { timeout: 10_000 })
          .toBe(true);
        await expect(chat().locator('[data-lane-meta]')).not.toContainText('waiting on you', {
          timeout: 20_000,
        });
      },
    );

    await sim.step(
      'the turn settles into a checkpoint row and the meta line reads agent · branch · age · tokens',
      async () => {
        await expect(
          chat().locator('[data-kind="system"]').filter({ hasText: 'Turn 1: 1 files changed.' }),
        ).toBeVisible({ timeout: 20_000 });
        const row = chat().locator('[data-kind="checkpoint"][data-turn="1"]');
        await expect(row).toBeVisible();
        await expect(row).toContainText('Turn 1 · 1 files · +1 −0');
        await expect(row.getByRole('button', { name: 'Review · Turn 1', exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Revert this turn · Turn 1', exact: true })).toBeEnabled(
          {
            timeout: 10_000,
          },
        );
        const meta = await chat().locator('[data-lane-meta]').innerText();
        if (!meta.startsWith(`codex · ${codexLane.branch} · `)) throw new Error(`meta "${meta}"`);
        if (!/tokens/.test(meta)) throw new Error(`meta has no token usage: "${meta}"`);
        await sim.shot('codex-checkpoint-row');
        return meta;
      },
    );

    await sim.step("Review shows the turn's patch read-only on the Diff screen; Done returns", async () => {
      await chat()
        .locator('[data-kind="checkpoint"][data-turn="1"]')
        .getByRole('button', { name: 'Review · Turn 1', exact: true })
        .click();
      const diff = page().locator('[data-diff-checkpoint]');
      await expect(diff).toBeVisible({ timeout: 10_000 });
      await expect(diff.locator('[data-diff-meta]')).toContainText('Turn 1 · 1 files · +1 −0');
      await expect(diff.locator('[data-patch-file="sim-a.txt"]')).toContainText('+ hi', { timeout: 10_000 });
      await expect(diff.getByRole('button', { name: /Revert/ })).toHaveCount(0);
      const screens = await diff.locator('[data-checkpoint-screens]').count();
      const m = await snapshot(sim);
      const cp = m.checkpoints[ids.codexNew]?.find((c) => c.turn === 1);
      await sim.shot('checkpoint-diff');
      await diff.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(chat()).toBeVisible({ timeout: 10_000 });
      return `screens section ×${screens} (checkpoint.screens ${JSON.stringify(cp?.screens ?? null)}; no design page was running, so none expected)`;
    });

    await sim.step(
      'Revert this turn asks inline, then removes the file and marks the row Reverted',
      async () => {
        const row = chat().locator('[data-kind="checkpoint"][data-turn="1"]');
        await row.getByRole('button', { name: 'Revert this turn · Turn 1', exact: true }).click();
        const ask = row.locator('[data-checkpoint-confirm]');
        await expect(ask).toContainText('Restore the workspace to before turn 1?');
        // Escape puts the actions back; ask again and confirm.
        await page().keyboard.press('Escape');
        await expect(ask).toHaveCount(0);
        await expect(
          row.getByRole('button', { name: 'Revert this turn · Turn 1', exact: true }),
        ).toBeFocused();
        await row.getByRole('button', { name: 'Revert this turn · Turn 1', exact: true }).click();
        await ask.getByRole('button', { name: 'Revert this turn · Turn 1 · Yes', exact: true }).click();
        await expect(row).toHaveAttribute('data-reverted', 'true', { timeout: 20_000 });
        await expect(row).toContainText('Reverted');
        await expect(
          chat().locator('[data-kind="system"]').filter({ hasText: 'Workspace restored to before turn 1.' }),
        ).toBeVisible({ timeout: 10_000 });
        await expect
          .poll(() => existsSync(join(codexLane.path, 'sim-a.txt')), { timeout: 10_000 })
          .toBe(false);
        if (git(['status', '--porcelain'], codexLane.path) !== '')
          throw new Error('lane not clean after revert');
      },
    );

    await sim.step(
      'a second turn, denied: the command does not run, the turn still settles, no checkpoint row',
      async () => {
        await composer().fill('write sim-b.txt');
        await composer().press('Enter');
        const decision = chat().locator('[data-kind="decision"]').last();
        await expect(decision).toContainText('echo hi > sim-b.txt', { timeout: 20_000 });
        const stop = page().locator('[data-session-control="stop"]');
        await expect(stop).toBeVisible({ timeout: 5000 });
        await expect(stop).toHaveText('Stop · esc');
        await decision.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(chat().locator('[data-lane-meta]')).not.toContainText('waiting on you', {
          timeout: 20_000,
        });
        await expect
          .poll(
            async () => (await snapshot(sim)).sessions.find((s) => s.id === ids.codexNew)?.state ?? null,
            { timeout: 20_000 },
          )
          .toBe('idle');
        const tool = chat().locator('[data-kind="tool"]').last();
        const status = await tool.getAttribute('data-status');
        if (status === 'ok') throw new Error('denied command shows as ok');
        if (existsSync(join(codexLane.path, 'sim-b.txt'))) throw new Error('denied command wrote the file');
        const rows = await chat().locator('[data-kind="checkpoint"][data-turn="2"]').count();
        await sim.shot('codex-denied');
        return `tool status ${status} · turn-2 checkpoint rows ${rows}`;
      },
    );

    await sim.step(
      "controls row: Permissions / Model / Effort selects with the CLI's catalogue; a mode change is said in the chat",
      async () => {
        const mode = page().locator('[data-session-control="permissionMode"]');
        const model = page().locator('[data-session-control="model"]');
        const effort = page().locator('[data-session-control="effort"]');
        for (const c of [mode, model, effort]) await expect(c).toBeVisible({ timeout: 5000 });
        const models = await model.locator('option').allTextContents();
        if (!models.includes('GPT-6 Astra') || !models.includes('GPT-5.5'))
          throw new Error(`model options ${models.join(',')}`);
        const efforts0 = await effort.locator('option').allTextContents();
        if (!efforts0.some((e) => /ultra/i.test(e)))
          throw new Error(`GPT-6 Astra efforts ${efforts0.join(',')} (no ultra)`);
        await mode.selectOption('bypassPermissions');
        await expect(
          chat()
            .locator('[data-kind="system"]')
            .filter({ hasText: /permissions: Bypass/ }),
        ).toBeVisible({ timeout: 10_000 });
        await mode.selectOption('default');
        await expect(
          chat()
            .locator('[data-kind="system"]')
            .filter({ hasText: /permissions: Ask/ }),
        ).toBeVisible({ timeout: 10_000 });
        await model.selectOption('gpt-5.5');
        await expect
          .poll(
            async () => (await snapshot(sim)).sessions.find((s) => s.id === ids.codexNew)?.model ?? null,
            { timeout: 10_000 },
          )
          .toBe('gpt-5.5');
        const modelLine = await chat()
          .locator('[data-kind="system"]')
          .filter({ hasText: /model: / })
          .count();
        const efforts1 = await effort.locator('option').allTextContents();
        if (efforts1.some((e) => /ultra/i.test(e)))
          throw new Error(`GPT-5.5 still offers ultra: ${efforts1.join(',')}`);
        await effort.selectOption('high');
        await expect
          .poll(
            async () => (await snapshot(sim)).sessions.find((s) => s.id === ids.codexNew)?.effort ?? null,
            { timeout: 10_000 },
          )
          .toBe('high');
        const errors = await chat()
          .locator('[data-kind="system"]')
          .filter({ hasText: /error|refused|no equivalent/ })
          .count();
        await sim.shot('codex-controls');
        return `models ${models.join('/')} · efforts ${efforts0.join('/')} → ${efforts1.join('/')} · "model:" lines ${modelLine} · error lines ${errors}`;
      },
    );

    // ------------------------------------------------------------------ 5. steer (Codex) / queue (Gemini)
    await sim.step(
      'Codex mid-turn: the send hint reads Steer and a second message joins the running turn, never queued',
      async () => {
        await composer().fill('write sim-c.txt');
        await composer().press('Enter');
        const decision = chat().locator('[data-kind="decision"]').last();
        await expect(decision).toContainText('echo hi > sim-c.txt', { timeout: 20_000 });
        const send = page().locator('[data-composer-send]');
        await expect(send).toHaveText('Steer', { timeout: 5000 });
        const title = await send.getAttribute('title');
        await composer().fill('also lint');
        await composer().press('Enter');
        await expect(chat().locator('[data-kind="user"]').filter({ hasText: 'also lint' })).toBeVisible({
          timeout: 20_000,
        });
        await expect(
          chat().locator('[data-kind="agent"]').filter({ hasText: 'steered: also lint' }),
        ).toBeVisible({ timeout: 20_000 });
        await expect(chat().locator('[data-queued]')).toHaveCount(0);
        await expect(composer()).toHaveValue('');
        await sim.shot('codex-steered');
        await decision.getByRole('button', { name: 'Allow', exact: true }).click();
        // the turn number depends on how many turns went before (a denied one counts); one file changed is the point
        await expect(
          chat()
            .locator('[data-kind="system"]')
            .filter({ hasText: /Turn \d+: 1 files changed\./ })
            .last(),
        ).toBeVisible({ timeout: 20_000 });
        await expect(chat().locator('[data-kind="checkpoint"]').last()).toBeVisible();
        return `steer title "${title}"`;
      },
    );

    await sim.step('the chat + spawns Gemini; mid-turn the send hint reads Queue', async () => {
      await chat().getByRole('button', { name: 'Spawn agent', exact: true }).click();
      const dialog = page().getByRole('dialog');
      await expect(dialog.locator('[data-spawn-modal]')).toBeVisible({ timeout: 5000 });
      await dialog.locator('[data-agent="gemini"]').click();
      await dialog.getByLabel('First message').fill('hi');
      await dialog.getByRole('button', { name: /^Spawn/ }).click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(
          async () =>
            (await snapshot(sim)).sessions.find((s) => s.agent === 'gemini' && s.firstMessage === 'hi')?.id ??
            null,
          { timeout: 20_000 },
        )
        .not.toBeNull();
      ids.geminiNew =
        (await snapshot(sim)).sessions.find((s) => s.agent === 'gemini' && s.firstMessage === 'hi')?.id ?? '';
      await expect(page().locator(`[data-nav-lane="${ids.geminiNew}"]`)).toHaveAttribute('data-inv', 'true', {
        timeout: 10_000,
      });
      await expect(chat().locator('[data-kind="agent"]').filter({ hasText: 'pong' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(chat().locator('[data-kind="decision"]')).toBeVisible({ timeout: 20_000 });
      const send = page().locator('[data-composer-send]');
      await expect(send).toHaveText('Queue', { timeout: 5000 });
      const title = await send.getAttribute('title');
      if (title !== null && /Claude Code/.test(title))
        sim.finding({
          severity: 'minor',
          title: 'the Queue hint names Claude Code on a Gemini session',
          repro: 'spawn Gemini; while its turn waits on the approval, hover the Queue send button',
          expected: 'a hint about this agent (Gemini takes it after this turn) or a neutral one',
          observed: `title "${title}"`,
          where:
            'packages/core/src/copy.ts queue.queueHint (one string for every queue runner); features/chat/ChatPane.tsx sendTitle',
        });
      return `queue title "${title}"`;
    });

    await sim.step(
      'Gemini mid-turn: a message queues as a dashed bubble; Take back returns it; it goes out when the turn settles',
      async () => {
        const decision = chat().locator('[data-kind="decision"]').first();
        await composer().fill('and then the tests');
        await composer().press('Enter');
        const queued = chat().locator('[data-queued]');
        await expect(queued).toHaveCount(1, { timeout: 10_000 });
        await expect(queued).toContainText('and then the tests');
        await expect(queued).toContainText('Queued · Sent when the agent finishes this turn.');
        await expect(
          chat().locator('[data-kind="user"]').filter({ hasText: 'and then the tests' }),
        ).toHaveCount(0);
        await expect(composer()).toHaveValue('');
        const dashed = await queued.evaluate((el) => getComputedStyle(el).borderStyle);
        await sim.shot('gemini-queued');
        await queued.getByRole('button', { name: 'Take back', exact: true }).click();
        await expect(queued).toHaveCount(0, { timeout: 10_000 });
        await expect(composer()).toHaveValue('and then the tests');
        await expect(composer()).toBeFocused();
        await composer().press('Enter');
        await expect(queued).toHaveCount(1, { timeout: 10_000 });
        await decision.getByRole('button', { name: 'Allow', exact: true }).click();
        await expect(
          chat().locator('[data-kind="user"]').filter({ hasText: 'and then the tests' }),
        ).toBeVisible({ timeout: 20_000 });
        await expect(queued).toHaveCount(0);
        await expect(chat().locator('[data-kind="decision"]')).toHaveCount(2, { timeout: 20_000 });
        // Settle the second turn too, so the tab can be closed cleanly later.
        await chat()
          .locator('[data-kind="decision"]')
          .last()
          .getByRole('button', { name: 'Allow', exact: true })
          .click();
        await expect
          .poll(
            async () => (await snapshot(sim)).sessions.find((s) => s.id === ids.geminiNew)?.state ?? null,
            { timeout: 20_000 },
          )
          .toBe('idle');
        return `bubble border-style ${dashed}`;
      },
    );

    // ------------------------------------------------------------------ 6. composer
    await sim.step(
      "the draft is per session: tab switches and a trip to Settings keep each tab's text",
      async () => {
        await clickTab(page(), ids.codexNew);
        await expect(page().locator(`[data-nav-lane="${ids.codexNew}"]`)).toHaveAttribute('data-inv', 'true');
        await composer().fill('draft for codex');
        await clickTab(page(), ids.geminiNew);
        await expect(composer()).toHaveValue('', { timeout: 5000 });
        await composer().fill('draft for gemini');
        await clickTab(page(), ids.codexNew);
        await expect(composer()).toHaveValue('draft for codex', { timeout: 5000 });
        await page().locator('[data-app-rail-item="app:general"]').click();
        await page().locator('[data-screen-ready="settings"]').waitFor({ timeout: 10_000 });
        await page().locator('[data-nav-item="workspace"]').click();
        await page().locator('[data-screen-ready="workspace"]').waitFor({ timeout: 10_000 });
        await expect(composer()).toHaveValue('draft for codex', { timeout: 5000 });
        await clickTab(page(), ids.geminiNew);
        await expect(composer()).toHaveValue('draft for gemini', { timeout: 5000 });
        await composer().fill('');
        await clickTab(page(), ids.codexNew);
        await expect(composer()).toHaveValue('draft for codex', { timeout: 5000 });
        await composer().fill('');
      },
    );

    await sim.step(
      "@ opens the file picker for the session's lane; Enter inserts the path and a file chip",
      async () => {
        await composer().click();
        await composer().type('@check');
        const popup = page().locator('[data-composer-popup="mention"]');
        await expect(popup).toBeVisible({ timeout: 5000 });
        await expect(popup.locator('[role="option"]').filter({ hasText: 'checkout.ts' }).first()).toBeVisible(
          { timeout: 5000 },
        );
        const hint = await popup.innerText();
        await sim.shot('composer-mention');
        // Pick checkout.ts wherever it sits in the list.
        const options = await popup.locator('[role="option"]').allTextContents();
        const at = options.findIndex((o) => o.trim() === 'checkout.ts' || o.includes('checkout.ts'));
        for (let i = 0; i < at; i += 1) await page().keyboard.press('ArrowDown');
        await page().keyboard.press('Enter');
        await expect(popup).toHaveCount(0);
        await expect(composer()).toHaveValue(/^@\S*checkout\.ts $/);
        const chips = page().locator('[data-composer-attachments] [data-kind="file"]');
        await expect(chips).toHaveCount(1, { timeout: 5000 });
        await chips
          .first()
          .getByRole('button', { name: /^Remove / })
          .click();
        await expect(page().locator('[data-composer-attachments]')).toHaveCount(0);
        await composer().fill('');
        return `hint "${hint.split('\n')[0]}" · options ${options.length}`;
      },
    );

    await sim.step(
      '/ opens the slash commands the agent reports (Gemini: /help /memory); Escape closes only the popup',
      async () => {
        await clickTab(page(), ids.geminiNew);
        await composer().click();
        await composer().fill(''); // whatever an earlier step left in this tab's draft
        await composer().type('/');
        const popup = page().locator('[data-composer-popup="slash"]');
        await expect(popup).toBeVisible({ timeout: 5000 });
        const options = await popup.locator('[role="option"]').allTextContents();
        if (!options.some((o) => o.includes('help')) || !options.some((o) => o.includes('memory')))
          throw new Error(`slash options ${options.join(',')}`);
        const hint = (await popup.innerText()).split('\n')[0] ?? '';
        await page().keyboard.press('ArrowDown');
        await page().keyboard.press('Enter');
        await expect(composer()).toHaveValue('/memory ');
        await composer().fill('');
        await composer().type('/he');
        await expect(popup).toBeVisible({ timeout: 5000 });
        await page().keyboard.press('Escape');
        await expect(popup).toHaveCount(0);
        await expect(composer()).toHaveValue('/he');
        await expect(chat().locator('[data-kind="system"]').filter({ hasText: 'interrupted' })).toHaveCount(
          0,
        );
        await composer().fill('');
        if (/Claude Code/.test(hint))
          sim.finding({
            severity: 'minor',
            title: 'the slash popup is titled "Claude Code commands" on a Gemini session',
            repro: 'Gemini tab, type /',
            expected: 'the agent\'s name (Gemini commands) or "Commands"',
            observed: `popup hint "${hint}"`,
            where: 'packages/core/src/copy.ts chat.slash.hint',
          });
        // Codex: what does its popup report?
        await clickTab(page(), ids.codexNew);
        await composer().click();
        await composer().type('/');
        const codexPopup = await page().locator('[data-composer-popup="slash"]').count();
        const codexOptions =
          codexPopup > 0
            ? await page().locator('[data-composer-popup="slash"] [role="option"]').allTextContents()
            : [];
        await page().keyboard.press('Escape');
        await composer().fill('');
        return `gemini hint "${hint}" · codex popup ${codexPopup > 0 ? codexOptions.join(',') : 'none'}`;
      },
    );

    await sim.step('a pasted image becomes a chip; sent, the user row shows the attachment', async () => {
      await composer().click();
      await attachImage(page(), 'paste', 'sim-paste.png');
      const chip = page().locator('[data-composer-attachments] [data-kind="image"]');
      await expect(chip).toHaveCount(1, { timeout: 10_000 });
      await expect(chip).toContainText('sim-paste.png');
      await composer().fill('see the image');
      await composer().press('Enter');
      const row = chat().locator('[data-kind="user"]').filter({ hasText: 'see the image' });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.locator('[data-message-attachments]')).toContainText('sim-paste.png');
      await expect(page().locator('[data-composer-attachments]')).toHaveCount(0);
      await sim.shot('composer-attachment-sent');
      // The fake answers with its scripted ask (whichever tab this is on); allow it so the session settles.
      const activeTab =
        (await page().locator('[data-nav-lane][aria-current="page"]').getAttribute('data-nav-lane')) ??
        ids.codexNew;
      const decision = chat().locator('[data-kind="decision"]').last();
      await expect(decision.getByRole('button', { name: 'Allow', exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await decision.getByRole('button', { name: 'Allow', exact: true }).click();
      await expect
        .poll(async () => (await snapshot(sim)).sessions.find((s) => s.id === activeTab)?.state ?? null, {
          timeout: 20_000,
        })
        .toBe('idle');
    });

    await sim.step('a dropped image becomes a chip too; × removes it', async () => {
      await attachImage(page(), 'drop', 'sim-drop.png');
      const chip = page().locator('[data-composer-attachments] [data-kind="image"]');
      await expect(chip).toHaveCount(1, { timeout: 10_000 });
      await expect(chip).toContainText('sim-drop.png');
      await chip.getByRole('button', { name: 'Remove sim-drop.png', exact: true }).click();
      await expect(page().locator('[data-composer-attachments]')).toHaveCount(0);
    });

    await sim.step(
      'Shift+Enter inserts a newline without sending; Escape while idle does nothing',
      async () => {
        // idle first: an earlier step may have left the fake mid-turn, and Esc mid-turn is Stop by design
        await expect
          .poll(
            async () => (await snapshot(sim)).sessions.find((s) => s.id === ids.geminiNew)?.state ?? null,
            { timeout: 20_000 },
          )
          .toBe('idle');
        const before = await chat().locator('[data-kind="user"]').count();
        const interruptedBefore = await chat()
          .locator('[data-kind="system"]')
          .filter({ hasText: 'interrupted' })
          .count();
        await composer().click();
        await composer().fill('');
        await composer().type('line one');
        await page().keyboard.press('Shift+Enter');
        await composer().type('line two');
        await expect(composer()).toHaveValue('line one\nline two');
        await page().keyboard.press('Escape');
        await page().waitForTimeout(300);
        await expect(composer()).toHaveValue('line one\nline two');
        if ((await chat().locator('[data-kind="user"]').count()) !== before)
          throw new Error('Shift+Enter or Escape sent the message');
        await expect(chat().locator('[data-kind="system"]').filter({ hasText: 'interrupted' })).toHaveCount(
          interruptedBefore,
        );
        await composer().fill('');
      },
    );

    await sim.step('Escape closes the spawn modal and returns focus to the + that opened it', async () => {
      const plus = chat().getByRole('button', { name: 'Spawn agent', exact: true });
      await plus.click();
      await expect(page().getByRole('dialog')).toBeVisible({ timeout: 5000 });
      await page().keyboard.press('Escape');
      await expect(page().getByRole('dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(plus).toBeFocused({ timeout: 3000 });
    });

    // ------------------------------------------------------------------ 7. tabs
    await sim.step(
      'five live sessions: the nav lists every lane, your turn first, and the open one is current',
      async () => {
        const lanes = page().locator('[data-nav-lane]');
        await expect(lanes).toHaveCount(5, { timeout: 5000 });
        const statuses = await lanes.evaluateAll((els) => els.map((e) => e.getAttribute('data-lane-status')));
        const firstOther = statuses.findIndex((x) => x !== 'your-turn');
        if (statuses.slice(firstOther).includes('your-turn'))
          sim.finding({
            severity: 'major',
            title: 'a lane waiting on you is listed below one that is not',
            repro: 'five live sessions in acme-shop',
            expected: 'every "Your turn" lane first',
            observed: statuses.join(' | '),
          });
        await lanes.nth(1).click();
        await expect(lanes.nth(1)).toHaveAttribute('aria-current', 'page');
      },
    );

    await sim.step('tab dots: working = text, needs-you = accent with !, idle = line', async () => {
      const tone = async (id: string) => {
        const tab = page().locator(`[data-nav-lane="${id}"]`);
        if ((await tab.count()) === 0) return 'not-visible';
        const dot = tab.locator('[data-tone]');
        return (await dot.count()) === 0 ? 'no-dot' : ((await dot.first().getAttribute('data-tone')) ?? '?');
      };
      await clickTab(page(), ids.codexNew);
      const seen: Record<string, string> = {};
      for (const [name, id] of Object.entries(ids)) {
        if (id === '') continue;
        seen[name] = await tone(id);
      }
      // The demo Claude (working) and demo Codex (needs-you) sit in the first two slots.
      if (seen['claudeDemo'] !== 'text') throw new Error(`working tab dot ${seen['claudeDemo']}`);
      if (seen['codexDemo'] !== 'accent') throw new Error(`needs-you tab dot ${seen['codexDemo']}`);
      await expect(
        page().locator(`[data-nav-lane="${ids.codexDemo}"][data-lane-status="your-turn"]`),
      ).toHaveCount(1);
      if (seen['codexNew'] !== 'line') throw new Error(`idle tab dot ${seen['codexNew']}`);
      return JSON.stringify(seen);
    });

    await sim.step(
      '⤢ pops the chat into a 400×500 window with its own titlebar; the main pane says Popped out',
      async () => {
        const opened = sim.app.waitForEvent('window', { timeout: 15_000 });
        await chat().getByRole('button', { name: 'Pop out chat', exact: true }).click();
        const popout = await opened;
        await popout.waitForLoadState('domcontentloaded');
        await expect(popout.locator('[data-screen-ready="popout"]')).toBeAttached({ timeout: 20_000 });
        const size = await popout.evaluate(() => [window.innerWidth, window.innerHeight]);
        const title = await popout.title();
        await expect(popout.locator('[data-chat-compact="true"]')).toBeVisible();
        await expect(popout.getByRole('tab')).toHaveCount(0);
        const banner = popout.getByRole('banner');
        await expect(banner.getByText('Codex', { exact: true })).toBeVisible();
        await expect(banner.getByText(`acme-shop · ${codexLane.branch}`)).toBeVisible();
        await expect(banner.getByRole('button', { name: 'Dock', exact: true })).toBeVisible();
        await expect(popout.getByText('steered: also lint')).toBeVisible();
        await expect(chat().getByText('Popped out')).toBeVisible({ timeout: 5000 });
        await expect(chat().getByRole('button', { name: 'Dock', exact: true })).toBeVisible();
        await expect(composer()).toBeDisabled();
        await popout
          .screenshot({ path: join(__dirname, 'out', 'workspace-chat', 'popout-window.png') })
          .catch(() => undefined);
        // Mod+Shift+O inside the pop-out docks it.
        const closed = popout.waitForEvent('close', { timeout: 10_000 });
        await popout.locator('textarea').focus();
        await Promise.all([closed, popout.keyboard.press(`${MOD}+Shift+KeyO`).catch(() => undefined)]);
        await expect(chat().getByText('Popped out')).toHaveCount(0, { timeout: 5000 });
        await expect(composer()).toBeEnabled();
        return `pop-out ${size.join('×')} · window title "${title}"`;
      },
    );

    await sim.step(
      "Mod+Shift+O in the main window pops out; the pop-out's Dock button brings it back",
      async () => {
        await composer().click();
        const opened = sim.app.waitForEvent('window', { timeout: 15_000 });
        await page().keyboard.press(`${MOD}+Shift+KeyO`);
        const popout = await opened;
        await expect(popout.locator('[data-screen-ready="popout"]')).toBeAttached({ timeout: 20_000 });
        const closed = popout.waitForEvent('close', { timeout: 10_000 });
        await popout.getByRole('banner').getByRole('button', { name: 'Dock', exact: true }).click();
        await closed;
        await expect(chat().getByText('Popped out')).toHaveCount(0, { timeout: 5000 });
        expect(sim.app.windows()).toHaveLength(1);
      },
    );

    await sim.step('✕ on a tab closes the session (ends + archives) and the tab goes away', async () => {
      await clickTab(page(), ids.geminiNew);
      const tab = page().locator(`[data-nav-lane="${ids.geminiNew}"]`);
      await expect(tab).toHaveAttribute('data-inv', 'true');
      await tab.locator('[data-tab-close]').click();
      const dialogs = await page().getByRole('dialog').count();
      await expect(tab).toHaveCount(0, { timeout: 10_000 });
      const s = (await snapshot(sim)).sessions.find((x) => x.id === ids.geminiNew);
      if (dialogs === 0)
        sim.finding({
          severity: 'polish',
          title: 'closing a chat tab ends and archives the session with no confirmation',
          repro: 'click ✕ on a live session tab',
          expected:
            'a confirm (the session is ended and archived: its process is killed, its transcript leaves the chat) or an undo',
          observed: `the tab disappears at once; session state ${s?.state ?? 'gone'}, archivedAt ${s?.archivedAt ?? 'null'}`,
          where:
            'apps/desktop/src/renderer/features/chat/ChatPane.tsx closeSession → session.close (discrepancy #60)',
        });
      return `confirm dialogs ${dialogs} · session state ${s?.state ?? 'gone'} archived ${s?.archivedAt !== null && s?.archivedAt !== undefined}`;
    });

    // ------------------------------------------------------------------ 8. resize handles + persistence
    let chatW = 0;
    let termH = 0;
    await sim.step(
      'the chat handle resizes by drag and ← / →; the files pane has no handle (spec: fixed 200)',
      async () => {
        const pane = chat();
        const w0 = (await pane.boundingBox())?.width ?? 0;
        await drag(page(), page().locator('[data-chat-resize]'), -80, 0);
        const w1 = (await pane.boundingBox())?.width ?? 0;
        if (!(w1 > w0 + 60)) throw new Error(`drag left 80 → ${w0} → ${w1}`);
        await page().locator('[data-chat-resize]').focus();
        await page().keyboard.press('ArrowLeft');
        const w2 = (await pane.boundingBox())?.width ?? 0;
        if (!(w2 >= w1 + 15)) throw new Error(`ArrowLeft → ${w1} → ${w2}`);
        chatW = w2;
        termH = (await page().locator('[data-terminal]').boundingBox())?.height ?? 0;
        const filesHandles = await page().locator('[data-files-pane] [role="separator"]').count();
        const filesW = (await page().locator('[data-files-pane]').boundingBox())?.width ?? 0;
        await expect
          .poll(async () => (await persistedUi(page())).paneSizes['chat'] ?? null, { timeout: 5000 })
          .toBe(w2);
        await sim.shot('resized-panes');
        return `chat ${w0} → ${w1} → ${w2} · terminal ${termH} · files ${filesW} handles ${filesHandles}`;
      },
    );

    await sim.step('pane sizes survive a relaunch on the same data dir', async () => {
      const userData = sim.userData;
      await sim.relaunch({ screen: 'workspace', env: { STYX_USER_DATA: userData } });
      await page().waitForSelector('[data-screen-ready="workspace"]', { timeout: 30_000 });
      const m = await snapshot(sim);
      const sameDb = m.sessions.some((s) => s.id === ids.codexNew);
      if (!sameDb) return 'relaunch opened a fresh data dir; persistence not observable here (harness)';
      const w = (await chat().boundingBox())?.width ?? 0;
      const h = (await page().locator('[data-terminal]').boundingBox())?.height ?? 0;
      if (Math.abs(w - chatW) > 1) throw new Error(`chat width ${w} after relaunch, was ${chatW}`);
      if (Math.abs(h - termH) > 1) throw new Error(`terminal height ${h} after relaunch, was ${termH}`);
      await sim.shot('after-relaunch');
      return `chat ${w} · terminal ${h} · Codex session ${sameDb ? 'still there' : 'gone'}`;
    });

    // ------------------------------------------------------------------ 9. minimum window, toasts
    await sim.step(
      'at the 1100×680 minimum nothing overflows: files, editor, terminal, chat and send stay in view',
      async () => {
        const min = await sim.app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0];
          if (!w) throw new Error('no window');
          const m = w.getMinimumSize();
          w.setContentSize(1100, 680);
          return m;
        });
        await expect
          .poll(() => page().evaluate(() => [window.innerWidth, window.innerHeight]), { timeout: 5000 })
          .toEqual([1100, 680]);
        await page().waitForTimeout(300);
        const overflow = await page().evaluate(() => ({
          x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        }));
        const inView = async (sel: string) => {
          const b = await page().locator(sel).first().boundingBox();
          return b !== null && b.x >= 0 && b.y >= 0 && b.x + b.width <= 1100.5 && b.y + b.height <= 680.5;
        };
        const parts: Record<string, boolean> = {};
        for (const sel of [
          '[data-files-pane]',
          '[data-editor-file]',
          '[data-terminal]',
          '[data-chat-pane]',
          '[data-composer-send]',
          '[data-status-bar]',
        ])
          parts[sel] = await inView(sel);
        await sim.shot('min-window-1100x680');
        const bad = Object.entries(parts)
          .filter(([, ok]) => !ok)
          .map(([k]) => k);
        if (overflow.x > 0 || overflow.y > 0 || bad.length > 0)
          throw new Error(`overflow ${JSON.stringify(overflow)} · out of view ${bad.join(', ')}`);
        return `min size ${min.join('×')}`;
      },
    );

    await sim.step('no toast is left on screen at the end', async () => {
      const toasts = page().locator('[data-toast]');
      const n = await toasts.count();
      if (n === 0) return 'none';
      const texts = await toasts.allInnerTexts();
      await page().waitForTimeout(8500);
      const left = await toasts.count();
      if (left > 0) throw new Error(`${left} toast(s) still up after 8.5 s: ${texts.join(' | ')}`);
      return `${n} toast(s) seen (${texts.join(' | ')}), all gone within the ttl`;
    });
  });
});
