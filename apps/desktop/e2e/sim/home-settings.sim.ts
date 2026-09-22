import { test, type Locator } from '@playwright/test';
import { copy, fixtures, formatChord } from '@styx/core';
import { shortcuts } from '@styx/tokens';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { runSim } from './harness';

/**
 * User simulation · Home, projects, the project switcher and every Settings section (owner request, 2026-09-21).
 *
 * Drives the built app over the demo fixture the way a person would: reads the Home counters and rows, switches
 * projects by row / rail / palette, walks every App and Project settings section changing each row that can be
 * changed and checking the value, its persistence across a relaunch of the same profile, and the effect it
 * promises (theme → `data-theme`, fallback editor → the New project modal's "Open in … too", project rows →
 * `.styx/project.json`), connects agents (rescan → the fake CLIs on the e2e PATH, Verify, Connect agent modal,
 * Locate binary refusals through a stubbed OS picker), reads / installs / removes a skill in the fixture home,
 * creates projects (empty · agent-scaffolded by the fake Codex), removes them, adds one from the machine scan,
 * checks what a relaunch restores and how the shell holds up at the 1100×680 minimum.
 *
 * Never launches a real agent CLI: the demo rows name `/opt/homebrew/bin/*` binaries, so the sim re-detects first
 * (Settings › Agents › Rescan) and refuses to spawn unless the Codex row points into e2e/fixtures/bin. Never
 * installs into the real `~/.claude` / `~/.codex`: the fixture profile's skills home is `<userData>/fixture-home`
 * and the sim proves that before it installs.
 */

const { ids } = fixtures;
const PROJECT_TILE = (name: string) => `[data-rail] button[title="${name}"]`;
const NAV_HEAD = '[data-nav] .t-label';
const READY = (screen: string) => `[data-screen-ready="${screen}"]`;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const PLATFORM = process.platform === 'win32' ? 'win32' : 'darwin';

type Snapshot = {
  projects: { id: string; name: string; path: string; removedAt: number | null; railOrder: number }[];
  sessions: { id: string; projectId: string; agent: string; state: string }[];
  policies: { id: string; builtinKey: string | null; enabled: boolean }[];
  discovery: {
    clis: {
      agent: string;
      binary: string | null;
      version: string | null;
      found: boolean;
      capabilities: Record<string, unknown>;
      account: string | null;
    }[];
  };
  settings: {
    app: Record<string, unknown>;
    project: Record<string, Record<string, { value: unknown; source: string }>>;
  };
  ui: { screen: string | null; projectId: string | null; projectSession: Record<string, string> };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('sim: home-settings', async () => {
  await runSim('home-settings', { screen: 'home' }, async (sim) => {
    // The profile every relaunch reuses (the harness would otherwise mint a fresh temp dir each time).
    const userData = sim.userData;
    const sameProfile = (extra: Record<string, string> = {}) => ({ STYX_USER_DATA: userData, ...extra });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'styx-sim-home-'));
    const fakeBin = resolve(__dirname, '..', 'fixtures', 'bin');
    let fakesActive = false;

    // --- helpers ----------------------------------------------------------------------------------------------
    const page = () => sim.page;
    const ready = (screen: string, timeout = 20_000) => page().waitForSelector(READY(screen), { timeout });
    const snapshot = async (): Promise<Snapshot> => {
      const r = await sim.command<Snapshot>('store.snapshot', {});
      if (!r.ok || r.value === undefined) throw new Error(`store.snapshot failed: ${r.error?.message}`);
      return r.value;
    };
    const appSettings = async () => {
      const r = await sim.command<{ app: Record<string, unknown> }>('settings.get', {});
      if (!r.ok || r.value === undefined) throw new Error(`settings.get failed: ${r.error?.message}`);
      return r.value.app;
    };
    const navHead = () => page().locator(NAV_HEAD).first().innerText();
    const currentScreen = () =>
      page().evaluate(() => document.querySelector('[data-screen-ready]')?.getAttribute('data-screen-ready'));
    const goHome = async () => {
      await page().click('[data-app-rail-item="home"]');
      await ready('home');
    };
    const openAppSection = async (id: string) => {
      await page().click(`[data-app-rail-item="${id}"]`);
      await page().waitForSelector(`[data-settings-section="${id}"]`, { timeout: 10_000 });
    };
    const openProjectSection = async (id: string) => {
      await page().click(`[data-nav-item="${id}"]`);
      await page().waitForSelector(`[data-settings-section="${id}"]`, { timeout: 10_000 });
    };
    const rowSelect = (id: string): Locator => page().locator(`[data-settings-row="${id}"] select`);
    const setRow = async (id: string, value: string) => {
      await rowSelect(id).selectOption(value);
      await sleep(250);
      const shown = await rowSelect(id).inputValue();
      if (shown !== value) throw new Error(`${id}: selected ${value}, row shows ${shown}`);
    };
    const escapeAll = async () => {
      for (let i = 0; i < 4; i++) {
        if ((await page().locator('[role="dialog"], [role="menu"], [role="combobox"]').count()) === 0) break;
        await page().keyboard.press('Escape');
        await sleep(120);
      }
    };
    /** Stubs the OS file picker in main (a real dialog would hang the run) so "Locate binary" can be exercised. */
    const stubPicker = (path: string | null) =>
      sim.app.evaluate(({ dialog }, picked) => {
        (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({
          canceled: picked === null,
          filePaths: picked === null ? [] : [picked],
        });
      }, path);
    const projectFile = (path: string): Record<string, unknown> | null => {
      const file = join(path, '.styx', 'project.json');
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
    };
    const acmePath = async () => {
      const snap = await snapshot();
      const p = snap.projects.find((x) => x.id === ids.project.acmeShop);
      if (p === undefined) throw new Error('acme-shop missing from the snapshot');
      return p.path;
    };
    const removeViaRail = async (name: string) => {
      await page().click(PROJECT_TILE(name), { button: 'right' });
      await page().waitForSelector('[data-rail-add-menu] [data-rail-remove]', { timeout: 5000 });
      await page().click('[data-rail-add-menu] [data-rail-remove]');
      await page().waitForSelector(PROJECT_TILE(name), { state: 'detached', timeout: 10_000 });
    };

    // =========================================================================================================
    // 1. Home
    // =========================================================================================================
    await sim.step('Home: the four counters read what the fixture holds (02 · 03 · 02 · 05)', async () => {
      await ready('home');
      const tiles = page().locator(
        READY('home') + ' [aria-live], ' + READY('home') + ' div:has(> div[data-muted])',
      );
      const strip = page()
        .locator(READY('home'))
        .locator('div')
        .filter({ has: page().locator('[data-muted]') });
      void tiles;
      void strip;
      const text = await page().locator(READY('home')).innerText();
      const labels = [
        copy.counters.needsYou,
        copy.counters.agentsWorking,
        copy.counters.grantsActive,
        copy.counters.projects,
      ];
      for (const l of labels) if (!text.includes(l)) throw new Error(`counter label "${l}" missing`);
      // Expected from packages/core fixtures/demo.ts: needs-you = codex + blog; working = claude, infra, shell
      // (gemini is idle, cursor / side are done); live grants = Vercel prod (58m left) + Vercel preview (always).
      const expected = ['02', '03', '02', '05'];
      const numerals = await page().evaluate((labelList) => {
        const out: string[] = [];
        for (const label of labelList) {
          const el = Array.from(document.querySelectorAll('[data-muted]')).find(
            (n) => n.textContent?.trim() === label,
          );
          const tile = el?.parentElement;
          out.push((tile?.textContent ?? '').replace(label, '').trim());
        }
        return out;
      }, labels);
      for (const [i, n] of numerals.entries())
        if (n !== expected[i]) throw new Error(`${labels[i]} reads "${n}", expected ${expected[i]}`);
      await sim.shot('home');
      return numerals.join(' · ');
    });

    await sim.step(
      'Home: five project rows in rail order with agents · targets · last activity',
      async () => {
        const rows = page()
          .locator('[data-project-id]')
          .filter({ has: page().locator('[role="cell"]') });
        const names = await rows.locator('[role="cell"]:first-child').allInnerTexts();
        const want = ['acme-shop', 'blog-v2', 'infra-tools', 'client-x', 'side-api'];
        if (names.map((n) => n.trim()).join(',') !== want.join(','))
          throw new Error(`rows read ${names.join(' | ')}`);
        const acme = page().locator(`[role="row"][data-project-id="${ids.project.acmeShop}"]`);
        const acmeText = await acme.innerText();
        for (const s of [
          'Claude, Codex, Gemini',
          'Vercel, Supabase, AWS, GitHub',
          '2m',
          'demo-repos/acme-shop',
        ])
          if (!acmeText.includes(s))
            throw new Error(`acme-shop row lacks "${s}": ${acmeText.replace(/\n/g, ' · ')}`);
        if ((await acme.locator('[data-on="true"]').count()) === 0)
          throw new Error('acme-shop has a needs-you session but no accent status square');
        const blog = await page()
          .locator(`[role="row"][data-project-id="${ids.project.blogV2}"]`)
          .innerText();
        for (const s of ['Claude', 'Vercel, GitHub', '9m'])
          if (!blog.includes(s)) throw new Error(`blog-v2 lacks "${s}"`);
        const side = await page()
          .locator(`[role="row"][data-project-id="${ids.project.sideApi}"]`)
          .innerText();
        for (const s of ['—', 'Supabase', '2d'])
          if (!side.includes(s)) throw new Error(`side-api lacks "${s}"`);
        const infra = page().locator(`[role="row"][data-project-id="${ids.project.infraTools}"]`);
        if ((await infra.locator('[data-on="true"]').count()) !== 0)
          throw new Error('infra-tools shows a needs-you square without a needs-you session');
        return `${names.length} rows`;
      },
    );

    await sim.step('Home: the activity feed is newest first (2m … 1d)', async () => {
      const rows = page().locator('[data-activity-feed] li');
      const n = await rows.count();
      if (n !== 6) throw new Error(`${n} activity rows, expected 6`);
      const times = await rows.locator('span:first-child').allInnerTexts();
      const want = ['2m', '3m', '9m', '31m', '1h', '1d'];
      if (times.join(',') !== want.join(',')) throw new Error(`ages read ${times.join(',')}`);
      const first = await rows.first().innerText();
      if (!first.includes('Claude') || !first.includes('edited checkout.ts'))
        throw new Error(`first row reads "${first}"`);
      return times.join(' ');
    });

    await sim.step(
      'Home: the add row offers New project · Add from recent · Open folder · Clone URL',
      async () => {
        for (const label of Object.values(copy.home.addRow)) {
          const b = page().getByRole('button', { name: label, exact: true });
          if ((await b.count()) !== 1) throw new Error(`add-row button "${label}" missing`);
        }
      },
    );

    await sim.step("Click a project row → that project's Workspace, nav named after it", async () => {
      await page().click(`[role="row"][data-project-id="${ids.project.blogV2}"]`);
      await ready('workspace');
      const head = await navHead();
      if (head !== 'blog-v2') throw new Error(`nav head reads "${head}"`);
      const inv = await page().locator('[data-nav-item="workspace"]').getAttribute('data-inv');
      if (inv !== 'true') throw new Error('Workspace nav row is not marked current');
      await sim.shot('workspace-blog-v2');
    });

    await sim.step(
      'Rail tiles switch projects and the nav follows; from Home a tile lands in Workspace',
      async () => {
        await page().click(PROJECT_TILE('infra-tools'));
        await sleep(200);
        if ((await navHead()) !== 'infra-tools') throw new Error(`nav head reads "${await navHead()}"`);
        const on = await page().locator(PROJECT_TILE('infra-tools')).getAttribute('data-on');
        if (on !== 'true') throw new Error('current project tile is not data-on');
        const current = await page().locator(PROJECT_TILE('infra-tools')).getAttribute('aria-current');
        if (current !== 'true') throw new Error(`aria-current is ${current}`);
        await goHome();
        await page().click(PROJECT_TILE('client-x'));
        await ready('workspace');
        if ((await navHead()) !== 'client-x') throw new Error(`nav head reads "${await navHead()}"`);
        // The project rail stays put while the app rail's tile is current (two rails, two vocabularies).
        const tiles = await page().locator('[data-rail] button[data-project-id]').count();
        if (tiles !== 5) throw new Error(`${tiles} project tiles`);
      },
    );

    await sim.step(
      'Keyboard: Mod+P opens the palette in the Projects scope and Enter switches (spec §6)',
      async () => {
        await page().keyboard.press(`${MOD}+P`);
        const box = page().getByRole('combobox');
        await box.waitFor({ timeout: 5000 });
        const options = page().getByRole('option');
        const labels = await options.allInnerTexts();
        const nonProject = labels.filter(
          (l) => !l.includes(copy.palette.actions.switchProject.split(' ')[0] ?? 'Switch'),
        );
        if (nonProject.length > 0)
          throw new Error(`Projects scope lists non-project rows: ${nonProject.slice(0, 3).join(' | ')}`);
        await page().keyboard.type('side');
        await sleep(150);
        const side = page().getByRole('option').filter({ hasText: 'side-api' });
        if ((await side.count()) !== 1) throw new Error(`"side" matches ${await side.count()} rows`);
        await page().keyboard.press('Enter');
        await page().getByRole('combobox').waitFor({ state: 'detached', timeout: 5000 });
        await sleep(200);
        if ((await navHead()) !== 'side-api')
          throw new Error(`after Enter the nav reads "${await navHead()}"`);
        const snap = await snapshot();
        if (snap.ui.projectId !== ids.project.sideApi)
          throw new Error('main did not record the selected project');
        // Mod+1–4 are agent-tab focus inside the Workspace (tokens `focusAgent`); no Mod+1–9 project chord exists.
        await page().keyboard.press(`${MOD}+2`);
        await sleep(150);
        if ((await navHead()) !== 'side-api')
          throw new Error('Mod+2 switched projects; spec §6 reserves it for agent tabs');
        return `${labels.length} project rows in scope`;
      },
    );

    // =========================================================================================================
    // 2. Settings › App — every section from the app rail
    // =========================================================================================================
    await sim.step(
      'Settings › App: all seven sections open from the app rail with the right heading',
      async () => {
        await page().click(PROJECT_TILE('acme-shop'));
        await sleep(150);
        const want: Record<string, string> = {
          'app:general': copy.settings.app.general,
          'app:editor': copy.settings.app.editor,
          'app:agents': copy.agentsPage.title,
          'app:skills': copy.skills.title,
          'app:keychain': copy.settings.app.keychain,
          'app:policies': copy.settings.app.policies,
          'app:shortcuts': copy.settings.app.shortcuts,
        };
        const mismatches: string[] = [];
        for (const [id, heading] of Object.entries(want)) {
          await openAppSection(id);
          const title = (await page().locator('#settings-title').innerText()).trim();
          if (title !== heading) mismatches.push(`${id}: "${title}" ≠ "${heading}"`);
          const scope = (await page().locator('[data-settings-scope]').innerText()).trim();
          if (scope !== copy.settings.scope.app) mismatches.push(`${id}: scope "${scope}"`);
          const active = await page().locator(`[data-app-rail-item="${id}"]`).getAttribute('data-on');
          if (active !== 'true') mismatches.push(`${id}: rail tile not current`);
          if ((await page().locator('[data-settings-file]').count()) !== 0)
            mismatches.push(`${id}: shows the project.json note`);
        }
        if (mismatches.length > 0) throw new Error(mismatches.join('; '));
        // Tile tooltips name the same places as the headings, except two.
        const tooltipsDiffer = ['app:general', 'app:agents'].map(
          (id) => `${copy.appRail.sections[id as keyof typeof copy.appRail.sections]} → ${want[id]}`,
        );
        return `tooltip vs heading: ${tooltipsDiffer.join(', ')}`;
      },
    );

    await sim.step(
      'General: Theme changes data-theme at once; Notify and Launch at login take a value',
      async () => {
        await openAppSection('app:general');
        await setRow('theme', 'light');
        await page().waitForFunction(() => document.documentElement.dataset['theme'] === 'light', undefined, {
          timeout: 5000,
        });
        await sim.shot('general-light');
        await setRow('theme', 'dark');
        await page().waitForFunction(() => document.documentElement.dataset['theme'] === 'dark', undefined, {
          timeout: 5000,
        });
        await setRow('theme', 'system');
        await sleep(300);
        const resolved = await page().evaluate(() => document.documentElement.dataset['theme']);
        if (resolved !== 'dark' && resolved !== 'light')
          throw new Error(`system theme resolved to ${resolved}`);
        await setRow('theme', 'light');
        await setRow('notify', 'badge');
        await setRow('launchAtLogin', 'on');
        const app = await appSettings();
        if (app['theme'] !== 'light' || app['notify'] !== 'badge' || app['launchAtLogin'] !== true)
          throw new Error(
            `main holds theme=${app['theme']} notify=${app['notify']} launchAtLogin=${app['launchAtLogin']}`,
          );
        return `system → ${resolved}`;
      },
    );

    await sim.step(
      'Editor: Open files in · Fallback editor · Line endings · Screen reader · Track agent edits',
      async () => {
        await openAppSection('app:editor');
        const engine = await rowSelect('engine').locator('option').first().innerText();
        if (engine !== copy.settings.values.engine) throw new Error(`engine reads "${engine}"`);
        const ideOptions = await rowSelect('fallbackEditor').locator('option').allInnerTexts();
        if (!ideOptions.includes('Cursor') || !ideOptions.includes('VS Code'))
          throw new Error(`fallback editor options: ${ideOptions.join(', ')}`);
        await setRow('openFilesIn', 'fallback');
        await setRow('fallbackEditor', 'cursor');
        await setRow('lineEndings', 'lf');
        await setRow('screenReader', 'on');
        await setRow('trackAgentEdits', 'off');
        const app = await appSettings();
        const bad: string[] = [];
        if (app['openFilesIn'] !== 'fallback') bad.push(`openFilesIn=${app['openFilesIn']}`);
        if (app['fallbackIde'] !== 'cursor') bad.push(`fallbackIde=${app['fallbackIde']}`);
        if (app['screenReader'] !== true) bad.push(`screenReader=${app['screenReader']}`);
        if (app['trackAgentEdits'] !== false) bad.push(`trackAgentEdits=${app['trackAgentEdits']}`);
        // Line endings is a per-project value on an App page: it lands in acme-shop's .styx/project.json.
        const file = projectFile(await acmePath());
        if (file?.['lineEndings'] !== 'lf')
          bad.push(`project.json lineEndings=${String(file?.['lineEndings'])}`);
        if (bad.length > 0) throw new Error(bad.join('; '));
        const scope = (await page().locator('[data-settings-scope]').innerText()).trim();
        return `Line endings wrote project.json of acme-shop while the page scope reads "${scope}"`;
      },
    );

    await sim.step(
      'Editor: the fallback editor drives "Open in … too" in the New project modal',
      async () => {
        await page().click('[data-rail-add]');
        await page().getByRole('menuitem', { name: copy.rail.menu.newProject }).click();
        await page().waitForSelector('[data-new-project-modal="true"]', { timeout: 5000 });
        const label = page().getByText('Open in Cursor too');
        if ((await label.count()) !== 1) throw new Error('modal does not offer "Open in Cursor too"');
        await page().keyboard.press('Escape');
        await page().waitForSelector('[data-new-project-modal]', { state: 'detached', timeout: 5000 });
      },
    );

    // --- Agent connections --------------------------------------------------------------------------------
    await sim.step("Agent connections: five rows with the fixture's accounts and states", async () => {
      await openAppSection('app:agents');
      const rows = page().locator('[data-agent-row]');
      if ((await rows.count()) !== 5) throw new Error(`${await rows.count()} rows`);
      const states: Record<string, string | null> = {};
      for (const a of ['claude', 'codex', 'gemini', 'cursor', 'shell'])
        states[a] = await page().locator(`[data-agent-row="${a}"]`).getAttribute('data-agent-state');
      const want = {
        claude: 'connected',
        codex: 'connected',
        gemini: 'signed-out',
        cursor: 'unverified',
        shell: 'shell',
      };
      for (const [a, s] of Object.entries(want))
        if (states[a] !== s) throw new Error(`${a} is ${states[a]}, expected ${s}`);
      const claude = await page().locator('[data-agent-row="claude"]').innerText();
      if (!claude.includes('nic@acme.dev')) throw new Error('claude row lacks its account');
      await sim.shot('agents-fixture');
      return Object.entries(states)
        .map(([a, s]) => `${a}:${s}`)
        .join(' ');
    });

    await sim.step(
      'Agent connections: Rescan finds the CLIs on the PATH (the e2e fakes take over the fixture rows)',
      async () => {
        await page().click('[data-agent-rescan]');
        await page()
          .locator('[data-agent-row="claude"]')
          .filter({ hasText: '99.0.0' })
          .waitFor({ timeout: 45_000 });
        const snap = await snapshot();
        const codex = snap.discovery.clis.find((c) => c.agent === 'codex');
        const claude = snap.discovery.clis.find((c) => c.agent === 'claude');
        const cursor = snap.discovery.clis.find((c) => c.agent === 'cursor');
        const inFakes = (b: string | null | undefined) => (b ?? '').startsWith(fakeBin);
        if (!inFakes(codex?.binary)) throw new Error(`codex resolved to ${codex?.binary}, not the fake`);
        if (!inFakes(claude?.binary)) throw new Error(`claude resolved to ${claude?.binary}, not the fake`);
        if (codex?.capabilities['appServer'] !== true)
          throw new Error('fake codex --help not read for app-server');
        fakesActive = true;
        await sim.shot('agents-rescanned');
        return `codex ${codex?.version} · claude ${claude?.version} · cursor ${cursor?.found ? 'found' : 'not installed'}`;
      },
    );

    await sim.step(
      'Agent connections: Verify · Codex reads the account through the app-server; Verify · Claude Code too',
      async () => {
        if (!fakesActive) throw new Error('skipped: fakes are not active, a Verify would run a real CLI');
        await page()
          .locator('[data-agent-row="codex"]')
          .getByRole('button', { name: /^Verify · Codex/ })
          .click();
        await page()
          .locator('[data-agent-row="codex"]')
          .filter({ hasText: 'nic@fake.dev' })
          .waitFor({ timeout: 20_000 });
        const codexState = await page().locator('[data-agent-row="codex"]').getAttribute('data-agent-state');
        if (codexState !== 'connected') throw new Error(`codex is ${codexState} after Verify`);
        await page()
          .locator('[data-agent-row="claude"]')
          .getByRole('button', { name: /^Verify · Claude Code/ })
          .click();
        await page()
          .locator('[data-agent-row="claude"]')
          .filter({ hasText: 'fake@example.com' })
          .waitFor({ timeout: 20_000 });
        const gemini = await page().locator('[data-agent-row="gemini"]').getAttribute('data-agent-state');
        return `gemini after rescan: ${gemini}`;
      },
    );

    await sim.step(
      'Agent connections: the preference rows (default agent, worktree per agent, shell, detected CLIs, binaries)',
      async () => {
        const detected = await rowSelect('detectedClis').locator('option').first().innerText();
        if (!detected.includes('claude') || !detected.includes('codex'))
          throw new Error(`Detected CLIs reads "${detected}"`);
        await setRow('autoWorktree', 'off');
        await setRow('shellWindows', 'wsl');
        const app = await appSettings();
        if (app['autoWorktreePerAgent'] !== false) throw new Error('autoWorktreePerAgent did not turn off');
        const file = projectFile(await acmePath());
        const shell = (file?.['shell'] as { windows?: string } | undefined)?.windows;
        if (shell !== 'wsl') throw new Error(`project.json shell.windows=${String(shell)}`);
        const binaryRows = await page().locator('[data-settings-row^="cliBinary:"]').count();
        const claudeOptions =
          binaryRows > 0 ? await rowSelect('cliBinary:claude').locator('option').allInnerTexts() : [];
        return `${binaryRows} "{cli} binary" rows; claude offers ${claudeOptions.length}: ${claudeOptions.join(' | ')}`;
      },
    );

    await sim.step(
      'Connect agent · Cursor (not installed): Install · Install guide · Locate binary · path field · where it looked',
      async () => {
        await page()
          .locator('[data-agent-row="cursor"]')
          .getByRole('button', { name: /^Connect · Cursor agent/ })
          .click();
        const dialog = page().getByRole('dialog');
        await dialog.waitFor({ timeout: 5000 });
        const title = await dialog.innerText();
        if (!title.includes('Connect Cursor agent')) throw new Error('heading missing');
        const installed = await dialog.locator('[data-cli-installed]').getAttribute('data-cli-installed');
        if (installed !== 'false') throw new Error(`data-cli-installed=${installed}`);
        for (const name of [copy.agentsPage.actions.installGuide, copy.agentsPage.actions.locate])
          if ((await dialog.getByRole('button', { name }).count()) !== 1)
            throw new Error(`"${name}" missing`);
        if ((await dialog.locator('[data-agent-install]').count()) !== 1)
          throw new Error('Install … missing');
        if ((await dialog.locator('[data-agent-path]').count()) !== 1) throw new Error('path field missing');
        const where = await dialog.getByRole('button', { name: copy.agentsPage.connect.showWhere }).count();
        if (where === 1) {
          await dialog.getByRole('button', { name: copy.agentsPage.connect.showWhere }).click();
          const dirs = await dialog.locator('[data-agent-searched] li').count();
          if (dirs === 0) throw new Error('"Show where" lists nothing');
        }
        await sim.shot('connect-cursor');
        return where === 1 ? 'searched folders listed' : 'no "Show where" (nothing scanned)';
      },
    );

    await sim.step(
      'Locate binary: a file that is not the CLI is refused with the reason inline',
      async () => {
        const dialog = page().getByRole('dialog');
        await stubPicker('/bin/ls');
        await dialog.getByRole('button', { name: copy.agentsPage.actions.locate }).click();
        const err = dialog.locator('[data-locate-error]');
        await err.waitFor({ timeout: 15_000 });
        const text = await err.innerText();
        if (!text.includes('/bin/ls')) throw new Error(`refusal reads "${text}"`);
        await stubPicker(join(fakeBin, 'codex'));
        await dialog.getByRole('button', { name: copy.agentsPage.actions.locate }).click();
        await dialog.locator('[data-locate-error]').filter({ hasText: 'Codex' }).waitFor({ timeout: 15_000 });
        const other = await dialog.locator('[data-locate-error]').innerText();
        const cursor = (await snapshot()).discovery.clis.find((c) => c.agent === 'cursor');
        if (cursor?.found) throw new Error('a refused pick was remembered as the cursor binary');
        await sim.shot('locate-refused');
        return `${text} // ${other}`;
      },
    );

    await sim.step(
      'Path field: "Use" with a wrong path tells the user why (like Locate binary does)',
      async () => {
        const dialog = page().getByRole('dialog');
        await dialog.locator('[data-agent-path]').fill('/bin/ls');
        await dialog.getByRole('button', { name: copy.agentsPage.actions.use }).click();
        await sleep(1500);
        const inline = await dialog
          .locator('[data-locate-error]')
          .innerText()
          .catch(() => '');
        const toasts = await page().getByRole('status').allInnerTexts();
        const toast = toasts.find((t) => t.includes('/bin/ls'));
        if (inline.includes('/bin/ls') && inline.includes('did not run')) return 'inline reason';
        if (toast !== undefined) {
          sim.finding({
            severity: 'minor',
            title:
              'Connect agent: a refused "Path or command" only shows as a toast, not inline like Locate binary',
            repro:
              'Settings › Agent connections › Connect · Cursor agent → type /bin/ls in "Path or command" → Use',
            expected:
              'the same inline reason the Locate binary pick gets (the field keeps the text, the reason sits under it)',
            observed: `the field is left as typed and an error toast appears: "${toast.split('\n')[0]}"`,
            where:
              'apps/desktop/src/renderer/features/modals/ConnectAgentModal.tsx applyPath (`if (!set.ok) return;`)',
          });
          return 'toast only';
        }
        throw new Error(`no feedback at all (inline "${inline}", toasts: ${toasts.join(' | ')})`);
      },
    );

    await sim.step(
      "Escape closes the Connect agent modal and focus returns to the row's Connect button",
      async () => {
        await page().keyboard.press('Escape');
        await page().getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });
        const focused = await page().evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return `${el?.closest('[data-agent-row]')?.getAttribute('data-agent-row') ?? '-'}:${el?.textContent?.trim() ?? ''}`;
        });
        if (!focused.startsWith('cursor:')) throw new Error(`focus landed on ${focused}`);
        return focused;
      },
    );

    await sim.step(
      'Connect agent · Claude Code (installed): version/location, identity, Sign in, Verify, Done',
      async () => {
        await page()
          .locator('[data-agent-row="claude"]')
          .getByRole('button', { name: /Reconnect · Claude Code|Connect · Claude Code/ })
          .click();
        const dialog = page().getByRole('dialog');
        await dialog.waitFor({ timeout: 5000 });
        await dialog.locator('[data-agent-identity="connected"]').waitFor({ timeout: 15_000 });
        const status = await dialog.locator('[data-cli-installed="true"]').innerText();
        if (!status.includes('99.0.0') || !status.includes(fakeBin))
          throw new Error(`status line reads "${status}"`);
        const identity = await dialog.locator('[data-agent-identity]').innerText();
        if (!identity.includes('fake@example.com')) throw new Error(`identity reads "${identity}"`);
        if ((await dialog.locator('[data-agent-sign-in]').count()) !== 1)
          throw new Error('Sign in with … missing');
        if ((await dialog.locator('[data-agent-verify]').count()) !== 1) throw new Error('Verify missing');
        await sim.shot('connect-claude');
        await dialog.locator('[data-agent-done]').click();
        await dialog.waitFor({ state: 'detached', timeout: 5000 });
        return identity;
      },
    );

    // --- Skills ---------------------------------------------------------------------------------------------
    const fixtureHome = join(userData, 'fixture-home');
    await sim.step(
      'Skills: reads the fixture home (never ~/.claude); three installed rows, search, agent filter',
      async () => {
        if (!existsSync(join(fixtureHome, '.claude', 'skills', 'pdf', 'SKILL.md')))
          throw new Error('the fixture home was not seeded; refusing to touch skills');
        await openAppSection('app:skills');
        const pane = page().locator('[data-skills-pane]');
        const installed = pane.locator('[data-skills-installed] [data-skill]');
        await installed.first().waitFor({ timeout: 10_000 });
        if ((await installed.count()) !== 3) throw new Error(`${await installed.count()} installed rows`);
        const texts = await installed.allInnerTexts();
        if (!texts.some((t) => t.includes('pdf') && t.includes('You'))) throw new Error('pdf · You missing');
        if (!texts.some((t) => t.includes('release-notes') && t.includes('Project')))
          throw new Error('release-notes · Project missing');
        if (!texts.some((t) => t.includes('sql-review') && t.includes('Shared')))
          throw new Error('sql-review · Shared missing');
        const search = page().getByRole('textbox', { name: copy.skills.search });
        await search.fill('sql');
        await sleep(150);
        if ((await installed.count()) !== 1)
          throw new Error(`search "sql" leaves ${await installed.count()} rows`);
        await search.fill('zzz-nothing');
        await sleep(150);
        if ((await pane.locator('[data-skills-nomatch]').count()) === 0)
          throw new Error('no "No skills match" note');
        await search.fill('');
        await page()
          .locator('[data-skills-host-filter]')
          .getByText(copy.skills.hostsShort.claude, { exact: true })
          .click();
        await sleep(150);
        const claudeRows = await installed.count();
        await page()
          .locator('[data-skills-host-filter]')
          .getByText(copy.skills.filterAll, { exact: true })
          .click();
        await sim.shot('skills');
        return `Claude filter → ${claudeRows} rows`;
      },
    );

    await sim.step(
      'Skills: the catalogue lists three, Read opens the skill text with the security line',
      async () => {
        const catalogue = page().locator('[data-skills-catalogue] [data-catalogue-skill]');
        await catalogue.first().waitFor({ timeout: 15_000 });
        if ((await catalogue.count()) !== 3) throw new Error(`${await catalogue.count()} catalogue rows`);
        const pdf = await page().locator('[data-catalogue-skill="pdf"]').innerText();
        if (!pdf.includes('Installed')) throw new Error('pdf is installed for Claude but not tagged');
        await page()
          .locator('[data-catalogue-skill="xlsx"]')
          .getByRole('button', { name: `${copy.skills.read} · xlsx` })
          .click();
        const drawer = page().getByRole('dialog', { name: copy.skills.drawerHeading });
        await drawer.waitFor({ timeout: 5000 });
        await drawer.getByRole('heading', { name: 'Rules' }).waitFor({ timeout: 10_000 });
        if ((await drawer.locator('[data-skill-warning]').count()) !== 1)
          throw new Error('security line missing');
        await sim.shot('skill-drawer');
      },
    );

    await sim.step(
      'Skills: install xlsx for Codex only → lands in the fixture home, toast, listed; Remove takes it back',
      async () => {
        const realCodexSkill = join(homedir(), '.codex', 'skills', 'xlsx');
        const realBefore = existsSync(realCodexSkill);
        const drawer = page().getByRole('dialog', { name: copy.skills.drawerHeading });
        for (const host of ['claude', 'codex', 'gemini', 'cursor']) {
          const box = drawer.locator(`[data-skill-host="${host}"]`);
          if ((await box.isChecked()) !== (host === 'codex'))
            await drawer.locator(`label:has([data-skill-host="${host}"])`).click();
        }
        await drawer.getByRole('button', { name: copy.skills.install, exact: true }).click();
        await drawer.waitFor({ state: 'detached', timeout: 10_000 });
        const file = join(fixtureHome, '.codex', 'skills', 'xlsx', 'SKILL.md');
        for (let i = 0; i < 40 && !existsSync(file); i++) await sleep(250);
        if (!existsSync(file)) throw new Error(`SKILL.md not written under ${fixtureHome}`);
        if (existsSync(realCodexSkill) !== realBefore) throw new Error('the REAL ~/.codex/skills changed');
        await page().getByText('Installed xlsx for Codex').waitFor({ timeout: 5000 });
        const installed = page().locator('[data-skills-installed] [data-skill]');
        await installed.filter({ hasText: 'xlsx' }).waitFor({ timeout: 5000 });
        await installed
          .filter({ hasText: 'xlsx' })
          .getByRole('button', { name: `${copy.skills.remove} · xlsx` })
          .click();
        await installed.filter({ hasText: 'xlsx' }).waitFor({ state: 'detached', timeout: 10_000 });
        for (let i = 0; i < 40 && existsSync(file); i++) await sleep(250);
        if (existsSync(file)) throw new Error('SKILL.md still on disk after Remove');
        await page().getByText('Removed xlsx').waitFor({ timeout: 5000 });
      },
    );

    // --- Keychain, Policies, Shortcuts -----------------------------------------------------------------------
    await sim.step(
      'Keychain & secrets: Store · MFA words follow the platform; Inject as takes a value',
      async () => {
        await openAppSection('app:keychain');
        const store = await rowSelect('store').locator('option').first().innerText();
        const mfa = await rowSelect('mfaProdWrite').locator('option').first().innerText();
        if (store !== 'macOS Keychain' || mfa !== 'Touch ID')
          throw new Error(`store "${store}", mfa "${mfa}"`);
        await setRow('injectAs', 'env');
        if ((await appSettings())['injectAs'] !== 'env') throw new Error('injectAs not stored');
        return `${store} · ${mfa}`;
      },
    );

    await sim.step(
      'Policies: Auto-approve staging reads toggles the builtin rule; idle expiry and Export are read-only',
      async () => {
        await openAppSection('app:policies');
        const before = await rowSelect('autoApproveStagingReads').inputValue();
        if (before !== 'off') throw new Error(`demo rule starts ${before}, the fixture renders it unchecked`);
        await setRow('autoApproveStagingReads', 'on');
        const rule = (await snapshot()).policies.find((p) => p.builtinKey === 'auto-read-staging-preview');
        if (rule?.enabled !== true) throw new Error('policy row did not enable the builtin rule');
        const idle = await rowSelect('grantIdleExpiry').locator('option').first().innerText();
        const exportOpts = await rowSelect('export').locator('option').allInnerTexts();
        const exportDisabled = await rowSelect('export').isDisabled();
        sim.finding({
          severity: 'polish',
          title: 'Settings › Policies › Export is a one-option select that does nothing',
          repro: 'Settings › Policies → the Export row',
          expected:
            'an action (the Policies tab under Approvals has a real "Export JSON" button) or a plain value, not a dropdown',
          observed: `an enabled Select whose only option is "${exportOpts.join('/')}"; choosing it changes nothing (disabled=${exportDisabled})`,
          where:
            "apps/desktop/src/renderer/screens/Settings/rows.ts policiesRows (`fixed('export', …)`), prototype settingsRowsMap",
        });
        return `idle expiry "${idle}", export options ${exportOpts.join('/')}`;
      },
    );

    await sim.step(
      'Shortcuts: the four rows match styx-tokens.json (palette · switch project · focus agent · approve/deny)',
      async () => {
        await openAppSection('app:shortcuts');
        const want: Record<string, string> = {
          palette: formatChord(shortcuts.palette, PLATFORM),
          switchProject: formatChord(shortcuts.switchProject, PLATFORM),
          focusAgent: `${formatChord(shortcuts.focusAgent[0] ?? 'Mod+1', PLATFORM)}–${(shortcuts.focusAgent.at(-1) ?? 'Mod+4').split('+').at(-1)}`,
          approveDeny: `${formatChord(shortcuts.approve, PLATFORM)} / ${formatChord(shortcuts.deny, PLATFORM)}`,
        };
        const bad: string[] = [];
        for (const [id, chord] of Object.entries(want)) {
          const shown = await rowSelect(id).locator('option').first().innerText();
          if (shown !== chord) bad.push(`${id}: "${shown}" ≠ "${chord}"`);
        }
        if (bad.length > 0) throw new Error(bad.join('; '));
        const rows = await page().locator('[data-settings-row]').count();
        const tokenCount = Object.keys(shortcuts).length;
        return `${rows} rows shown of ${tokenCount} token shortcuts (prototype lists four)`;
      },
    );

    // =========================================================================================================
    // 3. Settings › Project (rows in the project nav)
    // =========================================================================================================
    await sim.step(
      'Project nav: Targets · Agent defaults · Env & secrets open the project sections with the file note',
      async () => {
        const bad: string[] = [];
        for (const [id, label] of [
          ['project:targets', copy.settings.project.targets],
          ['project:agent-defaults', copy.settings.project.agentDefaults],
          ['project:env', copy.settings.project.env],
        ] as const) {
          await openProjectSection(id);
          const title = (await page().locator('#settings-title').innerText()).trim();
          if (title !== label) bad.push(`${id}: "${title}"`);
          const scope = (await page().locator('[data-settings-scope]').innerText()).trim();
          if (scope !== 'project · acme-shop') bad.push(`${id}: scope "${scope}"`);
          const note = (await page().locator('[data-settings-file]').innerText()).trim();
          if (!note.includes(copy.settings.footer.file)) bad.push(`${id}: note "${note}"`);
          const inv = await page().locator(`[data-nav-item="${id}"]`).getAttribute('data-inv');
          if (inv !== 'true') bad.push(`${id}: nav row not current`);
        }
        if (bad.length > 0) throw new Error(bad.join('; '));
        await openProjectSection('project:targets');
        const targets = await page().locator('[data-target-id]').count();
        if (targets !== 5) throw new Error(`${targets} target rows for acme-shop`);
      },
    );

    await sim.step(
      'Agent defaults: Default agent → Codex, Model, Auto-approve edits reach .styx/project.json; Reset appears',
      async () => {
        await openProjectSection('project:agent-defaults');
        const path = await acmePath();
        await setRow('defaultAgent', 'codex');
        await sleep(300);
        const modelOptions = await rowSelect('model')
          .locator('option')
          .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
        const pick = modelOptions.find((v) => v !== 'default') ?? null;
        if (pick !== null) await setRow('model', pick);
        await setRow('autoApproveEdits', 'on');
        await sleep(300);
        const file = projectFile(path);
        const agents = (file?.['agents'] ?? {}) as Record<string, unknown>;
        const bad: string[] = [];
        if (agents['default'] !== 'codex') bad.push(`agents.default=${String(agents['default'])}`);
        if (pick !== null && agents['model'] !== pick)
          bad.push(`agents.model=${String(agents['model'])} (picked ${pick})`);
        if (agents['autoApproveEdits'] !== true)
          bad.push(`agents.autoApproveEdits=${String(agents['autoApproveEdits'])}`);
        const overridden = await page()
          .locator('[data-settings-row="defaultAgent"]')
          .getAttribute('data-overridden');
        if (overridden !== 'true') bad.push('Default agent row is not marked overridden');
        const reset = page()
          .locator('[data-settings-row="defaultAgent"]')
          .getByRole('button', { name: copy.settings.reset });
        if ((await reset.count()) !== 1) bad.push('no Reset on the overridden row');
        if (bad.length > 0) throw new Error(bad.join('; '));
        await sim.shot('agent-defaults');
        return `model options: ${modelOptions.join(', ')}`;
      },
    );

    await sim.step(
      'Agent defaults: Permission mode, Styx tasks mode and Effort reach the file the page names',
      async () => {
        const path = await acmePath();
        await setRow('permissionMode', 'acceptEdits');
        await setRow('taskPermissionMode', 'default');
        const hasEffort = (await rowSelect('effort').count()) === 1;
        if (hasEffort) {
          const opts = await rowSelect('effort')
            .locator('option')
            .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
          const pick = opts.find((v) => v !== 'default');
          if (pick !== undefined) await setRow('effort', pick);
        }
        await sleep(300);
        const snap = await snapshot();
        const eff = snap.settings.project[ids.project.acmeShop] ?? {};
        if (eff['permissionMode']?.value !== 'acceptEdits' || eff['permissionMode']?.source !== 'project')
          throw new Error(
            `SQLite permissionMode=${String(eff['permissionMode']?.value)} (${eff['permissionMode']?.source})`,
          );
        if (eff['taskPermissionMode']?.value !== 'default')
          throw new Error('SQLite taskPermissionMode not stored');
        const agents = (projectFile(path)?.['agents'] ?? {}) as Record<string, unknown>;
        const missing = ['permissionMode', 'taskPermissionMode', ...(hasEffort ? ['effort'] : [])].filter(
          (k) => agents[k] === undefined,
        );
        if (missing.length > 0) {
          sim.finding({
            severity: 'major',
            title:
              'Agent defaults: Permission mode, Styx tasks mode and Effort never reach .styx/project.json',
            repro:
              'Project nav › Agent defaults → set Permission mode / Styx tasks / Effort → open <repo>/.styx/project.json',
            expected:
              'the page header says ".styx/project.json · committed · secrets excluded" and the file schema has agents.permissionMode / taskPermissionMode / effort, so the values travel with the repo',
            observed: `stored in SQLite only (snapshot shows source "project"); the file\'s agents block has no ${missing.join(' / ')} key`,
            where:
              'apps/desktop/src/main/services/project-service.ts applySettingsToFile writes agents.default/model/autoApproveEdits/mayRequestTargets/notifyWhenNeedsMe only; packages/core/src/project-file.ts projectFileAgentsSchema and mergeSettings read the three keys',
          });
          throw new Error(`project.json lacks ${missing.join(', ')}`);
        }
      },
    );

    await sim.step(
      'Agent defaults: lane rows (fetch · bring in base · after every turn · merging · land) take values and persist in SQLite',
      async () => {
        await setRow('syncOnSpawn', 'off');
        await setRow('syncBeforePublish', 'off');
        await setRow('autoSync', 'publish');
        await setRow('integration', 'review');
        await setRow('autoLand', 'on');
        await sleep(300);
        const eff = (await snapshot()).settings.project[ids.project.acmeShop] ?? {};
        const want: Record<string, unknown> = {
          syncOnSpawn: false,
          syncBeforePublish: false,
          autoSync: 'publish',
          integration: 'review',
          autoLand: true,
        };
        const bad = Object.entries(want)
          .filter(([k, v]) => eff[k]?.value !== v)
          .map(([k]) => `${k}=${String(eff[k]?.value)}`);
        if (bad.length > 0) throw new Error(bad.join('; '));
        const file = projectFile(await acmePath());
        const inFile = Object.keys(want).filter((k) => JSON.stringify(file).includes(`"${k}"`));
        return `in project.json: ${inFile.length === 0 ? 'none (machine-local, under a header that names the committed file)' : inFile.join(',')}`;
      },
    );

    await sim.step(
      'Agent defaults: Reset on an overridden row returns the default and the file loses the key',
      async () => {
        const row = page().locator('[data-settings-row="permissionMode"]');
        await row.getByRole('button', { name: copy.settings.reset }).click();
        await sleep(300);
        const value = await rowSelect('permissionMode').inputValue();
        if (value !== 'default') throw new Error(`after Reset the row reads ${value}`);
        if ((await row.getAttribute('data-overridden')) === 'true')
          throw new Error('row still marked overridden');
        const eff = (await snapshot()).settings.project[ids.project.acmeShop] ?? {};
        if (eff['permissionMode']?.source === 'project')
          throw new Error('SQLite still holds the project override');
      },
    );

    await sim.step(
      'Env & secrets: .env source · Share with agents (→ project.json, Reset) · Committed file',
      async () => {
        await openProjectSection('project:env');
        const source = await rowSelect('envSource').locator('option').first().innerText();
        const committed = await rowSelect('committedFile').locator('option').first().innerText();
        if (source !== copy.settings.values.envSource || committed !== copy.settings.values.committedFile)
          throw new Error(`source "${source}", committed "${committed}"`);
        await setRow('shareWithAgents', 'always');
        await sleep(300);
        const path = await acmePath();
        const env = (projectFile(path)?.['env'] ?? {}) as Record<string, unknown>;
        if (env['shareWithAgents'] !== 'always')
          throw new Error(`project.json env.shareWithAgents=${String(env['shareWithAgents'])}`);
        const row = page().locator('[data-settings-row="shareWithAgents"]');
        await row.getByRole('button', { name: copy.settings.reset }).click();
        await sleep(300);
        const after = (projectFile(path)?.['env'] ?? {}) as Record<string, unknown>;
        if (after['shareWithAgents'] !== undefined)
          throw new Error('Reset left env.shareWithAgents in the file');
        if ((await rowSelect('shareWithAgents').inputValue()) !== 'per-grant')
          throw new Error('row did not return to Per grant');
      },
    );

    // =========================================================================================================
    // 4. Relaunch the same profile: App and Project settings persisted
    // =========================================================================================================
    await sim.step(
      'Relaunch (same profile) → General / Editor / Keychain / Policies / Agent defaults values are still there',
      async () => {
        await sim.relaunch({ screen: 'settings', env: sameProfile() });
        await page().waitForSelector('[data-screen-ready]', { timeout: 20_000 });
        const theme = await page().evaluate(() => document.documentElement.dataset['theme']);
        if (theme !== 'light')
          throw new Error(`data-theme after relaunch is ${theme}, Theme was set to Light`);
        const app = await appSettings();
        const bad: string[] = [];
        const wantApp: Record<string, unknown> = {
          theme: 'light',
          notify: 'badge',
          launchAtLogin: true,
          openFilesIn: 'fallback',
          fallbackIde: 'cursor',
          screenReader: true,
          trackAgentEdits: false,
          autoWorktreePerAgent: false,
          injectAs: 'env',
        };
        for (const [k, v] of Object.entries(wantApp)) if (app[k] !== v) bad.push(`${k}=${String(app[k])}`);
        await openAppSection('app:general');
        if ((await rowSelect('theme').inputValue()) !== 'light') bad.push('Theme row not light');
        await openAppSection('app:policies');
        if ((await rowSelect('autoApproveStagingReads').inputValue()) !== 'on')
          bad.push('staging rule not on');
        await page().click(PROJECT_TILE('acme-shop'));
        await openProjectSection('project:agent-defaults');
        const wantRows: Record<string, string> = {
          defaultAgent: 'codex',
          autoApproveEdits: 'on',
          taskPermissionMode: 'default',
          autoSync: 'publish',
          integration: 'review',
          autoLand: 'on',
          syncOnSpawn: 'off',
        };
        for (const [id, v] of Object.entries(wantRows)) {
          const shown = await rowSelect(id).inputValue();
          if (shown !== v) bad.push(`${id} row=${shown}`);
        }
        if (bad.length > 0) throw new Error(bad.join('; '));
        // Back to dark so the rest of the screenshots read like the prototype.
        await openAppSection('app:general');
        await setRow('theme', 'dark');
        await page().waitForFunction(() => document.documentElement.dataset['theme'] === 'dark', undefined, {
          timeout: 5000,
        });
      },
    );

    // =========================================================================================================
    // 5. New project
    // =========================================================================================================
    await sim.step(
      'Rail "+": a four-row menu; ↓ moves, Esc closes and hands focus back to the tile',
      async () => {
        await goHome();
        const add = page().locator('[data-rail-add]');
        await add.click();
        const menu = page().locator('[data-rail-add-menu]');
        await menu.waitFor({ timeout: 3000 });
        const items = await menu.getByRole('menuitem').allInnerTexts();
        const want = Object.values(copy.rail.menu);
        if (items.join('|') !== want.join('|')) throw new Error(`menu reads ${items.join(' | ')}`);
        await page().keyboard.press('ArrowDown');
        const second = await page().evaluate(() => document.activeElement?.textContent?.trim());
        if (second !== want[1]) throw new Error(`↓ focused "${second}"`);
        await page().keyboard.press('Escape');
        await menu.waitFor({ state: 'detached', timeout: 3000 });
        const back = await page().evaluate(() => document.activeElement?.getAttribute('data-rail-add'));
        if (back !== 'true') throw new Error('focus did not return to the + tile');
      },
    );

    await sim.step(
      'New project: an empty Name keeps the modal open and puts focus on Name; nothing is created',
      async () => {
        const before = (await snapshot()).projects.filter((p) => p.removedAt === null).length;
        await page().locator('[data-rail-add]').click();
        await page().getByRole('menuitem', { name: copy.rail.menu.newProject }).click();
        const modal = page().locator('[data-new-project-modal="true"]');
        await modal.waitFor({ timeout: 5000 });
        const focusedName = await page().evaluate(
          () => (document.activeElement as HTMLInputElement | null)?.id ?? '',
        );
        const nameId = await page().getByLabel(copy.newProject.name, { exact: true }).getAttribute('id');
        if (focusedName !== nameId) throw new Error('Name is not the initial focus');
        await page().locator('[data-start="empty"]').click();
        await page()
          .getByRole('dialog')
          .getByRole('button', { name: /^Create/ })
          .click();
        await sleep(400);
        if ((await modal.count()) !== 1) throw new Error('modal closed on an empty name');
        const after = (await snapshot()).projects.filter((p) => p.removedAt === null).length;
        if (after !== before) throw new Error('a project was created without a name');
        const focused = await page().evaluate(
          () => (document.activeElement as HTMLInputElement | null)?.id ?? '',
        );
        if (focused !== nameId) throw new Error('focus did not move to Name');
        return 'no error text; focus is the only signal (prototype behaviour)';
      },
    );

    await sim.step(
      'New project: an existing non-empty folder is refused with a toast; the modal stays',
      async () => {
        const taken = join(tmpRoot, 'taken');
        mkdirSync(taken, { recursive: true });
        writeFileSync(join(taken, 'notes.txt'), 'already here\n');
        await page().getByLabel(copy.newProject.name, { exact: true }).fill('taken');
        await page().getByLabel(copy.newProject.location, { exact: true }).fill(tmpRoot);
        await page()
          .getByRole('dialog')
          .getByRole('button', { name: /^Create/ })
          .click();
        const toast = page().getByRole('status').filter({ hasText: 'not empty' });
        await toast.waitFor({ timeout: 10_000 });
        if ((await page().locator('[data-new-project-modal="true"]').count()) !== 1)
          throw new Error('modal closed after the refusal');
        await sim.shot('new-project-refused');
        const modalText = await page().getByRole('dialog').innerText();
        if (!modalText.includes('not empty'))
          sim.finding({
            severity: 'minor',
            title: 'New project: a refused folder is only reported in a toast, the modal itself stays silent',
            repro: 'New project → Name "taken", Location a folder that already holds files → Create',
            expected:
              'the reason next to the Location field (the Clone mode shows its failure inline as `data-clone-status`)',
            observed: 'the form does not change; an error toast top-right reads "… exists and is not empty"',
            where:
              'apps/desktop/src/renderer/features/modals/NewProjectModal.tsx CreateModal.create (`if (!r.ok) return;`)',
          });
        return (await toast.innerText()).split('\n').join(' ');
      },
    );

    const emptyDir = join(tmpRoot, 'sim-empty');
    await sim.step(
      'New project · Empty folder + git init → on Home and in the rail, with a real repo on disk',
      async () => {
        await page().getByLabel(copy.newProject.name, { exact: true }).fill('sim-empty');
        await page().getByLabel(copy.newProject.location, { exact: true }).fill(tmpRoot);
        const git = page().getByRole('dialog').getByLabel(copy.newProject.gitInit);
        if (!(await git.isChecked()))
          await page().getByRole('dialog').locator(`label:has-text("${copy.newProject.gitInit}")`).click();
        await page()
          .getByRole('dialog')
          .getByRole('button', { name: /^Create/ })
          .click();
        await page().waitForSelector('[data-new-project-modal]', { state: 'detached', timeout: 20_000 });
        await ready('home');
        const row = page().locator('[role="row"][data-project-id]').filter({ hasText: 'sim-empty' });
        await row.waitFor({ timeout: 5000 });
        if ((await page().locator(PROJECT_TILE('sim-empty')).count()) !== 1) throw new Error('no rail tile');
        if (!existsSync(join(emptyDir, '.git'))) throw new Error('.git missing on disk');
        if (!existsSync(join(emptyDir, 'README.md'))) throw new Error('README.md missing');
        const log = execFileSync('git', ['-C', emptyDir, 'log', '--oneline'], { encoding: 'utf8' }).trim();
        if (!log.includes('Initial commit')) throw new Error(`git log: ${log}`);
        const rowText = await row.innerText();
        await sim.shot('home-with-sim-empty');
        return `${log} · row: ${rowText.replace(/\n/g, ' · ')}`;
      },
    );

    const agentDir = join(tmpRoot, 'sim-agent');
    await sim.step(
      'New project · "Agent scaffolds it" with Codex as the default agent → Workspace with the session running',
      async () => {
        if (!fakesActive)
          throw new Error(
            'skipped: the fake Codex is not the detected binary; a spawn would launch a real CLI',
          );
        await page().click(PROJECT_TILE('acme-shop'));
        await goHome();
        await page().getByRole('button', { name: copy.home.addRow.newProject, exact: true }).click();
        const dialog = page().getByRole('dialog');
        await page().waitForSelector('[data-new-project-modal="true"]', { timeout: 5000 });
        await page().locator('[data-start="agent"]').click();
        const briefLabel = await dialog
          .locator('label')
          .filter({ hasText: /^Brief for/ })
          .innerText();
        if (!briefLabel.includes('Codex')) throw new Error(`brief label reads "${briefLabel}"`);
        await page().getByLabel(copy.newProject.name, { exact: true }).fill('sim-agent');
        await page().getByLabel(copy.newProject.location, { exact: true }).fill(tmpRoot);
        await dialog.getByLabel(/^Brief for/).fill('A tiny hello-world CLI in TypeScript.');
        const create = dialog.getByRole('button', { name: /^Create · spawn Codex/ });
        if ((await create.count()) !== 1) throw new Error('footer does not read "Create · spawn Codex"');
        await create.click();
        await page().waitForSelector('[data-new-project-modal]', { state: 'detached', timeout: 30_000 });
        await ready('workspace');
        if ((await navHead()) !== 'sim-agent') throw new Error(`landed in "${await navHead()}"`);
        const chat = page().locator('[data-chat-pane]');
        await chat.waitFor({ timeout: 10_000 });
        await chat
          .locator('[data-kind="user"]')
          .filter({ hasText: 'hello-world' })
          .waitFor({ timeout: 20_000 });
        await chat.locator('[data-kind="agent"]').filter({ hasText: 'pong' }).waitFor({ timeout: 30_000 });
        const decision = chat.locator('[data-kind="decision"]');
        await decision.waitFor({ timeout: 20_000 });
        await sim.shot('sim-agent-needs-you');
        if (!existsSync(join(agentDir, '.git'))) throw new Error('.git missing on disk');
        const snap = await snapshot();
        const project = snap.projects.find((p) => p.name === 'sim-agent');
        const session = snap.sessions.find((s) => s.projectId === project?.id);
        return `session ${session?.agent} is ${session?.state}; the fake replays pong + an approval, it scaffolds nothing (folder holds README.md + .git)`;
      },
    );

    await sim.step(
      "The new session's ask shows on Home (needs you 03, row lists Codex); Allow lets the turn finish",
      async () => {
        if (!fakesActive) throw new Error('skipped with the step above');
        await goHome();
        const text = await page().locator(READY('home')).innerText();
        const row = await page()
          .locator('[role="row"][data-project-id]')
          .filter({ hasText: 'sim-agent' })
          .innerText();
        if (!row.includes('Codex')) throw new Error(`row reads ${row.replace(/\n/g, ' · ')}`);
        const needs = await page().evaluate((label) => {
          const el = Array.from(document.querySelectorAll('[data-muted]')).find(
            (n) => n.textContent?.trim() === label,
          );
          return (el?.parentElement?.textContent ?? '').replace(label, '').trim();
        }, copy.counters.needsYou);
        if (needs !== '03') throw new Error(`Needs you reads ${needs}`);
        void text;
        await page().click(PROJECT_TILE('sim-agent'));
        await ready('workspace');
        const chat = page().locator('[data-chat-pane]');
        await chat.locator('[data-kind="decision"]').getByRole('button', { name: 'Allow' }).click();
        await chat.locator('[data-kind="tool"][data-status="ok"]').waitFor({ timeout: 20_000 });
        await chat.locator('[data-chat-meta]').filter({ hasText: 'tokens' }).waitFor({ timeout: 20_000 });
        await sim.shot('sim-agent-turn-done');
      },
    );

    await sim.step(
      'Remove from sidebar (rail right-click) → gone from the rail and Home; the folder stays on disk',
      async () => {
        await removeViaRail('sim-agent');
        await goHome();
        if (
          (await page().locator('[role="row"][data-project-id]').filter({ hasText: 'sim-agent' }).count()) !==
          0
        )
          throw new Error('Home still lists sim-agent');
        if (!existsSync(join(agentDir, 'README.md'))) throw new Error('the folder was deleted');
        const snap = await snapshot();
        const gone = snap.projects.find((p) => p.name === 'sim-agent');
        if (gone !== undefined && gone.removedAt === null) throw new Error('project row still live');
        const live = snap.sessions.filter((s) => s.projectId === gone?.id && s.state !== 'done');
        return `folder kept; ${live.length} live session rows left behind`;
      },
    );

    // =========================================================================================================
    // 6. Add from recent
    // =========================================================================================================
    let addedName: string | null = null;
    await sim.step(
      "Add from recent: the scan lists this machine's repos / recents, nothing pre-checked, Add disabled",
      async () => {
        await page().getByRole('button', { name: copy.home.addRow.addExisting, exact: true }).click();
        const dialog = page().getByRole('dialog');
        await dialog.waitFor({ timeout: 5000 });
        const title = await dialog.innerText();
        if (!title.includes(copy.addExisting.title)) throw new Error('title missing');
        await Promise.race([
          dialog.locator('[data-repo-path]').first().waitFor({ timeout: 60_000 }),
          dialog.getByText(copy.addExisting.empty).waitFor({ timeout: 60_000 }),
        ]);
        const rows = dialog.locator('[data-repo-path]');
        const n = await rows.count();
        if (n === 0) {
          await sim.shot('add-from-recent-empty');
          return 'scan found nothing new on this machine';
        }
        const checked = await dialog.locator('[data-repo-path] input:checked').count();
        if (checked !== 0) throw new Error(`${checked} rows pre-checked (owner: nothing pre-selected)`);
        const add = dialog.getByRole('button', { name: copy.addExisting.addNone, exact: true });
        if (!(await add.isDisabled())) throw new Error('Add is enabled with nothing picked');
        const metas = await rows.locator('[role="cell"]:last-child').allInnerTexts();
        const sources = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-repo-source')));
        const bySource = sources.reduce<Record<string, number>>(
          (acc, s) => ({ ...acc, [s ?? '?']: (acc[s ?? '?'] ?? 0) + 1 }),
          {},
        );
        await sim.shot('add-from-recent');
        return `${n} rows · sources ${JSON.stringify(bySource)} · e.g. "${metas[0]}"`;
      },
    );

    await sim.step(
      'Add from recent: pick one → "Add 1" → its Workspace; then Cancel adds nothing',
      async () => {
        const dialog = page().getByRole('dialog');
        const rows = dialog.locator('[data-repo-path]');
        if ((await rows.count()) === 0) throw new Error('skipped: nothing to add on this machine');
        // Only a folder this run made (under the temp root): the scan also lists the person's real repos, and a
        // simulation must never add one of those, even to a throwaway database.
        const paths = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-repo-path') ?? ''));
        const at = paths.findIndex((p) => p.startsWith(tmpRoot) || p.startsWith(tmpdir()));
        if (at === -1) {
          await page().keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
          return `only this machine's own repos are offered (${paths.length}); none added on purpose`;
        }
        const row = rows.nth(at);
        const path = paths[at] ?? '';
        addedName = basename(path);
        await row.locator('label').click();
        const add = dialog.getByRole('button', { name: /^Add 1$/ });
        await add.waitFor({ timeout: 3000 });
        const before = (await snapshot()).projects.filter((p) => p.removedAt === null).length;
        await add.click();
        await dialog.waitFor({ state: 'detached', timeout: 30_000 });
        await ready('workspace');
        if ((await navHead()) !== addedName) throw new Error(`landed in "${await navHead()}", added ${path}`);
        const after = (await snapshot()).projects.filter((p) => p.removedAt === null).length;
        if (after !== before + 1) throw new Error(`${after - before} projects added`);
        await goHome();
        await page().getByRole('button', { name: copy.home.addRow.addExisting, exact: true }).click();
        await page().getByRole('dialog').waitFor({ timeout: 5000 });
        await page()
          .getByRole('dialog')
          .getByRole('button', { name: copy.general.cancel, exact: true })
          .click();
        await page().getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });
        if ((await snapshot()).projects.filter((p) => p.removedAt === null).length !== after)
          throw new Error('Cancel changed the project count');
        return `added ${path}`;
      },
    );

    await sim.step('Cleanup: remove the added repo and sim-empty from the sidebar', async () => {
      if (addedName !== null) await removeViaRail(addedName);
      await removeViaRail('sim-empty');
      const live = (await snapshot()).projects.filter((p) => p.removedAt === null).map((p) => p.name);
      if (live.length !== 5) throw new Error(`${live.length} projects left: ${live.join(', ')}`);
    });

    // =========================================================================================================
    // 7. What a relaunch restores
    // =========================================================================================================
    await sim.step(
      'Relaunch restores the last screen, project and per-project session (README: ui.screen / projectId)',
      async () => {
        await page().click(PROJECT_TILE('acme-shop'));
        await ready('workspace');
        const codexTab = page().locator(`[data-session-tab="${ids.session.codex}"]`);
        await codexTab.click();
        await sleep(200);
        if ((await codexTab.getAttribute('aria-selected')) !== 'true')
          throw new Error('could not pick the Codex tab');
        await page().click(PROJECT_TILE('blog-v2'));
        await sleep(200);
        await openAppSection('app:keychain');
        await sleep(400);
        await sim.relaunch({ screen: '', env: sameProfile() });
        await page().waitForSelector('[data-screen-ready]', { timeout: 20_000 });
        await sleep(500);
        const screen = await currentScreen();
        const head = await navHead();
        const snap = await snapshot();
        const notes: string[] = [];
        if (head !== 'blog-v2') notes.push(`project came back as "${head}" (expected blog-v2)`);
        if (screen !== 'settings') notes.push(`screen came back as "${screen}" (was Settings)`);
        if (snap.ui.screen === null) notes.push('main holds no ui.screen at all');
        await page().click(PROJECT_TILE('acme-shop'));
        if ((await currentScreen()) !== 'workspace') await page().click('[data-nav-item="workspace"]');
        await ready('workspace');
        const selected = await page()
          .locator('[data-session-tab][aria-selected="true"]')
          .getAttribute('data-session-tab');
        if (selected !== ids.session.codex)
          notes.push(`acme-shop reopened on tab ${selected ?? 'none'} (was Codex)`);
        await sim.shot('after-relaunch');
        if (notes.length > 0) {
          sim.finding({
            severity: 'major',
            title: 'Relaunch does not bring back the last screen or the per-project session tab',
            repro:
              'Pick the Codex tab in acme-shop, switch to blog-v2, open App settings › Keychain, quit, relaunch',
            expected:
              'README "Persist ui.screen/projectId … per machine": back on Settings for blog-v2; acme-shop reopens on its Codex tab',
            observed: notes.join('; '),
            where:
              'the renderer only ever calls `ui.persist` for paneSizes (ChatPane/TerminalPane/Workspace); `ui.screen` and `projectSession` are never written, so `hydratePersisted` has nothing and `resolveInitialScreen` defaults to Workspace (apps/desktop/src/renderer/state/sync.ts, ui-store.ts; main store.ts `ui.persist`)',
          });
          throw new Error(notes.join('; '));
        }
      },
    );

    // =========================================================================================================
    // 8. Escape / focus on overlays, and the 1100×680 minimum
    // =========================================================================================================
    await sim.step(
      'Escape closes New project / Add from recent / the palette and hands focus back to the invoker',
      async () => {
        await goHome();
        const newBtn = page().getByRole('button', { name: copy.home.addRow.newProject, exact: true });
        await newBtn.click();
        await page().waitForSelector('[data-new-project-modal="true"]', { timeout: 5000 });
        await page().keyboard.press('Escape');
        await page().waitForSelector('[data-new-project-modal]', { state: 'detached', timeout: 5000 });
        // focus returns on the next animation frame
        const focusedText = async () => {
          const deadline = Date.now() + 1500;
          let t = '';
          while (Date.now() < deadline) {
            t = await page().evaluate(() => document.activeElement?.textContent?.trim() ?? '');
            if (t !== '' && t.length < 80) return t;
            await page().waitForTimeout(50);
          }
          return t;
        };
        let focused = await focusedText();
        if (focused !== copy.home.addRow.newProject) throw new Error(`after Esc focus is on "${focused}"`);
        const addBtn = page().getByRole('button', { name: copy.home.addRow.addExisting, exact: true });
        await addBtn.click();
        await page().getByRole('dialog').waitFor({ timeout: 5000 });
        await page().keyboard.press('Escape');
        await page().getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });
        focused = await focusedText();
        if (focused !== copy.home.addRow.addExisting) throw new Error(`after Esc focus is on "${focused}"`);
        await page().keyboard.press(`${MOD}+K`);
        await page().getByRole('combobox').waitFor({ timeout: 5000 });
        const inert = await page().locator('#layer-app').getAttribute('inert');
        if (inert === null) throw new Error('#layer-app is not inert under the palette');
        await page().keyboard.press('Escape');
        await page().getByRole('combobox').waitFor({ state: 'detached', timeout: 5000 });
      },
    );

    await sim.step('Window: the minimum is enforced at 1100×680', async () => {
      const size = await sim.app.evaluate(({ BrowserWindow }) => {
        const w =
          BrowserWindow.getAllWindows().find((x) => !x.getParentWindow()) ?? BrowserWindow.getAllWindows()[0];
        if (w === undefined) return [0, 0];
        w.setSize(900, 500);
        return w.getSize();
      });
      if ((size[0] ?? 0) < 1100 || (size[1] ?? 0) < 680) throw new Error(`window went to ${size.join('×')}`);
      await sleep(400);
      return `asked 900×500, got ${size.join('×')}`;
    });

    await sim.step(
      'At 1100×680: Home, Workspace and Agent defaults have no overflow or label/control collisions',
      async () => {
        const collisions: string[] = [];
        const check = async (label: string) => {
          await sleep(300);
          const r = await page().evaluate(() => {
            const out: string[] = [];
            const doc = document.documentElement;
            if (doc.scrollWidth > window.innerWidth + 1)
              out.push(`document scrolls horizontally (${doc.scrollWidth} > ${window.innerWidth})`);
            for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-settings-row]'))) {
              const [label, value] = Array.from(row.children) as HTMLElement[];
              if (label === undefined || value === undefined) continue;
              const a = label.getBoundingClientRect();
              const b = value.getBoundingClientRect();
              if (a.right > b.left + 1)
                out.push(`row "${label.textContent?.trim()}" label overlaps its control`);
              if (b.right > window.innerWidth + 1)
                out.push(`row "${label.textContent?.trim()}" control leaves the window`);
            }
            const nav = document.querySelector<HTMLElement>('[data-nav]');
            if (nav !== null) {
              const foot = nav.lastElementChild as HTMLElement | null;
              if (
                foot !== null &&
                foot.scrollWidth > foot.clientWidth + 1 &&
                getComputedStyle(foot).overflow === 'visible'
              )
                out.push(`nav footer text is wider than the nav (${foot.scrollWidth} > ${foot.clientWidth})`);
            }
            const chat = document.querySelector<HTMLElement>('[data-chat-pane]');
            if (chat !== null && chat.getBoundingClientRect().right > window.innerWidth + 1)
              out.push('chat pane leaves the window');
            return out;
          });
          for (const x of r) collisions.push(`${label}: ${x}`);
          await sim.shot(`min-${label}`);
        };
        await goHome();
        await check('home');
        await page().click(PROJECT_TILE('acme-shop'));
        await ready('workspace');
        await check('workspace');
        await openProjectSection('project:agent-defaults');
        await check('agent-defaults');
        await openAppSection('app:agents');
        await check('agent-connections');
        if (collisions.length > 0) {
          sim.finding({
            severity: 'minor',
            title: 'Layout at the 1100×680 minimum: overflow / collisions',
            repro:
              'Resize the window to its minimum and open Home, Workspace, Agent defaults, Agent connections',
            expected: 'no horizontal scrolling and every settings label clear of its control',
            observed: collisions.join('; '),
            where:
              'apps/desktop/src/renderer/screens/Settings/Settings.module.css, packages/ui LabelValueRow',
          });
          throw new Error(collisions.join('; '));
        }
      },
    );

    await escapeAll();
  });
});
