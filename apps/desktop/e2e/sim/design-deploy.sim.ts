/**
 * User simulation · the Design window (Run locally, the live page, device presets, the simulator mirror), Deploy
 * (button, modal, setup) and Targets (Connect target for every provider, health, env & secrets, policies).
 *
 * Conditions this run adds on top of the harness, and why:
 * - PATH is rebuilt from the e2e fakes + system dirs, and SHELL is /bin/sh. The shell this sim is launched from is
 *   itself a Styx agent session: its PATH starts with the real install's shim dir (`vercel`, `gcloud`, `aws`,
 *   `supabase`, `gh`, `ssh` → `styx wrap`), `.zshrc` adds a real Google Cloud SDK, and STYX_* broker variables
 *   are set. Left alone, the app under test would find those and a "deploy" would go through the real app's
 *   broker. With a clean PATH and a login shell that does not source `.zshrc`, provider CLIs are absent — the
 *   owner's stated premise — and nothing real can be called.
 * - `shell.openExternal` is replaced inside the app's main process so "Open in browser" and the OAuth "Open
 *   browser" are recorded instead of opening the owner's browser.
 * - Nothing here performs a network call on purpose: Test connection / Refresh on token targets (Vercel,
 *   Supabase, GitHub PAT) and Save on AWS / GCP keys would call the provider's API, so those are observed up to
 *   the click that would leave the machine and then left alone.
 */
import { fixtures } from '@styx/core';
import { test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSim } from './harness';

const { ids } = fixtures;
const PORT = 3999;
const PORT_B = 4999;
const FIXTURES_BIN = resolve(__dirname, '../fixtures/bin');
const CLEAN_PATH = [
  FIXTURES_BIN,
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

const SECRET_KEY = /(secret|token|password|passphrase|private[_-]?key|credential)/i;

/** The dev script the seeded repo gets: really listens, serves a titled HTML page, prints the URL. */
const devScript = (port: number, title: string) =>
  `node -e "require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html');s.end('<html><head><title>${title}</title></head><body>${title} PAGE OK</body></html>')}).listen(${port},()=>console.log('ready http://localhost:${port}'))"`;

const webPackage = (name: string, port: number, title: string) =>
  JSON.stringify({ name, private: true, scripts: { dev: devScript(port, title) } }, null, 2);
const expoPackage = (name: string) =>
  JSON.stringify(
    { name, private: true, dependencies: { expo: '^54.0.0' }, scripts: { dev: 'echo metro' } },
    null,
    2,
  );

const listeners = (port: number): string => {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '')
      .join('; ');
  } catch {
    return '';
  }
};

const findSecretKeys = (v: unknown, path: string[] = []): string[] => {
  if (Array.isArray(v)) return v.flatMap((x, i) => findSecretKeys(x, [...path, String(i)]));
  if (v !== null && typeof v === 'object')
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
      ...(SECRET_KEY.test(k) && k !== 'credentialRef' ? [[...path, k].join('.')] : []),
      ...findSecretKeys(x, [...path, k]),
    ]);
  return [];
};

const expect = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value or `ms` elapses; returns the last value either way. */
async function until<T>(fn: () => Promise<T>, ms = 8000, every = 150): Promise<T> {
  const t0 = Date.now();
  let last: T = await fn();
  while (!last && Date.now() - t0 < ms) {
    await wait(every);
    last = await fn();
  }
  return last;
}

test('sim: design-deploy', async () => {
  const simDir = mkdtempSync(join(tmpdir(), 'styx-sim-fake-sim-'));
  await runSim(
    'design-deploy',
    {
      screen: 'workspace',
      env: {
        PATH: CLEAN_PATH,
        SHELL: '/bin/sh',
        STYX_FAKE_SIM_DIR: simDir,
        // Leaked from the launching shell (a Styx agent session): neither the app nor its children may inherit them.
        STYX_BROKER: '',
        STYX_TOKEN: '',
        STYX_SESSION_ID: '',
        STYX_PROJECT_ID: '',
        STYX_WORKTREE: '',
        STYX_SHIM_DIR: '',
        STYX_CLI: '',
        STYX_EXE: '',
      },
    },
    async (sim) => {
      const page = () => sim.page;
      const cmd = sim.command;
      const acme = ids.project.acmeShop;
      const blog = ids.project.blogV2;
      const lane = join(sim.userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'fix-checkout');
      const acmeMain = join(sim.userData, 'demo-repos', 'acme-shop');
      const blogLane = join(sim.userData, 'demo-repos', '.styx', 'worktrees', 'blog-v2', 'feat-mdx');
      const projectFile = join(acmeMain, '.styx', 'project.json');

      // --- helpers over the Electron app ------------------------------------------------------------------
      const preview = (port: number) =>
        sim.app.evaluate(async ({ webContents }, p: number) => {
          const w = webContents.getAllWebContents().find((x) => x.getURL().includes(`:${p}`));
          if (w === undefined) return null;
          const js = async (code: string) => {
            try {
              return (await w.executeJavaScript(code)) as unknown;
            } catch {
              return null;
            }
          };
          return {
            title: w.getTitle(),
            url: w.getURL(),
            body: String((await js('document.body && document.body.innerText')) ?? ''),
            width: Number((await js('window.innerWidth')) ?? -1),
            height: Number((await js('window.innerHeight')) ?? -1),
            zoom: w.getZoomFactor(),
          };
        }, port);
      const nativeView = () =>
        sim.app.evaluate(({ BaseWindow }) => {
          // the design view is a child view of whichever window shows the workspace (window order is not fixed)
          for (const win of BaseWindow.getAllWindows()) {
            for (const child of win.contentView.children) {
              const b = child.getBounds();
              if (child.getVisible() && b.width > 0 && b.height > 0)
                return { x: b.x, y: b.y, width: b.width, height: b.height };
            }
          }
          return null;
        });
      const opened = () => sim.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);
      const snapshot = async () => {
        const r = await cmd<{
          sessions: {
            id: string;
            purpose: string | null;
            state: string;
            agent: string;
            exitCode: number | null;
          }[];
          targets: {
            id: string;
            name: string;
            env: string;
            policy: string;
            config: Record<string, unknown>;
            health: unknown;
            credentialRef: string | null;
          }[];
          projects: { id: string; name: string; settings?: Record<string, unknown> }[];
          grants: { id: string; targetId: string; state: string; sessionId: string | null }[];
          runs: Record<
            string,
            { phase: string; url: string | null; exitCode: number | null; command: string; platform: string }
          >;
          devices: Record<string, { phase: string; deviceName: string; mirror: string }>;
          deploys: Record<string, { phase: string; error: string | null; exitCode: number | null }>;
        }>('store.snapshot', {});
        expect(r.ok, `store.snapshot failed: ${r.error?.message}`);
        return r.value!;
      };
      const settingsOf = async (projectId: string) => {
        // effective settings ride in `settings.project[<id>]` as { key: { value, source } }; flatten to values
        const s = (await snapshot()) as unknown as {
          settings?: { project?: Record<string, Record<string, { value: unknown }>> };
        };
        const eff = s.settings?.project?.[projectId] ?? {};
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(eff)) out[k] = v?.value;
        return out;
      };
      const audit = async (targetId: string) => {
        const r = await cmd<{
          entries: {
            action: string;
            actorKind: string;
            actorLabel: string;
            triggeredBy: string;
            detail: Record<string, unknown>;
          }[];
        }>('audit.list', { targetId, limit: 50, cursor: null });
        return r.ok ? r.value!.entries : [];
      };
      const designTab = async () => {
        await page().waitForSelector('[data-workspace-mode="design"]', { timeout: 15_000 });
        const tab = page().locator('[data-workspace-mode="design"]');
        if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
        await page().waitForSelector('[data-design-pane]', { timeout: 10_000 });
      };
      const url = () => page().getByLabel('Dev server URL');
      const setUrl = async (value: string) => {
        await url().fill(value);
        await url().press('Enter');
      };
      const hole = () => page().locator('[data-preview-hole]');
      const stopTaskIfRunning = async () => {
        const dialog = page().locator('[data-task-dialog]');
        if ((await dialog.count()) === 0) return;
        const stop = dialog.getByRole('button', { name: 'Stop task' });
        if ((await stop.count()) > 0) await stop.click();
      };
      const closeTaskDialog = async () => {
        const dialog = page().locator('[data-task-dialog]');
        if ((await dialog.count()) === 0) return;
        const btn = dialog.getByRole('button', { name: /Close|Continue in background/ }).last();
        if ((await btn.count()) > 0) await btn.click();
      };

      // Intercept the OS browser before anything can open it.
      const intercepted = await sim.app
        .evaluate(({ shell }) => {
          const g = globalThis as { __opened?: string[] };
          g.__opened = [];
          const fake = async (u: string) => {
            g.__opened?.push(u);
          };
          try {
            Object.defineProperty(shell, 'openExternal', { value: fake, configurable: true, writable: true });
          } catch {
            (shell as { openExternal: unknown }).openExternal = fake;
          }
          return shell.openExternal === fake;
        })
        .catch(() => false);

      // Fresh repo seeds: the lane the workspace shows (Claude's fix/checkout) gets a dev server; blog-v2's lane too.
      expect(existsSync(lane), `lane missing on disk: ${lane}`);
      writeFileSync(join(lane, 'package.json'), webPackage('acme-shop', PORT, 'ACME DEV'));
      if (existsSync(blogLane))
        writeFileSync(join(blogLane, 'package.json'), webPackage('blog-v2', PORT_B, 'BLOG DEV'));

      // =====================================================================================================
      // 1 · Design tab, URL field
      // =====================================================================================================
      // xterm paints to a canvas; the run output strip is read through the accessibility tree, which exists only
      // in screen-reader mode. A legitimate setting, switched on before any terminal is made (a switch later
      // re-creates the terminal and loses what it had shown).
      await cmd('settings.set', { patch: { screenReader: true } });

      await sim.step('Design tab opens on the empty state', async () => {
        await designTab();
        const text = await hole().innerText();
        expect(text.includes('Point Styx at your dev server to see it here.'), `empty copy missing: ${text}`);
        expect(
          text.includes('Run it locally, or start the server yourself and enter its URL.'),
          `hint missing: ${text}`,
        );
        const reload = page().getByRole('button', { name: 'Reload' });
        const open = page().getByRole('button', { name: 'Open in browser' });
        expect(await reload.isDisabled(), 'Reload should be disabled with no URL');
        expect(await open.isDisabled(), 'Open in browser should be disabled with no URL');
        expect(
          intercepted,
          'could not intercept shell.openExternal in main (browser buttons will be skipped)',
        );
        return `browser intercept ${intercepted ? 'armed' : 'FAILED'}`;
      });

      await sim.step('a non-local URL is refused with the local-only copy', async () => {
        await setUrl('https://example.com');
        const notice = page().locator('[data-preview-local-only="true"]');
        await notice.waitFor({ timeout: 5000 });
        const text = await notice.innerText();
        expect(
          text.includes('The design window shows local servers only (localhost, 127.0.0.1).'),
          `copy: ${text}`,
        );
        const saved = (await settingsOf(acme))['devUrl'] ?? null;
        expect(saved === null || saved === undefined, `remote URL was saved: ${String(saved)}`);
        expect((await url().inputValue()) === 'https://example.com', 'field should keep what was typed');
        return 'refused; nothing saved; field keeps the text';
      });

      await sim.step(
        'localhost:3999 with nothing listening shows the waiting notice (no Run locally yet)',
        async () => {
          await setUrl(`localhost:${PORT}`);
          const status = page().locator('[data-preview-status]');
          await status.waitFor({ timeout: 8000 });
          const phase = await status.getAttribute('data-preview-status');
          const text = await status.innerText();
          expect(phase === 'waiting', `phase ${phase}: ${text}`);
          expect(/Waiting for .*localhost:3999/.test(text), `waiting copy: ${text}`);
          expect(text.includes('The page opens as soon as the server answers.'), `hint: ${text}`);
          expect(
            (await page().locator('[data-preview-run]').count()) === 0,
            'Run locally offered although no command is known',
          );
          expect(
            !(await page().getByRole('button', { name: 'Reload' }).isDisabled()),
            'Reload should be enabled',
          );
          expect(
            !(await page().getByRole('button', { name: 'Open in browser' }).isDisabled()),
            'Open in browser should be enabled',
          );
          return `${text.replace(/\n/g, ' · ')}`;
        },
      );

      await sim.step('a non-local URL typed over a saved local one: what does the person see?', async () => {
        await setUrl('https://example.com');
        await wait(600);
        const notice = page().locator('[data-preview-local-only="true"]');
        const shown = (await notice.count()) > 0;
        const saved = (await settingsOf(acme))['devUrl'];
        const holeText = await hole().innerText();
        if (!shown)
          sim.finding({
            severity: 'minor',
            title: 'A remote URL typed over a saved local one is refused silently',
            repro: 'Design tab · localhost:3999 saved · type https://example.com · Enter',
            expected:
              'The local-only notice (copy workspace.design.localOnly), as it shows when no URL was saved',
            observed: `No notice; the hole still reads "${holeText.replace(/\n/g, ' · ')}" for the old URL while the field shows the rejected text; saved devUrl stays ${String(saved)}`,
            where:
              'apps/desktop/src/renderer/features/preview/DesignPane.tsx — `notice` only renders the local-only branch when previewUrl === ""',
          });
        expect(String(saved).includes('3999'), `saved URL changed to ${String(saved)}`);
        await setUrl(`localhost:${PORT}`);
        return shown ? 'notice shown' : 'silent (finding)';
      });

      if (intercepted)
        await sim.step('Open in browser hands the URL to the OS (intercepted)', async () => {
          await page().getByRole('button', { name: 'Open in browser' }).click();
          const urls = await until(async () => {
            const u = await opened();
            return u.length > 0 ? u : null;
          }, 4000);
          expect(urls !== null, 'openExternal was never called');
          expect(urls![0]!.includes('localhost:3999'), `opened ${urls!.join(', ')}`);
          return urls!.join(', ');
        });

      // =====================================================================================================
      // 2 · Run locally, first time (no command known) — hidden task with the fake Codex
      // =====================================================================================================
      await sim.step('agents detected; Codex is the project default', async () => {
        const r = await cmd<{ clis: { agent: string; version: string | null }[] }>('detect.clis', {});
        expect(r.ok, 'detect.clis failed');
        const codex = r.value!.clis.find((c) => c.agent === 'codex');
        expect(codex !== undefined, `codex not detected: ${JSON.stringify(r.value!.clis)}`);
        const s = await cmd('project.settings.set', { projectId: acme, patch: { defaultAgent: 'codex' } });
        expect(s.ok, 'could not set default agent');
        return `codex ${codex?.version ?? '?'} (fake)`;
      });

      await sim.step('first time: the run row has a hint and a button, no command field', async () => {
        await designTab();
        const hint = page().locator('[data-run-first-time]');
        await hint.waitFor({ timeout: 8000 });
        const text = await hint.innerText();
        expect(/^Set up and start this project locally\. \S.* works out how\.$/.test(text), `hint: ${text}`);
        expect(
          (await page().locator('[data-run-command]').count()) === 0,
          'command field shown before anything was learned',
        );
        expect(!(await page().locator('[data-run-start]').isDisabled()), 'Run locally disabled');
        if (!/codex/i.test(text))
          sim.finding({
            severity: 'polish',
            title: 'The first-time hint does not name the agent that will do the work',
            repro: 'Design tab, project with no learned command',
            expected:
              'The hint says who is about to be handed the job (the row later says "Preparing local app…" / "Ask Codex to fix it", so the agent is otherwise named)',
            observed: `"${text}" — copy.workspace.run.firstTime has no {agent} slot although DesignPane fills it with the agent name`,
            where: 'packages/core/src/copy.ts workspace.run.firstTime; DesignPane.tsx data-run-first-time',
          });
        return text;
      });

      await sim.step(
        'clicking Run locally hands the job to a hidden task; the row and the dialog say so',
        async () => {
          await page().locator('[data-run-start]').click();
          const dialog = page().locator('[data-task-dialog]');
          await dialog.waitFor({ timeout: 10_000 });
          const title = await dialog
            .locator('[id]')
            .first()
            .innerText()
            .catch(() => '');
          const learning = page().locator('[data-run-learning]');
          await learning.waitFor({ timeout: 10_000 });
          const rowText = await learning.innerText();
          expect(rowText === 'Preparing local app…', `row: ${rowText}`);
          expect(
            (await page().locator('[data-run-open-chat]').innerText()) === 'View progress',
            'View progress link missing',
          );
          expect((await dialog.getAttribute('aria-modal')) === 'false', 'task dialog is modal');
          const status = await dialog.getByRole('status').innerText();
          await sim.shot('run-locally-task-started');
          return `dialog "${title.replace(/\n/g, ' ')}" · status "${status}"`;
        },
      );

      await sim.step('the fake agent finishes without teaching Styx: what the person is told', async () => {
        const dialog = page().locator('[data-task-dialog]');
        // The fake replays an approval request whatever the approval policy; a real Codex in bypass mode would not ask.
        const allow = dialog.getByRole('button', { name: 'Allow', exact: true });
        const asked = await until(async () => ((await allow.count()) > 0 ? true : null), 8000);
        if (asked) await allow.click();
        const finished = await until(async () => {
          const t = await dialog
            .getByRole('status')
            .innerText()
            .catch(() => '');
          return /Finished|Could not finish|Stopped/.test(t) ? t : null;
        }, 20_000);
        expect(finished !== null, 'task never finished');
        const body = await dialog.innerText();
        const learned = (await settingsOf(acme))['devCommand'] ?? null;
        await sim.shot('run-locally-task-finished');
        // Back on the design tab: the row must be sane again.
        const first = page().locator('[data-run-first-time]');
        const back = await until(async () => ((await first.count()) > 0 ? true : null), 8000);
        expect(back, 'the run row did not return to its first-time state after the task ended');
        expect(
          (await page().locator('[data-run-start]').count()) === 1,
          'Run locally button missing after the task',
        );
        // "Finished, but nothing was learned" (with the line that says what to do next) is the honest answer.
        if (learned === null && /Finished/.test(finished!) && !/nothing was learned/.test(finished!))
          sim.finding({
            severity: 'major',
            title:
              'A learn-run task that never called remember_command ends as "Finished" with nothing learned and no explanation',
            repro: 'Design tab · Run locally (first time) · agent answers without calling remember_command',
            expected:
              'The task or the run row says the agent did not teach Styx a command (nothing will run next time) and offers to try again or type it',
            observed: `Task status "${finished}", body: "${body.replace(/\s+/g, ' ').slice(0, 220)}"; devCommand still ${String(learned)}; the run row is back to "Set up and start this project locally." as if nothing happened`,
            where:
              'apps/desktop/src/renderer/features/tasks/TaskDialog.tsx (taskStatus) · features/abilities/learn.ts — completion is not checked against the ability it was started for',
          });
        return `${finished} · asked for approval: ${asked ? 'yes (fake artefact)' : 'no'} · learned: ${String(learned)}`;
      });

      await sim.step('Stop task ends a running learn-run cleanly', async () => {
        await closeTaskDialog();
        await page().locator('[data-run-start]').click();
        const dialog = page().locator('[data-task-dialog]');
        await dialog.waitFor({ timeout: 10_000 });
        const stop = dialog.getByRole('button', { name: 'Stop task' });
        const stoppable = await until(async () => ((await stop.count()) > 0 ? true : null), 10_000);
        expect(stoppable, 'no Stop task button');
        await stop.click();
        const status = await until(async () => {
          const t = await dialog
            .getByRole('status')
            .innerText()
            .catch(() => '');
          return /Stopped|Could not finish|Finished/.test(t) ? t : null;
        }, 15_000);
        expect(status !== null, 'status never settled after Stop task');
        const s = await snapshot();
        const alive = s.sessions.filter((x) => x.purpose === 'learn-run' && x.state !== 'done');
        expect(alive.length === 0, `learn-run sessions still alive: ${alive.map((x) => x.state).join(',')}`);
        await closeTaskDialog();
        const back = await until(
          async () => ((await page().locator('[data-run-start]').count()) > 0 ? true : null),
          8000,
        );
        expect(back, 'run row not back to Run locally after Stop task');
        return `status "${status}"`;
      });

      // =====================================================================================================
      // 3 · Run locally, learned command
      // =====================================================================================================
      await sim.step(
        'a learned command fills the field; the waiting notice now offers Run locally',
        async () => {
          const r = await cmd('project.settings.set', {
            projectId: acme,
            patch: { devCommand: 'npm run dev' },
          });
          expect(r.ok, 'settings.set failed');
          const field = page().locator('[data-run-command]');
          await field.waitFor({ timeout: 8000 });
          expect((await field.inputValue()) === 'npm run dev', `command field: ${await field.inputValue()}`);
          expect(
            (await page().locator('[data-run-first-time]').count()) === 0,
            'first-time hint still shown',
          );
          const run = page().locator('[data-preview-run]');
          await run.waitFor({ timeout: 8000 });
          expect((await run.innerText()) === 'Run locally', 'notice button label');
        },
      );

      await sim.step(
        'Run locally from the notice: strip, phase, URL, status bar, the page renders, strip folds',
        async () => {
          await page().locator('[data-preview-run]').click();
          const strip = page().locator('[data-run-strip]');
          await strip.waitFor({ timeout: 10_000 });
          const phase = page().locator('[data-run-phase]');
          const running = await until(async () => {
            const t = await phase.innerText().catch(() => '');
            return t.startsWith('Running · ') ? t : null;
          }, 20_000);
          expect(running !== null, `phase never Running: ${await phase.innerText()}`);
          expect(running === `Running · http://localhost:${PORT}`, `phase: ${running}`);
          const bar = await page().locator('[data-status-bar]').innerText();
          expect(bar.includes(`dev · http://localhost:${PORT}`), `status bar: ${bar}`);
          expect(
            (await url().inputValue()) === `http://localhost:${PORT}`,
            `url field: ${await url().inputValue()}`,
          );
          const p = await until(async () => {
            const v = await preview(PORT);
            return v !== null && v.title === 'ACME DEV' ? v : null;
          }, 15_000);
          expect(p !== null, `page never rendered: ${JSON.stringify(await preview(PORT))}`);
          expect(p!.body.includes('ACME DEV PAGE OK'), `body: ${p!.body}`);
          const folded = await until(
            async () => ((await strip.getAttribute('data-open')) === 'false' ? true : null),
            5000,
          );
          expect(folded, 'output strip did not fold once the app had a URL');
          const nv = await nativeView();
          expect(nv !== null && nv.width > 100, `native view not on screen: ${JSON.stringify(nv)}`);
          await sim.shot('run-locally-running');
          return `${running} · view ${nv!.width}×${nv!.height}`;
        },
      );

      await sim.step('Output toggle reopens the strip and shows the process output', async () => {
        await page().locator('[data-run-toggle]').click();
        const term = page().locator('[data-run-terminal]');
        await term.waitFor({ timeout: 5000 });
        await sim.shot('run-output-strip-open');
        // xterm paints to a canvas: its text lives in the DOM renderer rows or the accessibility tree
        const text = await until(async () => {
          const t = await page()
            .evaluate(() => {
              // the DOM renderer's rows plus the screen-reader live region: everything the strip holds
              const term = document.querySelector('[data-run-terminal]');
              return (term?.textContent ?? '').replace(/\u00a0/g, ' ');
            })
            .catch(() => '');
          return t.includes('ready http://localhost') ? t : null;
        }, 8000);
        const dump = await page()
          .evaluate(() => {
            const term = document.querySelector('[data-run-terminal]');
            const root = term?.querySelector('.xterm');
            return {
              strip: term !== null,
              xterm: root !== null,
              rows: root?.querySelectorAll('.xterm-rows > div').length ?? -1,
              acc: root?.querySelectorAll('.xterm-accessibility-tree > div').length ?? -1,
              text: (term?.textContent ?? '')
                .replace(/\u00a0/g, ' ')
                .trim()
                .slice(0, 600),
              classes: root?.className ?? '',
            };
          })
          .catch(() => null);
        await page().locator('[data-run-toggle]').click();
        expect(text !== null, `the run output does not show the server line · ${JSON.stringify(dump)}`);
        return 'server line visible in the strip';
      });

      await sim.step('Reload keeps the page', async () => {
        await page().getByRole('button', { name: 'Reload' }).click();
        const p = await until(async () => {
          const v = await preview(PORT);
          return v !== null && v.title === 'ACME DEV' ? v : null;
        }, 8000);
        expect(p !== null, 'page gone after Reload');
      });

      await sim.step(
        'Phone preset: 393px viewport inside a drawn frame; Rotate swaps; Tablet 834; Desktop frees it',
        async () => {
          await page().locator('[data-preview-device="phone"]').click();
          const phone = await until(async () => {
            const v = await preview(PORT);
            return v !== null && v.width === 393 ? v : null;
          }, 8000);
          expect(phone !== null, `phone innerWidth: ${JSON.stringify(await preview(PORT))}`);
          expect((await hole().getAttribute('data-preview-frame')) === 'phone', 'phone frame not drawn');
          expect(
            (await page().locator('[data-preview-frame-kind="phone"]').count()) === 1,
            'DeviceFrame missing',
          );
          const slot = await page().locator('[data-preview-slot]').boundingBox();
          const nv = await nativeView();
          expect(slot !== null && nv !== null, 'no slot / native view');
          const drift =
            Math.abs(slot!.x - nv!.x) + Math.abs(slot!.y - nv!.y) + Math.abs(slot!.width - nv!.width);
          expect(
            drift <= 3,
            `native view not on the frame's slot (drift ${drift}px): slot ${JSON.stringify(slot)} view ${JSON.stringify(nv)}`,
          );
          await sim.shot('preset-phone');
          await page().locator('[data-preview-rotate]').click();
          const landscape = await until(async () => {
            const v = await preview(PORT);
            return v !== null && v.width === 852 ? v : null;
          }, 8000);
          expect(landscape !== null, `rotated innerWidth: ${JSON.stringify(await preview(PORT))}`);
          expect(
            (await page().locator('[data-preview-landscape="true"]').count()) === 1,
            'landscape attr missing',
          );
          await page().locator('[data-preview-rotate]').click();
          await page().locator('[data-preview-device="tablet"]').click();
          const tablet = await until(async () => {
            const v = await preview(PORT);
            return v !== null && v.width === 834 ? v : null;
          }, 8000);
          expect(tablet !== null, `tablet innerWidth: ${JSON.stringify(await preview(PORT))}`);
          expect((await hole().getAttribute('data-preview-frame')) === 'tablet', 'tablet frame not drawn');
          await sim.shot('preset-tablet');
          await page().locator('[data-preview-device="desktop"]').click();
          const desktop = await until(async () => {
            const v = await preview(PORT);
            // the free page takes the hole's width (≈440px in a 1280 window): wider than the phone, unzoomed
            return v !== null && v.width > 400 && Math.abs(v.zoom - 1) < 0.01 ? v : null;
          }, 8000);
          expect(desktop !== null, `desktop after presets: ${JSON.stringify(await preview(PORT))}`);
          expect((await hole().getAttribute('data-preview-frame')) === null, 'frame still drawn on Desktop');
          return `phone ${phone!.width}@${phone!.zoom.toFixed(2)} · landscape ${landscape!.width} · tablet ${tablet!.width}@${tablet!.zoom.toFixed(2)} · desktop ${desktop!.width}@${desktop!.zoom.toFixed(2)}`;
        },
      );

      await sim.step('the native view leaves the screen under the palette and comes back', async () => {
        expect((await nativeView()) !== null, 'view not visible before the palette');
        await page().keyboard.press('Meta+K');
        await page().waitForSelector('[data-overlay="palette"]', { timeout: 5000 });
        const hidden = await until(async () => ((await nativeView()) === null ? true : null), 5000);
        expect(hidden, 'native view still painted under the palette');
        await page().keyboard.press('Escape');
        const back = await until(async () => ((await nativeView()) !== null ? true : null), 5000);
        expect(back, 'native view did not return after the palette closed');
        const p = await preview(PORT);
        expect(p !== null && p.title === 'ACME DEV', 'page reloaded/lost after the palette');
      });

      await sim.step('the deploy picker (a DOM menu) is not covered by the native design view', async () => {
        const button = page().locator('[data-deploy-button] > button');
        await button.click();
        const menu = page().locator('[data-deploy-menu]');
        await menu.waitFor({ timeout: 5000 });
        const box = await menu.boundingBox();
        const nv = await nativeView();
        await page().keyboard.press('Escape');
        expect(box !== null, 'menu has no box');
        const overlaps =
          nv !== null &&
          box!.x < nv.x + nv.width &&
          box!.x + box!.width > nv.x &&
          box!.y < nv.y + nv.height &&
          box!.y + box!.height > nv.y;
        if (overlaps)
          sim.finding({
            severity: 'major',
            title: 'The deploy picker opens underneath the native design view',
            repro: 'Design tab with a page showing · click "Deploy to" (project with several prod targets)',
            expected:
              'The picker is readable and clickable (a native view must leave the screen for anything floating, as it does for the palette and modals)',
            observed: `menu box ${JSON.stringify(box)} intersects the visible WebContentsView ${JSON.stringify(nv)}; the picker is not an overlay so DesignPane keeps the view visible`,
            where:
              'apps/desktop/src/renderer/features/workspace/DeployButton.tsx (inline menu) · DesignPane.tsx `covered = overlays.length > 0`',
          });
        return overlaps ? 'overlaps (finding)' : 'clear';
      });

      await sim.step(
        'Stop ends the run: Exited, status bar clears, port free; Dismiss removes the strip',
        async () => {
          await page().locator('[data-run-stop]').click();
          const phase = page().locator('[data-run-phase]');
          const exited = await until(async () => {
            const t = await phase.innerText().catch(() => '');
            return t.startsWith('Exited') ? t : null;
          }, 20_000);
          expect(exited !== null, `never exited: ${await phase.innerText()}`);
          const bar = await page().locator('[data-status-bar]').innerText();
          expect(!bar.includes('dev ·'), `status bar still: ${bar}`);
          await page().locator('[data-run-start]').waitFor({ timeout: 8000 });
          await wait(500);
          const still = listeners(PORT);
          expect(still === '', `port ${PORT} still held after Stop: ${still}`);
          await page().locator('[data-run-dismiss]').click();
          const gone = await until(
            async () => ((await page().locator('[data-run-strip]').count()) === 0 ? true : null),
            5000,
          );
          expect(gone, 'strip still present after Dismiss');
          return exited!;
        },
      );

      await sim.step(
        'a failing command: Exited · code 1, "Ask Codex to fix it" starts a fix task',
        async () => {
          await cmd('project.settings.set', { projectId: acme, patch: { devCommand: 'exit 1' } });
          const field = page().locator('[data-run-command]');
          await until(async () => ((await field.inputValue()) === 'exit 1' ? true : null), 5000);
          await page().locator('[data-run-start]').click();
          const phase = page().locator('[data-run-phase]');
          const exited = await until(async () => {
            const t = await phase.innerText().catch(() => '');
            return t.startsWith('Exited') ? t : null;
          }, 20_000);
          expect(exited === 'Exited · code 1', `phase: ${exited}`);
          const strip = page().locator('[data-run-strip]');
          expect((await strip.getAttribute('data-open')) === 'true', 'strip did not reopen on failure');
          const fix = page().locator('[data-run-fix]');
          await fix.waitFor({ timeout: 5000 });
          const label = await fix.innerText();
          expect(label === 'Ask Codex to fix it', `fix label: ${label}`);
          await fix.click();
          const dialog = page().locator('[data-task-dialog]');
          await dialog.waitFor({ timeout: 10_000 });
          const learning = await until(
            async () => ((await page().locator('[data-run-learning]').count()) > 0 ? true : null),
            10_000,
          );
          expect(learning, 'row does not show the fix task');
          expect(
            (await page().locator('[data-run-fix]').count()) === 0,
            'fix link still offered while the agent works',
          );
          await stopTaskIfRunning();
          await until(async () => {
            const t = await dialog
              .getByRole('status')
              .innerText()
              .catch(() => '');
            return /Stopped|Finished|Could not finish/.test(t) ? t : null;
          }, 15_000);
          await closeTaskDialog();
          await page().locator('[data-run-dismiss]').click();
          return `${exited} → "${label}" → task started and stopped`;
        },
      );

      await sim.step('a command with a port flag is kept as typed (`npm run dev -- -p 3999`)', async () => {
        const field = page().locator('[data-run-command]');
        await field.fill('npm run dev -- -p 3999');
        await field.press('Tab');
        const saved = await until(async () => {
          const v = (await settingsOf(acme))['devCommand'];
          return v === 'npm run dev -- -p 3999' ? v : null;
        }, 5000);
        expect(saved !== null, `saved devCommand: ${String((await settingsOf(acme))['devCommand'])}`);
        const file = JSON.parse(readFileSync(projectFile, 'utf8')) as { dev?: { command?: string } };
        expect(
          file.dev?.command === 'npm run dev -- -p 3999',
          `project.json dev.command: ${String(file.dev?.command)}`,
        );
        return 'settings + .styx/project.json agree';
      });

      await sim.step('blog-v2 keeps its own URL and run state; acme-shop keeps its own', async () => {
        await page().locator('[data-rail] [title="blog-v2"]').click();
        await designTab();
        await until(async () => ((await url().inputValue()) === '' ? true : null), 5000);
        expect((await url().inputValue()) === '', `blog URL field: ${await url().inputValue()}`);
        expect(
          (await page().locator('[data-run-strip]').count()) === 0,
          'acme run strip leaked into blog-v2',
        );
        expect((await page().locator('[data-run-first-time]').count()) === 1, 'blog-v2 should be first-time');
        await setUrl(`localhost:${PORT_B}`);
        await page().locator('[data-preview-status="waiting"]').waitFor({ timeout: 8000 });
        await page().locator('[data-rail] [title="acme-shop"]').click();
        await designTab();
        const back = await until(
          async () => ((await url().inputValue()).includes('3999') ? true : null),
          5000,
        );
        expect(back, `acme URL after switching back: ${await url().inputValue()}`);
        const field = page().locator('[data-run-command]');
        expect((await field.inputValue()) === 'npm run dev -- -p 3999', 'acme command lost on switch');
        return 'independent';
      });

      // =====================================================================================================
      // 4 · Device platform: an Expo-looking repo, the fake simulator
      // =====================================================================================================
      await sim.step(
        'an Expo repo: Runs on chips (iOS · Android · Web), iOS remembered, the fake simulator listed',
        async () => {
          writeFileSync(join(lane, 'package.json'), expoPackage('acme-shop'));
          writeFileSync(
            join(lane, 'app.json'),
            JSON.stringify({ expo: { name: 'acme-shop', slug: 'acme-shop' } }),
          );
          await cmd('project.settings.set', {
            projectId: acme,
            patch: { devCommand: 'node -e "setInterval(()=>{},1000)"', devPlatform: 'ios' },
          });
          // Detection runs when the pane mounts: leave and come back.
          await page().locator('[data-rail] [title="blog-v2"]').click();
          await page().waitForSelector('[data-design-pane]', { timeout: 8000 });
          await page().locator('[data-rail] [title="acme-shop"]').click();
          await designTab();
          const chips = page().locator('[data-run-platforms]');
          await chips.waitFor({ timeout: 10_000 });
          const names = await chips.getByRole('radio').allInnerTexts();
          const ios = chips.getByRole('radio', { name: 'iOS' });
          expect(
            (await ios.getAttribute('aria-checked')) === 'true',
            `iOS not checked; chips ${names.join(' · ')}`,
          );
          const pick = page().locator('[data-device-pick]');
          await pick.waitFor({ timeout: 10_000 });
          const options = await until(async () => {
            const o = await pick.locator('option').allInnerTexts();
            return o.some((x) => x.includes('iPhone 17 Pro')) ? o : null;
          }, 10_000);
          expect(
            options !== null,
            `device options: ${(await pick.locator('option').allInnerTexts()).join(' | ')}`,
          );
          expect(
            (await page().locator('[data-preview-device]').count()) === 0,
            'web presets shown for a device platform',
          );
          const empty = await page().locator('[data-device-empty="ios"]').innerText();
          expect(
            empty.includes('Run locally to build the app and mirror the simulator here.'),
            `empty: ${empty}`,
          );
          await pick.selectOption({ label: options!.find((x) => x.includes('iPhone 17 Pro'))! });
          return `chips ${names.join(' · ')} · devices ${options!.join(' | ')}`;
        },
      );

      await sim.step(
        'Run on iOS: Booting iPhone 17 Pro… → Mirroring · screenshots; frames arrive; status bar; no-input row',
        async () => {
          await page().locator('[data-run-start]').click();
          const row = page().locator('[data-device-row]');
          await row.waitFor({ timeout: 10_000 });
          const booting = await until(async () => {
            const t = await page()
              .locator('[data-device-text]')
              .innerText()
              .catch(() => '');
            return t.startsWith('Booting') ? t : null;
          }, 10_000);
          await sim.shot('device-booting');
          const ready = await until(
            async () => ((await row.getAttribute('data-device-phase')) === 'ready' ? true : null),
            20_000,
          );
          expect(ready, `device never ready: ${await page().locator('[data-device-text]').innerText()}`);
          const text = await page().locator('[data-device-text]').innerText();
          expect(text.startsWith('Mirroring · iPhone 17 Pro'), `row text: ${text}`);
          const frame = page().locator('[data-device-frame] img');
          await frame.waitFor({ timeout: 10_000 });
          const src = await until(async () => {
            const s = (await frame.getAttribute('src')) ?? '';
            return s.startsWith('styx-device://frame/') ? s : null;
          }, 10_000);
          expect(src !== null, `frame src: ${await frame.getAttribute('src')}`);
          const width = await until(async () => {
            const w = await frame.evaluate((img) => (img as HTMLImageElement).naturalWidth);
            return w === 393 ? w : null;
          }, 10_000);
          expect(width === 393, `naturalWidth ${width}`);
          const seqOf = async () =>
            Number(/seq=(\d+)/.exec((await frame.getAttribute('src')) ?? '')?.[1] ?? 0);
          const first = await seqOf();
          const moved = await until(async () => ((await seqOf()) > first ? true : null), 8000);
          expect(moved, 'frames stopped at the first screenshot');
          const mirror = await page().locator('[data-device-frame]').getAttribute('data-mirror');
          const bar = await page().locator('[data-status-bar]').innerText();
          expect(/iOS · iPhone 17 Pro/.test(bar), `status bar: ${bar}`);
          const noInput = page().locator('[data-device-no-input]');
          expect((await noInput.count()) === 1, 'no-input row missing (no idb on this Mac)');
          const noInputText = await noInput.innerText();
          expect(
            (await page().locator('[data-device-focus]').innerText()) === 'Open the simulator',
            'focus link',
          );
          expect(
            (await page().locator('[data-device-shutdown]').innerText()) === 'Shut down',
            'shutdown link',
          );
          expect((await page().locator('[data-device-stop]').innerText()) === 'Stop simulator', 'stop link');
          const surface = page().locator('[data-device-surface]');
          expect(
            (await surface.getAttribute('role')) === 'img',
            `surface role ${await surface.getAttribute('role')}`,
          );
          const access = page().locator('[data-device-screen-access-row]');
          const accessText = (await access.count()) > 0 ? await access.innerText() : '(no screen-access row)';
          const phase = await page().locator('[data-run-phase]').innerText();
          await sim.shot('device-mirroring');
          return `${booting ?? '(boot text missed)'} → "${text}" · mirror=${mirror} · run "${phase}" · ${noInputText} · ${accessText.replace(/\n/g, ' ')}`;
        },
      );

      await sim.step('Open the simulator is a no-op on this Mac (fake `open`) and stays honest', async () => {
        await page().locator('[data-device-focus]').click();
        await wait(300);
        const row = await page().locator('[data-device-text]').innerText();
        expect(row.startsWith('Mirroring'), `row after focus: ${row}`);
      });

      await sim.step(
        'Stop simulator leaves the run alive; the run row still says Running · iOS',
        async () => {
          await page().locator('[data-device-stop]').click();
          const gone = await until(
            async () => ((await page().locator('[data-device-row]').count()) === 0 ? true : null),
            10_000,
          );
          expect(gone, 'device row still there after Stop simulator');
          const bar = await page().locator('[data-status-bar]').innerText();
          expect(!/iPhone 17 Pro/.test(bar), `status bar still names the device: ${bar}`);
          const phase = await page().locator('[data-run-phase]').innerText();
          expect(phase === 'Running · iOS', `run phase: ${phase}`);
          const list = await cmd<{ devices: { state: string }[] }>('device.list', { platform: 'ios' });
          return `simulator ${list.ok ? list.value!.devices[0]?.state : '?'} · run "${phase}"`;
        },
      );

      await sim.step('Run again then Shut down: the simulator is shut down; Stop ends the run', async () => {
        await page().locator('[data-run-stop]').click();
        await page().locator('[data-run-start]').waitFor({ timeout: 15_000 });
        await page()
          .locator('[data-run-dismiss]')
          .click()
          .catch(() => undefined);
        await page().locator('[data-run-start]').click();
        const row = page().locator('[data-device-row]');
        await row.waitFor({ timeout: 10_000 });
        const ready = await until(
          async () => ((await row.getAttribute('data-device-phase')) === 'ready' ? true : null),
          20_000,
        );
        expect(ready, 'second boot never ready');
        await page().locator('[data-device-shutdown]').click();
        const gone = await until(async () => ((await row.count()) === 0 ? true : null), 10_000);
        expect(gone, 'device row still there after Shut down');
        const list = await cmd<{ devices: { state: string }[] }>('device.list', { platform: 'ios' });
        expect(
          list.ok && list.value!.devices[0]?.state === 'shutdown',
          `simulator state ${JSON.stringify(list)}`,
        );
        await page().locator('[data-run-stop]').click();
        await page().locator('[data-run-start]').waitFor({ timeout: 15_000 });
        await page()
          .locator('[data-run-dismiss]')
          .click()
          .catch(() => undefined);
        return 'shutdown; run stopped';
      });

      await sim.step('Android reads as not installed, with the hint', async () => {
        await page().locator('[data-run-platforms]').getByRole('radio', { name: 'Android' }).click();
        const hint = page().locator('[data-device-no-tooling="android"]');
        await hint.waitFor({ timeout: 8000 });
        const text = await hint.innerText();
        expect(text === 'The Android SDK (adb, emulator) is not installed.', `hint: ${text}`);
        const empty = await page().locator('[data-device-empty="android"]').innerText();
        expect(
          empty.includes('Install Android Studio and add its SDK tools to your PATH.'),
          `empty: ${empty}`,
        );
        expect(
          (await page().locator('[data-device-pick]').count()) === 0,
          'device picker shown without tooling',
        );
        await sim.shot('device-android-missing');
        await page().locator('[data-run-platforms]').getByRole('radio', { name: 'Web' }).click();
        await page().locator('[data-preview-device="phone"]').waitFor({ timeout: 8000 });
        const s = await settingsOf(acme);
        // on a mobile app the Web pick is saved as web: unset would resolve back to iOS (detection's first)
        expect(s['devPlatform'] === 'web', `devPlatform after Web: ${String(s['devPlatform'])}`);
        writeFileSync(join(lane, 'package.json'), webPackage('acme-shop', PORT, 'ACME DEV'));
        return 'android hint ok; back to Web';
      });

      // =====================================================================================================
      // 5 · Deploy
      // =====================================================================================================
      await sim.step(
        'the mode strip deploy button opens a picker listing every target, prod last (issue #9)',
        async () => {
          const wrap = page().locator('[data-deploy-button]');
          await wrap.waitFor({ timeout: 8000 });
          const button = wrap.locator('> button');
          const label = await button.innerText();
          expect(
            (await wrap.getAttribute('data-state')) === 'menu',
            `state ${await wrap.getAttribute('data-state')}`,
          );
          expect(label.includes('Deploy to'), `label ${label}`);
          await button.click();
          const items = page().locator('[data-deploy-menu] [role="menuitem"]');
          const names = await items.allInnerTexts();
          const learn = await Promise.all((await items.all()).map((i) => i.getAttribute('data-learn')));
          await page().keyboard.press('Escape');
          const prod = await Promise.all((await items.all()).map((i) => i.getAttribute('data-prod')));
          expect(names.length === 5, `items: ${names.join(' | ')}`);
          expect(names[0]!.startsWith('Vercel'), `first item ${names[0]}`);
          expect(prod[0] !== 'true' && prod[4] === 'true', `prod flags ${prod.join(',')}`);
          return `${names.map((n, i) => `${n.replace(/\n/g, ' ')}${learn[i] === 'true' ? ' (learn)' : ''}`).join(' · ')}`;
        },
      );

      let vercelOutcome = '';
      await sim.step(
        'Deploy · Vercel prod (policy ask-mfa, MFA auto): the modal, the phase, the outcome, the audit',
        async () => {
          // the picker toggles: an earlier step may have left it open
          if ((await page().locator('[data-deploy-menu]').count()) === 0)
            await page().locator('[data-deploy-button] > button').click();
          await page().locator('[data-deploy-menu] [role="menuitem"][data-prod="true"]').first().click();
          const dialog = page().getByRole('dialog');
          await dialog.waitFor({ timeout: 8000 });
          const title = await dialog.innerText();
          expect(title.includes('Deploy · Vercel prod'), `dialog: ${title.slice(0, 120)}`);
          const phaseEl = page().locator('[data-deploy-phase]');
          const done = await until(async () => {
            const p = await phaseEl.getAttribute('data-deploy-phase');
            return p === 'succeeded' || p === 'failed' || p === 'cancelled' ? p : null;
          }, 20_000);
          const body = (await dialog.innerText()).replace(/\s+/g, ' ');
          const entries = await audit(ids.target.vercelProd);
          const actions = entries.map(
            (e) => `${e.action}(${e.actorKind}${e.triggeredBy ? `, ${e.triggeredBy}` : ''})`,
          );
          const s = await snapshot();
          const grants = s.grants.filter((g) => g.targetId === ids.target.vercelProd && g.sessionId === null);
          await sim.shot('deploy-vercel-prod');
          vercelOutcome = `${done ?? 'no terminal phase'} · "${body.slice(0, 200)}" · audit ${actions.join(', ')} · app grants ${grants.map((g) => g.state).join(',')}`;
          expect(done !== null, `deploy never settled: ${body}`);
          const cliMissing = body.includes('vercel not found on PATH');
          if (!cliMissing)
            sim.finding({
              severity: 'major',
              title:
                'Deploy to live · Vercel prod from the workspace never reaches the CLI: the app cannot approve its own prod grant',
              repro: 'Workspace · Deploy to → Vercel prod (target policy Ask · MFA, STYX_MFA=auto)',
              expected:
                'Requesting access… → MFA → Deploying… → (here) "vercel not found on PATH", with the grant issued and its use audited',
              observed: vercelOutcome,
              where:
                'apps/desktop/src/main/services/grant-service.ts request(): decision "ask" with sessionId null → fail("a user decision needs a session"); deploy-service.ts start() passes sessionId: null',
            });
          else {
            const used = entries.some((e) => e.action === 'used');
            expect(used, `grant use not audited: ${actions.join(', ')}`);
          }
          await dialog.getByRole('button', { name: 'Close' }).last().click();
          return vercelOutcome;
        },
      );

      await sim.step('the failure is reported outside the modal too (toast / status bar)', async () => {
        const toast = page().locator('[data-deploy-toast]');
        const seen = await until(
          async () => ((await toast.count()) > 0 ? await toast.getAttribute('data-deploy-toast') : null),
          3000,
        );
        const bar = await page().locator('[data-status-bar]').innerText();
        return `toast ${seen ?? 'none'} · status bar "${bar.replace(/\n/g, ' · ')}"`;
      });

      await sim.step(
        'Targets: policy select Always allow on Vercel prod, then deploy again — how the grant honours it',
        async () => {
          await page().locator('[data-nav-item="project:targets"]').click();
          const row = page().locator(`[data-target-id="${ids.target.vercelProd}"]`);
          await row.waitFor({ timeout: 8000 });
          await row.locator('select').selectOption('always');
          const saved = await until(async () => {
            const s = await snapshot();
            return s.targets.find((t) => t.id === ids.target.vercelProd)?.policy === 'always' ? true : null;
          }, 5000);
          expect(saved, 'policy not saved');
          const before = (await audit(ids.target.vercelProd)).length;
          await page().locator('[data-nav-item="workspace"]').click();
          // the picker toggles: an earlier step may have left it open
          if ((await page().locator('[data-deploy-menu]').count()) === 0)
            await page().locator('[data-deploy-button] > button').click();
          await page().locator('[data-deploy-menu] [role="menuitem"][data-prod="true"]').first().click();
          const dialog = page().getByRole('dialog');
          await dialog.waitFor({ timeout: 8000 });
          const phaseEl = page().locator('[data-deploy-phase]');
          const done = await until(async () => {
            const p = await phaseEl.getAttribute('data-deploy-phase');
            return p === 'succeeded' || p === 'failed' || p === 'cancelled' ? p : null;
          }, 20_000);
          const body = (await dialog.innerText()).replace(/\s+/g, ' ');
          const entries = (await audit(ids.target.vercelProd)).slice(before);
          await dialog.getByRole('button', { name: 'Close' }).last().click();
          const note = `${done} · "${body.slice(0, 160)}" · new audit ${entries.map((e) => e.action).join(', ') || 'none'}`;
          if (!body.includes('vercel not found on PATH'))
            sim.finding({
              severity: 'major',
              title:
                'Even with the target policy set to Always allow, a prod deploy from the button is refused before the CLI runs',
              repro:
                'Settings › Targets · Vercel prod policy = Always allow · Workspace · Deploy to → Vercel prod',
              expected:
                'The persistent policy issues the grant (or asks with MFA), the command runs and fails on the missing CLI',
              observed: note,
              where:
                'grant-service.ts request(): auto on prod is downgraded to ask for unscoped providers (unscopedProd) and a session-less ask cannot be answered',
            });
          await page().locator('[data-nav-item="project:targets"]').click();
          await row.locator('select').selectOption('ask-mfa');
          await page().locator('[data-nav-item="workspace"]').click();
          return note;
        },
      );

      await sim.step(
        'Deploy · Supabase prod (no command): the first deploy goes to a task; the button reports it',
        async () => {
          await page().locator('[data-deploy-button] > button').click();
          await page().locator('[data-deploy-menu] [role="menuitem"][data-prod="true"]').nth(1).click();
          const dialog = page().locator('[data-task-dialog]');
          await dialog.waitFor({ timeout: 10_000 });
          const wrap = page().locator('[data-deploy-button]');
          const learning = await until(
            async () => ((await wrap.getAttribute('data-state')) === 'learning' ? true : null),
            10_000,
          );
          expect(learning, `button state ${await wrap.getAttribute('data-state')}`);
          const label = await wrap.locator('> button').innerText();
          expect(label.includes('Deploying · Supabase prod'), `label ${label}`);
          const allow = dialog.getByRole('button', { name: 'Allow', exact: true });
          const asked = await until(async () => ((await allow.count()) > 0 ? true : null), 8000);
          if (asked) await allow.click();
          const finished = await until(async () => {
            const t = await dialog
              .getByRole('status')
              .innerText()
              .catch(() => '');
            return /Finished|Could not finish|Stopped/.test(t) ? t : null;
          }, 20_000);
          const s = await snapshot();
          const learnedCmd =
            s.targets.find((t) => t.id === ids.target.supabaseProd)?.config['deployCommand'] ?? null;
          await sim.shot('deploy-supabase-task');
          await closeTaskDialog();
          const backTo = await until(
            async () => ((await wrap.getAttribute('data-state')) === 'menu' ? true : null),
            8000,
          );
          expect(backTo, `button state after the task: ${await wrap.getAttribute('data-state')}`);
          return `${finished ?? 'never settled'} · learned deployCommand ${String(learnedCmd)} · approval asked ${asked ? 'yes (fake artefact)' : 'no'}`;
        },
      );

      await sim.step('Deploy setup: per-target commands, built-in Vercel, save, reset', async () => {
        await page().locator('[data-nav-item="project:targets"]').click();
        await page().locator('[data-deploy-commands]').click();
        const setup = page().locator('[data-deploy-setup]');
        await setup.waitFor({ timeout: 8000 });
        const dialog = page().getByRole('dialog');
        const title = await dialog.innerText();
        expect(title.includes('Deploy · acme-shop'), `title ${title.slice(0, 80)}`);
        const vercel = setup.locator(`[data-deploy-target="${ids.target.vercelProd}"]`);
        expect(
          (await vercel.innerText()).includes('built in · vercel deploy --prod'),
          `vercel row: ${await vercel.innerText()}`,
        );
        const preview = setup.locator(`[data-deploy-target="${ids.target.vercelPreview}"]`);
        expect(
          (await preview.innerText()).includes('built in · vercel deploy'),
          `preview row: ${await preview.innerText()}`,
        );
        const supa = setup.locator(`[data-deploy-target="${ids.target.supabaseProd}"] input`);
        const placeholders = await Promise.all(
          [ids.target.supabaseProd, ids.target.awsProd, ids.target.github].map((id) =>
            setup.locator(`[data-deploy-target="${id}"] input`).getAttribute('placeholder'),
          ),
        );
        const save = dialog.getByRole('button', { name: 'Save' });
        expect(await save.isDisabled(), 'Save enabled before any change');
        await supa.fill('supabase db push');
        expect(!(await save.isDisabled()), 'Save still disabled after typing');
        await save.click();
        const closed = await until(async () => ((await setup.count()) === 0 ? true : null), 8000);
        expect(closed, 'setup modal did not close on Save');
        const s = await snapshot();
        expect(
          s.targets.find((t) => t.id === ids.target.supabaseProd)?.config['deployCommand'] ===
            'supabase db push',
          'deployCommand not saved',
        );
        await page().locator('[data-nav-item="workspace"]').click();
        await page().locator('[data-deploy-button] > button').click();
        const items = page().locator('[data-deploy-menu] [role="menuitem"][data-prod="true"]');
        const supaLearn = await items.nth(1).getAttribute('data-learn');
        await page().keyboard.press('Escape');
        expect(supaLearn !== 'true', 'Supabase still flagged to learn after a command was saved');
        await page().locator('[data-nav-item="project:targets"]').click();
        await page().locator('[data-deploy-commands]').click();
        await setup.waitFor({ timeout: 8000 });
        expect((await supa.inputValue()) === 'supabase db push', 'reopened setup lost the command');
        await supa.fill('');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await until(async () => ((await setup.count()) === 0 ? true : null), 8000);
        const s2 = await snapshot();
        expect(
          (s2.targets.find((t) => t.id === ids.target.supabaseProd)?.config['deployCommand'] ?? null) ===
            null,
          'clearing the command did not reset it',
        );
        return `placeholders ${placeholders.join(' | ')}`;
      });

      await sim.step(
        'a remembered custom command is shown in the Deploy modal before it runs (Supabase, policy ask)',
        async () => {
          await cmd('target.setDeployCommand', {
            targetId: ids.target.supabaseProd,
            command: 'supabase db push',
          });
          await page().locator('[data-nav-item="workspace"]').click();
          await page().locator('[data-deploy-button] > button').click();
          await page().locator('[data-deploy-menu] [role="menuitem"][data-prod="true"]').nth(1).click();
          const dialog = page().getByRole('dialog');
          await dialog.waitFor({ timeout: 8000 });
          const shown = page().locator('[data-deploy-command]');
          const cmdText = (await shown.count()) > 0 ? await shown.innerText() : '(none)';
          const done = await until(async () => {
            const p = await page().locator('[data-deploy-phase]').getAttribute('data-deploy-phase');
            return p === 'succeeded' || p === 'failed' || p === 'cancelled' ? p : null;
          }, 20_000);
          const body = (await dialog.innerText()).replace(/\s+/g, ' ');
          await dialog.getByRole('button', { name: 'Close' }).last().click();
          await cmd('target.setDeployCommand', { targetId: ids.target.supabaseProd, command: null });
          expect(cmdText.includes('supabase db push'), `command not shown: ${cmdText}`);
          return `${cmdText.replace(/\n/g, ' ')} · ${done} · "${body.slice(0, 140)}"`;
        },
      );

      await sim.step('palette: deploy rows carry the lock state in their meta', async () => {
        await page().keyboard.press('Meta+K');
        const palette = page().locator('[data-overlay="palette"]');
        await palette.waitFor({ timeout: 5000 });
        await page().keyboard.type('deploy');
        await wait(300);
        const text = (await palette.innerText())
          .split('\n')
          .filter(
            (l) =>
              /Deploy acme-shop/.test(l) || /open · |locked|persistent|expired|unconnected|deploying/.test(l),
          );
        await sim.shot('palette-deploy-rows');
        await page().keyboard.press('Escape');
        expect(
          text.some((l) => l.includes('Deploy acme-shop → Vercel prod')),
          `rows: ${text.join(' | ')}`,
        );
        return text.join(' | ');
      });

      // =====================================================================================================
      // 6 · Targets
      // =====================================================================================================
      const readTargets = async () => {
        const rows = page().locator('[data-target-id]');
        const out: string[] = [];
        for (const r of await rows.all()) {
          const id = (await r.getAttribute('data-target-id')) ?? '';
          const cells = (await r.innerText())
            .split('\n')
            .map((c) => c.trim())
            .filter(Boolean);
          const policy = await r.locator('select').inputValue();
          out.push(`${id.slice(-6)}: ${cells.join(' / ')} [policy ${policy}]`);
        }
        return out;
      };

      await sim.step(
        'Targets table: name / env / policy / state / action for the five fixture targets',
        async () => {
          await page().locator('[data-nav-item="project:targets"]').click();
          await page().locator('[data-target-id]').first().waitFor({ timeout: 8000 });
          const rows = await readTargets();
          expect(rows.length === 5, `${rows.length} rows`);
          const header = await page()
            .getByRole('table')
            .first()
            .innerText()
            .catch(() => '');
          for (const h of ['Target', 'Env', 'Policy', 'State'])
            expect(header.includes(h), `header missing ${h}`);
          await sim.shot('targets-table');
          return rows.join(' || ');
        },
      );

      await sim.step('Revoke on Vercel prod locks it and is audited', async () => {
        const row = page().locator(`[data-target-id="${ids.target.vercelProd}"]`);
        const action = row.locator('button[aria-label^="Revoke"]');
        expect((await action.count()) === 1, `no Revoke action on Vercel prod: ${await row.innerText()}`);
        // Earlier deploys in this run may have left more than one open grant on the target: Revoke takes the
        // one the row shows; a second press takes the next, until the row reads locked.
        let locked: true | null = null;
        for (let i = 0; i < 3 && locked === null; i += 1) {
          if ((await action.count()) === 0) break;
          await action.click();
          locked = await until(
            async () => ((await row.innerText()).includes('locked') ? true : null),
            4000,
          ).catch(() => null);
        }
        expect(locked, `state after revoke: ${await row.innerText()}`);
        const entries = await audit(ids.target.vercelProd);
        expect(
          entries.some((e) => e.action === 'revoked'),
          `no revoked audit row: ${entries.map((e) => e.action).join(',')}`,
        );
        return 'locked · audited';
      });

      await sim.step(
        'Edit on the AWS key target reopens the key form — and Test / Save need the key retyped',
        async () => {
          const row = page().locator(`[data-target-id="${ids.target.awsProd}"]`);
          const action = row
            .locator(
              'button[aria-label^="Edit"], button[aria-label^="Revoke"], button[aria-label^="Connect"]',
            )
            .first();
          const label = (await action.getAttribute('aria-label')) ?? '';
          if (label.startsWith('Revoke')) {
            await action.click();
            await until(async () => ((await row.innerText()).includes('locked') ? true : null), 5000);
          }
          await row.locator('button[aria-label^="Edit"]').click();
          const dialog = page().getByRole('dialog');
          await dialog.waitFor({ timeout: 8000 });
          const title = (await dialog.innerText()).split('\n')[0] ?? '';
          const advanced = dialog.locator('[data-advanced-method]');
          expect(
            (await advanced.count()) === 1,
            `advanced form not expanded for a key target; dialog: ${title}`,
          );
          const test = dialog.getByRole('button', { name: 'Test connection' });
          const save = dialog.getByRole('button', { name: /^Save to/ });
          const testDisabled = await test.isDisabled();
          const saveDisabled = await save.isDisabled();
          await sim.shot('targets-edit-aws');
          if (testDisabled)
            sim.finding({
              severity: 'minor',
              title:
                'Reconnect / Edit of a key target cannot test the stored credential without retyping name, key and secret',
              repro: 'Settings › Targets · AWS acme-prod · Edit',
              expected:
                'Test connection works on the saved credential (the row exists; the vault has the key); Save only needs what changed',
              observed: `Advanced (IAM / key) opens with empty Name / Access key / Secret; Test connection disabled=${testDisabled}, Save disabled=${saveDisabled}`,
              where:
                'apps/desktop/src/renderer/features/modals/ConnectModal.tsx canSaveKey = keyFormValid(key) gates both buttons',
            });
          await dialog.getByRole('button', { name: 'Back' }).click();
          await dialog.locator('[data-provider="vercel"]').waitFor({ timeout: 5000 });
          await dialog.getByRole('button', { name: 'Close' }).last().click();
          return `${title} · Test disabled=${testDisabled} · Save disabled=${saveDisabled}`;
        },
      );

      await sim.step(
        'Escape in the Connect target modal: does it close (handoff: Escape closes any overlay)?',
        async () => {
          await page()
            .getByRole('button', { name: /Connect a target: OAuth/ })
            .click();
          const dialog = page().getByRole('dialog');
          await dialog.waitFor({ timeout: 8000 });
          await page().keyboard.press('Escape');
          await wait(400);
          const open = (await dialog.count()) > 0;
          if (open)
            sim.finding({
              severity: 'minor',
              title: 'Escape does not close the Connect target modal',
              repro: 'Settings › Targets · + Connect target · press Escape',
              expected: 'Handoff "Interactions": Escape closes any overlay and returns focus to its invoker',
              observed:
                'The modal stays open (escapeEnabled={false} on every Connect step); only × / Back / Connect leave it',
              where:
                'apps/desktop/src/renderer/features/modals/ConnectModal.tsx <Modal escapeEnabled={false}>',
            });
          return open ? 'stays open (finding)' : 'closes';
        },
      );

      await sim.step(
        'provider grid: six tiles with their method labels; Tab stays inside the modal',
        async () => {
          const dialog = page().getByRole('dialog');
          if ((await dialog.count()) === 0)
            await page()
              .getByRole('button', { name: /Connect a target: OAuth/ })
              .click();
          await dialog.locator('[data-provider]').first().waitFor({ timeout: 5000 });
          const tiles = await dialog.locator('[data-provider]').allInnerTexts();
          expect(tiles.length === 6, `${tiles.length} tiles`);
          const title = (await dialog.innerText()).split('\n')[0] ?? '';
          expect(title.includes('choose provider'), `title ${title}`);
          let inside = true;
          for (let i = 0; i < 9; i++) {
            await page().keyboard.press('Tab');
            const within = await page().evaluate(() => {
              const d = document.querySelector('[role="dialog"]');
              return d !== null && d.contains(document.activeElement);
            });
            if (!within) inside = false;
          }
          expect(inside, 'focus escaped the Connect modal while tabbing');
          return tiles.map((t) => t.replace(/\n/g, ' ')).join(' · ');
        },
      );

      /** The connect modal on its provider grid: opened when closed, taken Back when a form is showing. */
      const onProviderGrid = async () => {
        const dialog = page().getByRole('dialog');
        if ((await dialog.count()) === 0) {
          await page()
            .getByRole('button', { name: /Connect a target: OAuth/ })
            .click();
          await dialog.waitFor({ timeout: 5000 });
        }
        for (let i = 0; i < 3 && (await dialog.locator('[data-provider]').count()) === 0; i += 1) {
          const back = dialog.getByRole('button', { name: 'Back', exact: true });
          if ((await back.count()) === 0) break;
          await back.click();
          await wait(150);
        }
        await dialog.locator('[data-provider]').first().waitFor({ timeout: 5000 });
        return dialog;
      };
      for (const provider of ['vercel', 'aws', 'gcp', 'supabase'] as const) {
        await sim.step(
          `Connect · ${provider}: CLI-first step without the CLI, env chips, Advanced form and its validation`,
          async () => {
            const dialog = await onProviderGrid();
            await dialog.locator(`[data-provider="${provider}"]`).click();
            const status = dialog.locator('[data-cli-installed]');
            await status.waitFor({ timeout: 8000 });
            const installed = await until(async () => {
              const v = await status.getAttribute('data-cli-installed');
              return v === 'false' || v === 'true' ? v : null;
            }, 8000);
            // The status text settles once main answered; "not found" is what a machine without the CLI shows.
            const statusText = await status.innerText();
            const title = (await dialog.innerText()).split('\n')[0] ?? '';
            const connect = dialog.locator('[data-connect-cli]');
            expect(await connect.isDisabled(), 'Connect enabled without an account');
            const signIn = dialog.getByRole('button', { name: /^Sign in with/ });
            expect(await signIn.isDisabled(), 'Sign in enabled without the CLI');
            const staging = dialog.getByRole('radio', { name: 'staging' });
            await staging.click();
            expect((await staging.getAttribute('aria-checked')) === 'true', 'staging chip not selected');
            await dialog.getByRole('radio', { name: 'prod' }).click();
            await dialog.getByRole('button', { name: /^Advanced/ }).click();
            const advanced = dialog.locator('[data-advanced-method]');
            await advanced.waitFor({ timeout: 5000 });
            const method = await advanced.getAttribute('data-advanced-method');
            let note = `${title} · ${statusText} · installed=${installed} · advanced=${method}`;
            if (method === 'key') {
              const test = dialog.getByRole('button', { name: 'Test connection' });
              const save = dialog.getByRole('button', { name: /^Save to/ });
              expect(
                (await test.isDisabled()) && (await save.isDisabled()),
                'key form buttons enabled while empty',
              );
              const inputs = advanced.locator('input');
              await inputs.nth(0).fill('sim-role');
              await inputs.nth(1).fill('AKIA-SIM');
              expect(await save.isDisabled(), 'Save enabled without a secret');
              await inputs.nth(2).fill('not-a-real-secret');
              expect(!(await save.isDisabled()), 'Save still disabled with all three fields');
              note += ' · key form validates (not saved: Save would call the provider)';
            } else {
              const open = dialog.getByRole('button', { name: 'Open browser' });
              expect((await open.count()) === 1, 'no Open browser button on the OAuth form');
              if (provider === 'vercel' && intercepted) {
                const before = (await snapshot()).targets.length;
                await open.click();
                await wait(800);
                const urls = await opened();
                const after = (await snapshot()).targets;
                const placeholder = after.length > before ? after[after.length - 1] : null;
                const text = (await dialog.innerText()).replace(/\s+/g, ' ');
                const tokenField = await dialog.locator('input[type="password"]').count();
                const browserOpened = urls.some((u) => u.includes('vercel.com'));
                if (!browserOpened || tokenField === 0)
                  sim.finding({
                    severity: 'major',
                    title:
                      'Vercel OAuth path is a dead end: no browser opens and no place to paste the token',
                    repro: 'Connect target · Vercel · Advanced · Open browser',
                    expected:
                      'Either the browser opens on the token page and a Secret field takes the paste (spec: paste path ships regardless), or the button says what to do',
                    observed: `openExternal calls: ${urls.length === 0 ? 'none' : urls.join(', ')} · token field: ${tokenField} · modal reads "${text.slice(-160)}" · a placeholder target row ${placeholder ? `"${placeholder.name}" (${placeholder.env}, credentialRef ${String(placeholder.credentialRef)})` : 'was not'} created`,
                    where:
                      'target-service.ts connectStart() only publishes waiting-browser for vercel/supabase (browserUrl never opened); ConnectModal.tsx tokenMode = flow.browserUrl === null hides the paste field when a URL is known',
                  });
                note += ` · Open browser → opened ${urls.length} · placeholder target ${placeholder ? 'created' : 'none'}`;
              } else
                note += ' · OAuth form (not clicked: GitHub device flow / Supabase would leave the machine)';
            }
            await dialog.getByRole('button', { name: 'Back' }).click();
            await dialog.locator('[data-provider="vercel"]').waitFor({ timeout: 5000 });
            return note;
          },
        );
      }

      await sim.step(
        'Connect · GitHub with the fake gh: signed-in account, name, env, Connect → a live CLI target',
        async () => {
          const dialog = await onProviderGrid();
          await dialog.locator('[data-provider="github"]').click();
          const status = dialog.locator('[data-cli-installed]');
          const installed = await until(
            async () => ((await status.getAttribute('data-cli-installed')) === 'true' ? true : null),
            10_000,
          );
          expect(installed, `gh not seen as installed: ${await status.innerText()}`);
          const account = dialog.getByRole('radio', { name: /fake/ });
          await account.waitFor({ timeout: 8000 });
          expect((await account.getAttribute('aria-checked')) === 'true', 'active account not preselected');
          await dialog.getByRole('radio', { name: 'staging' }).click();
          const name = dialog.getByLabel('Name');
          await name.fill('GitHub sim');
          const connect = dialog.locator('[data-connect-cli]');
          expect(!(await connect.isDisabled()), 'Connect disabled with an account');
          await connect.click();
          const outcome = await until(async () => {
            if ((await dialog.count()) === 0) return 'closed';
            const toast = (await page().locator('[data-toast="error"]').allInnerTexts()).join(' ');
            return toast === '' ? null : toast;
          }, 15_000);
          if (outcome !== 'closed') {
            // The CLI path verifies the token against api.github.com, which no fake answers here: the fake gh's
            // token is refused (unit tests cover the path with a fake fetch). What matters is that the person is
            // told, and a half-made target does not linger as "connected".
            const s = await snapshot();
            const t = s.targets.find((x) => x.name === 'GitHub sim');
            await page().keyboard.press('Escape');
            await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
            return `refused by github.com as expected without a network fake: "${String(outcome).replace(/\s+/g, ' ').slice(0, 120)}" · placeholder target ${t ? `${t.id} (${t.health})` : 'none'}`;
          }
          const row = page().locator('[data-target-id]').filter({ hasText: 'GitHub sim' });
          await row.waitFor({ timeout: 8000 });
          const meta = await row
            .locator('[data-target-meta="cli"]')
            .innerText()
            .catch(() => '(no meta)');
          const text = (await row.innerText()).replace(/\n/g, ' / ');
          expect(meta.includes('via gh · fake'), `meta: ${meta}`);
          const s = await snapshot();
          const t = s.targets.find((x) => x.name === 'GitHub sim');
          expect(t !== undefined && t.env === 'staging', `saved target: ${JSON.stringify(t)}`);
          return `${text} · ${meta}`;
        },
      );

      let ghTargetId = '';
      await sim.step(
        'Refresh (health) and Edit on the CLI target: the login terminal runs `gh auth login` inline',
        async () => {
          const s = await snapshot();
          const gh = s.targets.find((x) => x.name === 'GitHub sim');
          ghTargetId = gh?.id ?? '';
          expect(ghTargetId !== '', 'no GitHub sim target');
          if (!gh?.credentialRef)
            return `GitHub sim stayed a placeholder (github.com refused the fake token): Refresh / Edit not exercised here`;
          const row = page().locator(`[data-target-id="${ghTargetId}"]`);
          await row.locator('button[aria-label^="Refresh"]').click();
          await wait(800);
          const health = (await snapshot()).targets.find((x) => x.id === ghTargetId)?.health;
          const action = row
            .locator(
              'button[aria-label^="Edit"], button[aria-label^="Revoke"], button[aria-label^="Connect"]',
            )
            .first();
          const label = (await action.getAttribute('aria-label')) ?? '';
          await action.click();
          const dialog = page().getByRole('dialog');
          await dialog.waitFor({ timeout: 8000 });
          const term = page().locator('[data-login-terminal]');
          const termShown = await until(async () => ((await term.count()) > 0 ? true : null), 8000);
          const status = await until(async () => {
            const t = (await dialog.innerText()).replace(/\s+/g, ' ');
            return /exited with code|Signed in/.test(t) ? t : null;
          }, 10_000);
          await sim.shot('targets-reconnect-github');
          const line =
            /(gh auth login[^.]*\.)|(Signed in[^.]*\.)/.exec(status ?? '')?.[0] ?? '(no login status line)';
          await dialog.getByRole('button', { name: 'Close' }).last().click();
          return `health ${JSON.stringify(health)} · action "${label}" · login terminal ${termShown ? 'shown' : 'missing'} · ${line}`;
        },
      );

      await sim.step(
        'Connect · SSH: validation (empty, bad port), Save to a refused loopback port, the resulting row',
        async () => {
          await page()
            .getByRole('button', { name: /Connect a target: OAuth/ })
            .click();
          const dialog = await onProviderGrid();
          await dialog.locator('[data-provider="ssh"]').click();
          const save = dialog.getByRole('button', { name: 'Save', exact: true });
          const test = dialog.getByRole('button', { name: 'Test connection' });
          expect((await save.isDisabled()) && (await test.isDisabled()), 'SSH Save/Test enabled while empty');
          await dialog.getByLabel('Host').fill('127.0.0.1');
          await dialog.getByLabel('User').fill('sim');
          const keyFile = join(resolve(__dirname, 'out', 'design-deploy'), 'not-a-key');
          mkdirSync(resolve(__dirname, 'out', 'design-deploy'), { recursive: true });
          writeFileSync(keyFile, 'this is not a private key\n');
          await dialog.getByLabel('Key').fill(keyFile);
          await dialog.getByLabel('Port').fill('abc');
          expect(await save.isDisabled(), 'Save enabled with port "abc"');
          await dialog.getByLabel('Port').fill('1');
          expect(!(await save.isDisabled()), 'Save disabled with a valid form');
          await save.click();
          const closed = await until(async () => ((await dialog.count()) === 0 ? true : null), 25_000);
          expect(closed, 'SSH modal did not close after Save');
          const row = page().locator('[data-target-id]').filter({ hasText: '127.0.0.1' });
          await row.waitFor({ timeout: 8000 });
          const s = await snapshot();
          const t = s.targets.find((x) => x.name === '127.0.0.1');
          return `${(await row.innerText()).replace(/\n/g, ' / ')} · health ${JSON.stringify(t?.health)} · config keys ${Object.keys(t?.config ?? {}).join(',')}`;
        },
      );

      await sim.step('Remove a target: is there a way in the UI? (falls back to the command)', async () => {
        const row = page().locator(`[data-target-id="${ghTargetId}"]`);
        const labels = await row
          .locator('button')
          .evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') ?? b.textContent ?? ''));
        const hasRemove = labels.some((l) => /remove|delete/i.test(l));
        if (!hasRemove)
          sim.finding({
            severity: 'minor',
            title: 'No way to remove a target from Settings › Targets',
            repro: 'Settings › Targets · any row',
            expected: 'A Remove action (target.remove exists in the contract and audits "target removed")',
            observed: `row actions: ${labels.join(' | ')}`,
            where:
              'apps/desktop/src/renderer/screens/Settings/Settings.tsx Targets() — only Refresh / Revoke / Edit / Connect',
          });
        const r = await cmd('target.remove', { targetId: ghTargetId });
        expect(r.ok, `target.remove failed: ${r.error?.message}`);
        const gone = await until(async () => ((await row.count()) === 0 ? true : null), 5000);
        expect(gone, 'row still there after target.remove');
        return hasRemove ? 'UI has Remove' : `no Remove in UI (finding); command works`;
      });

      await sim.step(
        'Env & secrets: source and committed file (Share with agents was removed, issue #4)',
        async () => {
          await page().locator('[data-nav-item="project:env"]').click();
          const rows = page().locator('[data-settings-row]');
          await rows.first().waitFor({ timeout: 8000 });
          const idsSeen = await rows.evaluateAll((els) =>
            els.map((e) => e.getAttribute('data-settings-row')),
          );
          for (const id of ['envSource', 'committedFile'])
            expect(idsSeen.includes(id), `row ${id} missing: ${idsSeen.join(',')}`);
          expect(!idsSeen.includes('shareWithAgents'), 'Share with agents is back, but nothing applies it');
          const texts = await rows.allInnerTexts();
          return `rows: ${texts.map((t) => t.replace(/\n/g, ' ')).join(' | ')}`;
        },
      );

      await sim.step(
        '.styx/project.json is committed-safe: no secret-like keys, no fixture tokens',
        async () => {
          expect(existsSync(projectFile), `missing ${projectFile}`);
          const raw = readFileSync(projectFile, 'utf8');
          const file = JSON.parse(raw) as Record<string, unknown>;
          const bad = findSecretKeys(file);
          expect(bad.length === 0, `secret-like keys in project.json: ${bad.join(', ')}`);
          expect(
            !/FIXTURE-|AKIA-SIM|not-a-real-secret|ghp_|sk-/.test(raw),
            'a secret value leaked into project.json',
          );
          const targets = (file['targets'] as { name?: string; credentialRef?: string }[] | undefined) ?? [];
          return `keys ${Object.keys(file).join(',')} · dev ${JSON.stringify(file['dev'])} · ${targets.length} targets (credentialRef only)`;
        },
      );

      // =====================================================================================================
      // 7 · Layout at the window minimum
      // =====================================================================================================
      await sim.step('1100×680: the design bar and run row fit; nothing overflows', async () => {
        await sim.app.evaluate(({ BaseWindow }) => {
          const w = BaseWindow.getAllWindows()[0];
          w?.setSize(1100, 680);
        });
        await page().locator('[data-nav-item="workspace"]').click();
        await designTab();
        await wait(400);
        const over = await page().evaluate(() => {
          const out: string[] = [];
          for (const sel of ['[data-run-row]', '[data-design-pane]', '[data-status-bar]']) {
            const el = document.querySelector<HTMLElement>(sel);
            if (el && el.scrollWidth > el.clientWidth + 1)
              out.push(`${sel} ${el.scrollWidth}>${el.clientWidth}`);
          }
          const body = document.documentElement;
          if (body.scrollWidth > window.innerWidth + 1)
            out.push(`document ${body.scrollWidth}>${window.innerWidth}`);
          return out;
        });
        await sim.shot('layout-1100x680');
        if (over.length > 0)
          sim.finding({
            severity: 'minor',
            title: 'Horizontal overflow at the 1100×680 window minimum on the Design tab',
            repro: 'Window at 1100×680 · Workspace · Design tab (command field + presets in the run row)',
            expected: 'Everything fits at the minimum (no breakpoints, spec §3)',
            observed: over.join('; '),
            where: 'apps/desktop/src/renderer/features/preview/DesignPane.module.css runRow',
          });
        return over.length === 0 ? 'fits' : over.join('; ');
      });

      // --- leave nothing running -------------------------------------------------------------------------
      await sim.step('cleanup: no runs, devices or tasks left; port 3999 free', async () => {
        await cmd('run.stop', { projectId: acme });
        await cmd('run.stop', { projectId: blog });
        await cmd('device.stop', { projectId: acme, shutdown: true });
        const s = await snapshot();
        for (const t of s.sessions.filter((x) => x.purpose !== null && x.state !== 'done'))
          await cmd('session.stop', { sessionId: t.id });
        await wait(500);
        const still = listeners(PORT);
        expect(still === '', `port ${PORT} still held: ${still}`);
        const s2 = await snapshot();
        const runs = Object.values(s2.runs).filter((r) => r.phase !== 'exited');
        expect(runs.length === 0, `runs still alive: ${runs.map((r) => r.command).join(',')}`);
        return 'clean';
      });
    },
  );
  const leftover = listeners(PORT);
  if (leftover !== '')
    process.stdout.write(`\nWARNING port ${PORT} still held after the app closed: ${leftover}\n`);
});
