import { test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { runSim } from './harness';

/**
 * User simulation · Agents board, Approvals (inbox, grant sheet, policies, audit log), notifications / dock,
 * background Tasks and the Usage page. Drives the built app over the demo fixture with the fake CLIs
 * (e2e/fixtures/bin) on PATH: `detect.clis` first so the fixture's Codex rows resolve to the fake app-server, and
 * every spawned session is Codex (the fake `claude` is `-p` only and is never spawned).
 *
 * Intent comes from the handoff README ("Interactions & behavior"), docs/handoff-discrepancies.md #45–#108,
 * ADR-0001 / 0018 / 0019 and packages/core/src/copy.ts; the older specs were hints only.
 */

// --- fixture ids (packages/core/src/fixtures/demo.ts `fid`) ---------------------------------------------------
const fid = (kind: string, n: number): string =>
  `01JDEMO${kind.toUpperCase().padEnd(13, '0')}${String(n).padStart(6, '0')}`;
const IDS = {
  project: { acme: fid('proj', 1), blog: fid('proj', 2), infra: fid('proj', 3) },
  session: {
    claude: fid('sess', 1),
    codex: fid('sess', 2),
    blog: fid('sess', 3),
    gemini: fid('sess', 4),
    infra: fid('sess', 5),
    shell: fid('sess', 6),
    cursor: fid('sess', 7),
    side: fid('sess', 8),
  },
  target: { supabaseProd: fid('tgt', 3), infraAws: fid('tgt', 8), blogVercelPreview: fid('tgt', 13) },
  grant: { supabaseCodex: fid('grant', 3), awsClaude: fid('grant', 4), vercelPreviewCursor: fid('grant', 5) },
  ask: { codexGrant: fid('ask', 1) },
};

// --- read-model shapes we look at --------------------------------------------------------------------------------
interface Table<T> {
  byId: Record<string, T>;
  ids: string[];
}
interface SessionRow {
  id: string;
  projectId: string;
  agent: string;
  state: string;
  purpose: string | null;
  permissionMode: string;
  numTurns: number;
  tokensUsed?: number;
  costUsd: number;
  exitCode: number | null;
  archivedAt: number | null;
  note: string | null;
}
interface GrantRow {
  id: string;
  targetId: string;
  sessionId: string | null;
  state: string;
  decidedBy: string | null;
  policyId: string | null;
  duration: string;
}
interface AskRow {
  id: string;
  sessionId: string;
  kind: string;
  state: string;
  grantId: string | null;
}
interface PolicyRow {
  id: string;
  ord: number;
  enabled: boolean;
  ruleText: string;
  matchCountToday: number;
  builtinKey: string | null;
}
interface NotificationRow {
  id: string;
  askId: string | null;
  kind: string;
  state: string;
}
interface AuditEntryRow {
  id: string;
  seq: number;
  action: string;
  grantId: string | null;
  policyId: string | null;
  detail: Record<string, unknown>;
}
interface Snap {
  sessions: Table<SessionRow>;
  grants: Table<GrantRow>;
  pendingAsks: Table<AskRow>;
  policies: Table<PolicyRow>;
  notifications: Table<NotificationRow>;
  auditEntries: Table<AuditEntryRow>;
  settings: {
    project: Record<string, { taskPermissionMode: { value: string }; defaultAgent: { value: string } }>;
  };
  discovery: { clis: { agent: string; version?: string | null; path?: string | null; found?: boolean }[] };
  limits: Record<string, unknown>;
}
// `store.snapshot` answers arrays (contract `readModelSnapshotSchema`); the renderer's tables are built from them.
const rowsOf = <T>(t: Table<T> | T[]): T[] =>
  Array.isArray(t) ? t : t.ids.map((id) => t.byId[id]).filter((x): x is T => x !== undefined);

// --- helpers -----------------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  what: string,
  timeout = 8000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > timeout)
      throw new Error(
        `timed out (${timeout} ms) waiting for ${what}; last: ${JSON.stringify(v)?.slice(0, 240)}`,
      );
    await sleep(150);
  }
}

const must = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

test('sim: agents-approvals', async () => {
  await runSim('agents-approvals', { screen: 'agents' }, async (sim) => {
    const page = (): Page => sim.page;
    const dbDir = sim.userData;

    const snap = async (): Promise<Snap> => {
      const r = await sim.command<Snap>('store.snapshot', {});
      if (!r.ok || r.value === undefined)
        throw new Error(`store.snapshot failed: ${r.error?.message ?? '?'}`);
      // the contract answers arrays; index them the way the renderer does so the checks below can look rows up by id
      const v = r.value as unknown as Record<string, unknown>;
      for (const k of ['sessions', 'grants', 'pendingAsks', 'policies', 'notifications', 'auditEntries']) {
        const list = v[k];
        if (Array.isArray(list)) {
          const byId: Record<string, unknown> = {};
          for (const row of list as { id: string }[]) byId[row.id] = row;
          v[k] = { byId, ids: (list as { id: string }[]).map((row) => row.id) };
        }
      }
      return v as unknown as Snap;
    };
    const ready = async (screen: string, timeout = 15_000) => {
      await page().waitForSelector(`[data-screen-ready="${screen}"]`, { timeout });
    };
    const rail = (item: string): Locator => page().locator(`[data-app-rail-item="${item}"]`);
    const goBoardAll = async () => {
      await rail('agents').click();
      await ready('agents');
    };
    const goApprovals = async (tab?: 'inbox' | 'policies' | 'audit') => {
      await rail('approvals').click();
      await ready('approvals');
      if (tab) await page().locator(`[data-approvals-tab="${tab}"]`).click();
    };
    const card = (sessionId: string): Locator => page().locator(`[data-session="${sessionId}"]`);
    const column = (key: 'needs-you' | 'working' | 'done'): Locator =>
      page().locator(`[data-column="${key}"]`);
    const inColumn = (key: 'needs-you' | 'working' | 'done', sessionId: string): Locator =>
      column(key).locator(`[data-session="${sessionId}"]`);
    /** "02 needs you" from the titlebar's live counter. */
    const needsYou = async (): Promise<number> => {
      const live = page()
        .locator('span[aria-live="polite"]')
        .filter({ hasText: /needs you/i })
        .first();
      const text =
        (await live.count()) > 0 ? await live.innerText() : await page().locator('body').innerText();
      const m = /(\d{2})\s*needs you/i.exec(text);
      return m?.[1] === undefined ? -1 : Number(m[1]);
    };
    const locked = async (): Promise<number> => {
      const m = /(\d{2})\s*locked/i.exec(await page().locator('body').innerText());
      return m?.[1] === undefined ? -1 : Number(m[1]);
    };
    const inboxCorner = async (): Promise<number> => {
      const label = (await rail('approvals').getAttribute('aria-label')) ?? '';
      const m = /(\d+) in the inbox/.exec(label);
      return m?.[1] === undefined ? 0 : Number(m[1]);
    };
    const badge = async (): Promise<string> =>
      sim.app.evaluate(({ app }) => app.dock?.getBadge() ?? '(no dock)');
    const toast = (re: RegExp): Locator => page().getByRole('status').filter({ hasText: re });
    const openAsks = (s: Snap): AskRow[] => rowsOf(s.pendingAsks).filter((a) => a.state === 'open');
    const auditCount = async (): Promise<number> => rowsOf((await snap()).auditEntries).length;

    // Fixture Codex sessions (`runner: pty`) become app-server sessions once the fake `codex` is detected.
    await sim.step('detect.clis finds the fake Codex and Gemini on PATH', async () => {
      const r = await sim.command<{ clis: { agent: string; version?: string | null }[] }>('detect.clis', {});
      must(r.ok, `detect.clis failed: ${r.error?.message ?? '?'}`);
      const codex = r.value?.clis.find((c) => c.agent === 'codex');
      const gemini = r.value?.clis.find((c) => c.agent === 'gemini');
      must(codex !== undefined, 'no codex row in detect.clis');
      return `codex ${JSON.stringify(codex?.version ?? null)} · gemini ${JSON.stringify(gemini?.version ?? null)}`;
    });

    // =============================================================================================================
    // 1. The board over the fixture
    // =============================================================================================================
    await sim.step(
      'the board shows the fixture in Needs you / Working / Done with the copy texts',
      async () => {
        await ready('agents');
        const labels = await page()
          .locator('[data-column]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-column')));
        must(labels.join(',') === 'needs-you,working,done', `columns: ${labels.join(',')}`);
        const text = await page().locator('[data-board="agents"]').innerText();
        for (const label of ['Needs you', 'Working', 'Done'])
          must(text.includes(label), `column label "${label}" missing`);
        const counts = {
          needs: await column('needs-you').locator('[data-session]').count(),
          working: await column('working').locator('[data-session]').count(),
          done: await column('done').locator('[data-session]').count(),
        };
        must(counts.needs === 2, `needs-you cards: ${counts.needs} (fixture: Codex + blog Claude)`);
        must(
          counts.working === 4,
          `working cards: ${counts.working} (fixture: claude, gemini idle, infra, shell)`,
        );
        must(counts.done === 2, `done cards: ${counts.done} (fixture: cursor, side)`);
        // CTAs per spec §4.3 / discrepancy #97.
        const cta = async (id: string) => card(id).getByRole('button').first().innerText();
        must((await cta(IDS.session.codex)) === 'Review grant', `codex CTA: ${await cta(IDS.session.codex)}`);
        must((await cta(IDS.session.blog)) === 'Review plan', `blog CTA: ${await cta(IDS.session.blog)}`);
        must((await cta(IDS.session.claude)) === 'Open', `claude CTA: ${await cta(IDS.session.claude)}`);
        must((await cta(IDS.session.cursor)) === 'Reopen', `cursor CTA: ${await cta(IDS.session.cursor)}`);
        must(
          (await card(IDS.session.cursor).getByRole('button', { name: 'Archive' }).count()) === 1,
          'Done card has no Archive ghost button',
        );
        must(
          (await card(IDS.session.codex).getByRole('button', { name: 'Deny' }).count()) === 1,
          'needs-you card has no Deny ghost button',
        );
        must(!text.includes('Nothing waiting on you.'), 'empty text shown in a non-empty column');
        await sim.shot('board-fixture');
        return `needs ${counts.needs} · working ${counts.working} · done ${counts.done}`;
      },
    );

    await sim.step('titlebar, rail corner and dock badge read the fixture', async () => {
      const needs = await needsYou();
      const lock = await locked();
      const inbox = await inboxCorner();
      const b = await badge();
      must(needs === 2, `titlebar needs-you ${needs}, expected 02`);
      must(lock === 2, `titlebar locked ${lock}, expected 02 (Supabase locked + AWS expired)`);
      must(inbox === 3, `Approvals corner ${inbox}, expected 3 requested grants`);
      if (needs !== inbox)
        sim.finding({
          severity: 'polish',
          title: 'Three "needs you" numbers on one screen count three different things',
          repro:
            'Launch on the Agents board over the demo fixture; compare the titlebar, the Approvals rail tile and the dock badge',
          expected: 'One number for "things waiting on me", or labels that say what differs',
          observed: `titlebar "0${needs} needs you" (sessions in needs-you) · Approvals tile "${inbox} in the inbox" (requested grants, two of which have no session ask) · dock badge "${b}" (open asks)`,
          where:
            'packages/core/src/selectors/counts.ts needsYouCount · selectors/inbox.ts inboxRows · main services/notification-service.ts (openAll asks)',
        });
      return `needs ${needs} · locked ${lock} · inbox ${inbox} · badge "${b}"`;
    });

    await sim.step('scope: the project nav shows only this project, the app rail every project', async () => {
      await page().locator(`button[data-project-id="${IDS.project.acme}"]`).click();
      await page().locator('[data-nav-item="agents"]').click();
      await ready('agents');
      await poll(
        async () => page().locator('[data-session]').count(),
        (n) => n === 4,
        'four acme-shop cards in project scope',
      );
      must(
        (await inColumn('needs-you', IDS.session.blog).count()) === 0,
        'blog-v2 card visible in project scope',
      );
      const navAgentsMeta = await page().locator('[data-nav-item="agents"]').innerText();
      must(/3/.test(navAgentsMeta), `project nav Agents row reads "${navAgentsMeta}", expected count 3`);
      const railOnProject = await rail('agents').getAttribute('data-on');
      await sim.shot('board-project-scope');
      await goBoardAll();
      await poll(
        async () => page().locator('[data-session]').count(),
        (n) => n === 8,
        'eight cards in all scope',
      );
      must(
        (await rail('agents').getAttribute('data-on')) === 'true',
        'app rail Agents tile not marked current',
      );
      return `project scope: 4 cards, rail data-on=${railOnProject ?? 'none'} · all: 8 cards`;
    });

    await sim.step("Open on a Working card lands in that session's chat", async () => {
      await card(IDS.session.claude).getByRole('button', { name: 'Open' }).click();
      await ready('workspace');
      await page().locator('[data-chat-pane]').waitFor({ timeout: 5000 });
      const tab = page().locator(`[data-nav-lane="${IDS.session.claude}"]`);
      await tab.waitFor({ timeout: 5000 });
      const selected =
        (await tab.getAttribute('data-inv')) === 'true' ||
        (await tab.getAttribute('aria-current')) === 'page';
      must(selected, 'the Claude tab is not the selected session tab');
      await goBoardAll();
    });

    await sim.step(
      'Review grant on the Codex card opens the grant sheet; Escape closes it and focus returns',
      async () => {
        const button = card(IDS.session.codex).getByRole('button', { name: 'Review grant' });
        await button.focus();
        await button.click();
        const sheet = page().locator('[data-grant-sheet]');
        await sheet.waitFor({ timeout: 5000 });
        const text = await sheet.innerText();
        for (const s of ['Access request', 'Supabase', 'prod', 'Read schema', 'Write', 'Duration'])
          must(text.includes(s), `sheet lacks "${s}"`);
        must(
          (await sheet.getByRole('radio', { name: '1h' }).getAttribute('aria-checked')) === 'true',
          '1h chip not preselected',
        );
        for (const d of ['once', 'session', 'always'])
          must((await sheet.getByRole('radio', { name: d }).count()) === 1, `duration chip "${d}" missing`);
        must(/Touch ID|Windows Hello/.test(text), 'prod MFA line missing');
        const grantLabel = await sheet.locator('[data-grant-approve]').innerText();
        must(/^Grant 1h · (Touch ID|Windows Hello)$/.test(grantLabel), `Grant button reads "${grantLabel}"`);
        await sim.shot('grant-sheet-from-board');
        await page().keyboard.press('Escape');
        await poll(
          async () => sheet.count(),
          (n) => n === 0,
          'sheet closed on Escape',
          3000,
        );
        const focused = await page().evaluate(() => document.activeElement?.textContent?.trim() ?? '');
        if (focused !== 'Review grant')
          sim.finding({
            severity: 'minor',
            title:
              'Escape closes the grant sheet but focus does not return to the card button that opened it',
            repro: 'Agents board → focus + click "Review grant" on the Codex card → Escape',
            expected: 'Focus back on "Review grant" (README: Escape returns focus to the invoker)',
            observed: `active element text "${focused}"`,
            where: 'apps/desktop/src/renderer/overlays (invoker memory) / screens/Agents/Agents.tsx runCta',
          });
        return `grant button "${grantLabel}" · focus after Escape: "${focused}"`;
      },
    );

    await sim.step(
      'Reopen on the Done Cursor card is refused honestly (cursor-agent is not installed)',
      async () => {
        await goBoardAll(); // Review grant took the person to the chat (the sheet slides over it)
        await card(IDS.session.cursor).getByRole('button', { name: 'Reopen' }).click();
        const outcome = await poll(
          async () => {
            const body = await page().locator('body').innerText();
            const s = await snap();
            const row = s.sessions.byId[IDS.session.cursor];
            return {
              banner: /not found on PATH|cannot start|isn't connected|not installed/i.test(body),
              state: row?.state ?? '?',
              note: row?.note ?? '',
            };
          },
          (o) => o.banner || o.state !== 'done',
          'reopen outcome',
          8000,
        );
        await sim.shot('reopen-cursor');
        if (!outcome.banner && outcome.state !== 'done' && outcome.state !== 'paused')
          sim.finding({
            severity: 'major',
            title:
              'Reopen on a Cursor session whose CLI is missing shows it as running without saying the CLI is absent',
            repro: 'Agents board → Reopen on the Done Cursor card (no cursor-agent on PATH)',
            expected: 'A refusal or banner naming the missing CLI ("… not found on PATH")',
            observed: `session state "${outcome.state}", note "${outcome.note}", no banner`,
            where: 'apps/desktop/src/main/services/session-service.ts reopen',
          });
        await goBoardAll();
        return `state ${outcome.state} · banner ${outcome.banner}`;
      },
    );

    await sim.step('Archive on a Done card removes it from the board', async () => {
      await goBoardAll();
      await card(IDS.session.side).getByRole('button', { name: 'Archive' }).click();
      await poll(
        async () => card(IDS.session.side).count(),
        (n) => n === 0,
        'side-api card gone',
        5000,
      );
      const s = await snap();
      must(s.sessions.byId[IDS.session.side]?.archivedAt !== null, 'session not archived in the model');
    });

    // =============================================================================================================
    // 2. Live movement: a Codex session spawned from the board
    // =============================================================================================================
    let spawned = '';
    let firstAskId = '';
    await sim.step('+ Spawn agent → Codex session from the board, and the ask raises a toast', async () => {
      const before = new Set(rowsOf((await snap()).sessions).map((s) => s.id));
      await goBoardAll();
      await page().getByRole('button', { name: '+ Spawn agent' }).click();
      const modal = page().locator('[data-spawn-modal]');
      await modal.waitFor({ timeout: 5000 });
      await modal.locator('[data-agent="codex"]').click();
      must(
        (await modal.locator('[data-spawn-cli]').count()) === 0,
        `spawn modal reports the CLI as missing / not connected: ${await modal.innerText()}`,
      );
      await modal.getByLabel('First message').fill('ping');
      await sim.shot('spawn-modal-codex');
      // the footer sits outside [data-spawn-modal] (a Modal prop): reach it from the dialog
      await page()
        .getByRole('dialog')
        .getByRole('button', { name: /^Spawn ·/ })
        .click();
      const row = await poll(
        async () => rowsOf((await snap()).sessions).find((s) => !before.has(s.id) && !s.purpose) ?? null,
        (r) => r !== null,
        'new session row',
        10_000,
      );
      spawned = row?.id ?? '';
      const t = toast(/Codex needs you|Codex wants/);
      await t.waitFor({ timeout: 10_000 });
      const text = await t.innerText();
      await sim.shot('toast-needs-you');
      must(/Needs you/.test(text) && /Review/.test(text) && /Later/.test(text), `toast text: ${text}`);
      const ask = await poll(
        async () => openAsks(await snap()).find((a) => a.sessionId === spawned) ?? null,
        (a) => a !== null,
        'open ask on the spawned session',
      );
      firstAskId = ask?.id ?? '';
      return `session ${spawned} · ask ${ask?.kind ?? '?'} · toast "${text.replace(/\n/g, ' / ')}"`;
    });

    await sim.step('Later dismisses the toast and is recorded', async () => {
      const t = toast(/Codex needs you|Codex wants/);
      await t.getByRole('button', { name: 'Later' }).click();
      await poll(
        async () => t.count(),
        (n) => n === 0,
        'toast gone after Later',
        3000,
      );
      const n = rowsOf((await snap()).notifications).find((x) => x.askId === firstAskId);
      return `notification ${n === undefined ? 'row: none' : `state ${n.state}`}`;
    });

    await sim.step(
      'the card is in Needs you and titlebar / badge / inbox all move (or say why not)',
      async () => {
        await goBoardAll();
        await inColumn('needs-you', spawned).waitFor({ timeout: 10_000 });
        const cta = await card(spawned).getByRole('button').first().innerText();
        const needs = await needsYou();
        const b = await badge();
        const inbox = await inboxCorner();
        await sim.shot('board-spawned-needs-you');
        must(needs === 3, `titlebar needs-you ${needs}, expected 03`);
        must(b === '3', `dock badge "${b}", expected "3"`);
        if (inbox !== 3 + 1)
          sim.finding({
            severity: 'major',
            title:
              'A command approval is on the board, in the toast and on the badge, but not in the Approvals inbox',
            repro:
              'Spawn Codex from the board with "ping"; the fake asks to run a command → look at Approvals › Inbox',
            expected:
              'The README: an ask renders inline in chat, on the board, in the Approvals inbox, as a toast and as a badge; approving anywhere resolves it everywhere',
            observed: `inbox corner still ${inbox} (the inbox lists requested grants only); the ask kind is "decision"`,
            where:
              'packages/core/src/selectors/inbox.ts inboxRows (grants with state requested) · screens/Approvals/Approvals.tsx Inbox',
          });
        return `card CTA "${cta}" · needs ${needs} · badge ${b} · inbox ${inbox}`;
      },
    );

    await sim.step('Deny on the needs-you card answers the command approval', async () => {
      await card(spawned).getByRole('button', { name: 'Deny' }).click();
      try {
        await poll(
          async () => openAsks(await snap()).some((a) => a.id === firstAskId),
          (open) => !open,
          "ask resolved by the card's Deny",
          3000,
        );
      } catch {
        sim.finding({
          severity: 'major',
          title: 'Deny on a needs-you board card does nothing when the ask is a command / tool approval',
          repro:
            'Spawn Codex from the board with "ping" → the card lands in Needs you with a Deny button → click Deny',
          expected: 'The approval is declined (the chat shows the Deny taken) and the card leaves Needs you',
          observed: 'The ask stays open; only grant and plan asks are wired',
          where:
            'apps/desktop/src/renderer/screens/Agents/Agents.tsx runDeny (handles ask.kind grant | plan only)',
        });
        throw new Error('ask still open 3 s after Deny on the card');
      }
    });

    await sim.step(
      'answer from the Approvals inbox (the README says approving anywhere resolves everywhere)',
      async () => {
        await goApprovals('inbox');
        const rowsNow = await page().locator('[data-grant-id]').count();
        const body = await page().locator('[data-approvals-panel="inbox"]').innerText();
        await sim.shot('inbox-with-decision-ask-open');
        must(
          /agent\/codex|ping|echo hi/.test(body),
          `inbox has no row for the spawned session's approval (rows: ${rowsNow})`,
        );
      },
    );

    await sim.step(
      'answer from the chat: Allow resolves the decision, the card returns to Working, counts drop',
      async () => {
        await goBoardAll();
        // The CTA reads "Review" while an ask is open and opens the chat (spec: Open · Review grant · Review plan).
        await card(spawned).getByRole('button').first().click();
        await ready('workspace');
        // The card's Deny answered the first ask: a new turn brings a fresh approval to answer from the chat.
        if (!openAsks(await snap()).some((a) => a.sessionId === spawned)) {
          const box = page().locator('[data-keyscope="composer"] textarea');
          await box.click();
          await box.fill('ping again');
          await box.press('Enter');
          await poll(
            async () => openAsks(await snap()).some((a) => a.sessionId === spawned),
            (open) => open,
            'a second approval from the fake',
            20_000,
          );
        }
        const askId = openAsks(await snap()).find((a) => a.sessionId === spawned)?.id ?? firstAskId;
        const decision = page()
          .locator('[data-kind="decision"]')
          .filter({ has: page().getByRole('button', { name: 'Allow', exact: true, disabled: false }) })
          .last();
        await decision.waitFor({ timeout: 5000 });
        await sim.shot('chat-decision-open');
        await decision.getByRole('button', { name: 'Allow', exact: true }).click();
        await poll(
          async () => openAsks(await snap()).some((a) => a.id === askId),
          (open) => !open,
          'ask resolved',
          5000,
        );
        // once answered its Allow is disabled, so the enabled-Allow locator no longer matches: read the last bubble
        const settled = await page().locator('[data-kind="decision"]').last().getAttribute('data-settled');
        const state = await poll(
          async () => (await snap()).sessions.byId[spawned]?.state ?? '?',
          (st) => st !== 'needs-you',
          'session leaves needs-you',
          8000,
        );
        const needs = await needsYou();
        const b = await badge();
        must(needs === 2, `titlebar needs-you ${needs} after Allow, expected 02`);
        must(b === '2', `badge "${b}" after Allow, expected "2"`);
        await goBoardAll();
        await inColumn('working', spawned).waitFor({ timeout: 8000 });
        return `decision settled=${settled} · session ${state} · needs ${needs} · badge ${b}`;
      },
    );

    await sim.step(
      "a second ask from the composer: the toast's Review lands in the chat, Deny there resolves it",
      async () => {
        await goBoardAll();
        // The card's verb reads Open once the session is idle again; a still-open ask makes it Review.
        await card(spawned).getByRole('button').first().click();
        await ready('workspace');
        const composer = page().getByPlaceholder(/^Message Codex/);
        await composer.waitFor({ timeout: 5000 });
        await composer.fill('ping');
        await composer.press('Enter');
        const t = toast(/Codex needs you|Codex wants/).last(); // the fixture's own Codex may have one up too
        await t.waitFor({ timeout: 10_000 });
        await goBoardAll();
        await t.getByRole('button', { name: 'Review' }).click();
        await ready('workspace');
        const decision = page().locator('[data-kind="decision"]:not([data-settled])').last();
        await decision.waitFor({ timeout: 5000 });
        const askBefore = openAsks(await snap()).find((a) => a.sessionId === spawned);
        await decision.getByRole('button', { name: 'Deny' }).click();
        await poll(
          async () => openAsks(await snap()).some((a) => a.id === askBefore?.id),
          (open) => !open,
          'second ask resolved',
          5000,
        );
        await sleep(1500);
        const toastStill = await t.count();
        if (toastStill > 0)
          sim.finding({
            severity: 'polish',
            title: 'The needs-you toast outlives the ask it announced',
            repro: 'Send "ping" to the spawned Codex session → toast → answer the ask in the chat',
            expected: 'The toast goes away once its ask is answered (it has nothing left to review)',
            observed: 'The toast stays until its 8 s TTL',
            where: 'apps/desktop/src/renderer/features/toast/ToastHost.tsx (no resolve listener)',
          });
        const needs = await needsYou();
        must(needs === 2, `titlebar needs-you ${needs} after Deny, expected 02`);
        return `toast after resolve: ${toastStill > 0 ? 'still up' : 'gone'} · inbox corner ${await inboxCorner()}`;
      },
    );

    await sim.step('Stop the session → Done; Reopen → running again', async () => {
      // The chat offers "Stop · esc" (interrupts the turn) and ✕ (close = end + archive); ending a session so it
      // lands in Done has no button of its own, so the command is used here.
      const r = await sim.command('session.stop', { sessionId: spawned });
      must(r.ok, `session.stop: ${r.error?.message ?? '?'}`);
      await goBoardAll();
      await inColumn('done', spawned).waitFor({ timeout: 8000 });
      await sim.shot('board-spawned-done');
      await card(spawned).getByRole('button', { name: 'Reopen' }).click();
      const state = await poll(
        async () => (await snap()).sessions.byId[spawned]?.state ?? '?',
        (st) => st === 'idle' || st === 'working',
        'reopened session running',
        10_000,
      );
      await ready('workspace');
      const chat = await page().locator('[data-chat-pane]').innerText();
      must(/reopened/.test(chat), 'chat has no "reopened" system line');
      await goBoardAll();
      await inColumn('working', spawned).waitFor({ timeout: 8000 });
      sim.finding({
        severity: 'minor',
        title:
          'No way in the chat to end a session so it lands in Done (✕ archives it, Stop only interrupts the turn)',
        repro:
          'Workspace → a running Codex chat → look for a way to end the session without losing it from the board',
        expected: 'An "End session" action that finishes the session (Done column, Reopen later)',
        observed:
          'Only "Stop · esc" (session.interrupt) and the tab ✕ (session.close: stop + archive, never shown in Done)',
        where: 'apps/desktop/src/renderer/features/chat/ChatPane.tsx (session controls / closeSession)',
      });
      return `state after Reopen ${state}`;
    });

    // =============================================================================================================
    // 3. Grant flow over the fixture's Codex → Supabase prod request
    // =============================================================================================================
    await sim.step(
      'the inbox lists the three fixture requests with agent · project → target · env · scope',
      async () => {
        await goApprovals('inbox');
        const tab = await page().locator('[data-approvals-tab="inbox"]').innerText();
        must(/Requests · 3/.test(tab), `inbox tab reads "${tab}"`);
        const row = page().locator(`[data-grant-id="${IDS.grant.supabaseCodex}"]`);
        const text = await row.innerText();
        for (const s of [
          'Codex',
          'acme-shop',
          'Supabase prod',
          'prod',
          'write',
          'migration 0042',
          'Review',
          'Deny',
        ])
          must(text.includes(s), `Codex inbox row lacks "${s}": ${text}`);
        const footer = await page().locator('[data-approvals-panel="inbox"]').innerText();
        must(/auto-approved today: 12/.test(footer), 'inbox footer count missing');
        await sim.shot('inbox-fixture');
      },
    );

    let auditBeforeGrant = 0;
    await sim.step(
      'Review from the inbox opens the Codex chat with the sheet; Grant 1h · MFA (auto) resolves it',
      async () => {
        auditBeforeGrant = await auditCount();
        await page()
          .locator(`[data-grant-id="${IDS.grant.supabaseCodex}"]`)
          .getByRole('button', { name: 'Review' })
          .click();
        await ready('workspace');
        const sheet = page().locator('[data-grant-sheet]');
        await sheet.waitFor({ timeout: 5000 });
        const checked = async (scope: string) =>
          sheet.locator(`[data-scope="${scope}"]`).evaluate((el) => {
            // data-scope rides on the <input> itself (Checkbox spreads its rest props there)
            if (el instanceof HTMLInputElement) return el.checked;
            const input = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
            if (input) return input.checked;
            const a =
              el.getAttribute('aria-checked') ??
              el.querySelector('[aria-checked]')?.getAttribute('aria-checked');
            return a === 'true';
          });
        must(await checked('read'), 'read scope not pre-checked');
        must(await checked('write'), 'write scope not pre-checked');
        await sheet.locator('[data-grant-approve]').click();
        const line = page()
          .locator('[data-kind="system"]')
          .filter({ hasText: /^grant: / })
          .last();
        await line.waitFor({ timeout: 8000 });
        const text = await line.innerText();
        must(
          /grant: supabase-prod · read\+write · expires in (1h|60m|59m|\d+m)/.test(text),
          `grant line reads "${text}"`,
        );
        const request = page().locator('[data-kind="accessRequest"]').last();
        const reviewStill = await request
          .getByRole('button', { name: 'Review request' })
          .isEnabled()
          .catch(() => false);
        await sim.shot('chat-after-grant');
        const needs = await needsYou();
        const lock = await locked();
        must(needs === 1, `titlebar needs-you ${needs} after grant, expected 01`);
        must(lock === 1, `titlebar locked ${lock} after grant, expected 01`);
        if (reviewStill)
          sim.finding({
            severity: 'minor',
            title: 'The access-request card keeps a live "Review request" button after the grant was issued',
            repro: 'Codex chat → Review request → Grant',
            expected: 'The card reads as settled (grant line below it, buttons gone or disabled)',
            observed: 'Review request still enabled under the "grant: …" line',
            where:
              'apps/desktop/src/renderer/features/chat/transcript-items.ts / ui Message kind accessRequest',
          });
        return `"${text}" · needs ${needs} · locked ${lock} · review still enabled: ${reviewStill}`;
      },
    );

    await sim.step(
      'the inbox count dropped and the audit log has "granted read+write to Codex · 1h"',
      async () => {
        await goApprovals('inbox');
        const tab = await page().locator('[data-approvals-tab="inbox"]').innerText();
        must(/Requests · 2/.test(tab), `inbox tab reads "${tab}"`);
        must((await inboxCorner()) === 2, `rail corner ${await inboxCorner()}`);
        await page().locator('[data-approvals-tab="audit"]').click();
        const rows = page().locator('[data-approvals-panel="audit"] [data-audit-id]');
        const first = await rows.first().innerText();
        must(
          /granted read\+write to Codex · 1h/.test(first),
          `newest audit row reads "${first.replace(/\n/g, ' ')}"`,
        );
        must(
          /\byou\b/.test(first) && /supabase/i.test(first),
          `actor / target missing: ${first.replace(/\n/g, ' ')}`,
        );
        must(
          (await rows.count()) === auditBeforeGrant + 1,
          `audit rows ${await rows.count()} vs ${auditBeforeGrant} before`,
        );
        await sim.shot('audit-after-grant');
        return first.replace(/\n/g, ' ');
      },
    );

    await sim.step(
      'Targets shows Supabase "open · … left"; Revoke locks it and audits the revoke',
      async () => {
        await page().locator(`button[data-project-id="${IDS.project.acme}"]`).click();
        await page().locator('[data-nav-item="project:targets"]').click();
        await ready('settings');
        const row = page()
          .getByRole('row', { name: /supabase/i })
          .first();
        await row.waitFor({ timeout: 5000 });
        const state = await row.innerText();
        must(
          /open · (1h|60m|59m|\d+m) left/.test(state),
          `Supabase row reads "${state.replace(/\n/g, ' ')}"`,
        );
        const before = await auditCount();
        await row.getByRole('button', { name: /^revoke\b/i }).click(); // aria-label "Revoke · Supabase prod"
        await poll(
          async () => row.innerText(),
          (t) => /\blocked\b/.test(t),
          'Supabase row locked',
          5000,
        );
        must((await locked()) === 2, `titlebar locked ${await locked()}, expected 02`);
        await poll(
          async () => auditCount(),
          (n) => n === before + 1,
          'revoke audit row',
        );
        await goApprovals('audit');
        const first = await page()
          .locator('[data-approvals-panel="audit"] [data-audit-id]')
          .first()
          .innerText();
        must(
          /revoked Codex grant · revoked by you/.test(first),
          `newest audit row "${first.replace(/\n/g, ' ')}"`,
        );
        return first.replace(/\n/g, ' ');
      },
    );

    await sim.step('Deny from the inbox on the AWS ask removes the row and audits the denial', async () => {
      await goApprovals('inbox');
      const row = page().locator(`[data-grant-id="${IDS.grant.awsClaude}"]`);
      await row.waitFor({ timeout: 5000 });
      await row.getByRole('button', { name: 'Deny' }).click();
      await poll(
        async () => row.count(),
        (n) => n === 0,
        'AWS row gone',
        5000,
      );
      must(
        /Requests · 1/.test(await page().locator('[data-approvals-tab="inbox"]').innerText()),
        'inbox tab not at 1',
      );
      const g = (await snap()).grants.byId[IDS.grant.awsClaude];
      must(g?.state === 'denied', `grant state ${g?.state ?? '?'}`);
      await page().locator('[data-approvals-tab="audit"]').click();
      const first = await page()
        .locator('[data-approvals-panel="audit"] [data-audit-id]')
        .first()
        .innerText();
      must(/denied read to Claude/.test(first), `newest audit row "${first.replace(/\n/g, ' ')}"`);
      return first.replace(/\n/g, ' ');
    });

    await sim.step('"always" on the Cursor → Vercel preview ask shows as persistent', async () => {
      await goApprovals('inbox');
      const row = page().locator(`[data-grant-id="${IDS.grant.vercelPreviewCursor}"]`);
      await row.getByRole('button', { name: 'Review' }).click();
      const sheet = page().locator('[data-grant-sheet]');
      const shown = await sheet.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      );
      if (!shown) {
        // The fixture's row is the prototype's: a Cursor session that is already done asking for blog-v2's
        // target. The sheet lives over that session's chat, and a done session has no chat tab. In the app a
        // session's open requests are cancelled when it ends, so this row cannot arise outside the fixture.
        const owner = (await snap()).sessions.byId[IDS.session.cursor];
        if (owner === undefined || owner.state !== 'needs-you') {
          sim.finding({
            severity: 'polish',
            title:
              'demo fixture: an inbox row from a session that is already done has no chat to review it in',
            repro: 'demo fixture › Approvals › Inbox › Review on Cursor → Vercel preview',
            expected:
              'a live session behind every requested grant (the app cancels requests when a session ends)',
            observed: `Review opened the target's project without a grant sheet; the Cursor session is ${owner?.state ?? 'gone'}`,
            where: 'packages/core/src/fixtures/demo.ts grant vercelPreviewCursor (prototype content)',
          });
          return 'skipped: fixture row from a done session (prototype content)';
        }
        throw new Error('grant sheet did not open from the inbox Review');
      }
      await sheet.getByRole('radio', { name: 'always' }).click();
      const label = await sheet.locator('[data-grant-approve]').innerText();
      must(label === 'Grant always', `Grant button reads "${label}"`);
      await sheet.locator('[data-grant-approve]').click();
      const g = await poll(
        async () => (await snap()).grants.byId[IDS.grant.vercelPreviewCursor] ?? null,
        (x) => x !== null && x.state !== 'requested',
        'cursor grant decided',
        8000,
      );
      const err = page().locator('[data-grant-error]');
      const errText = (await err.count()) > 0 ? await err.innerText() : '';
      must(
        g?.state === 'active' && g.duration === 'always',
        `grant state ${g?.state ?? '?'} duration ${g?.duration ?? '?'} ${errText}`,
      );
      const line = page()
        .locator('[data-kind="system"]')
        .filter({ hasText: /^grant: / })
        .last();
      await line.waitFor({ timeout: 5000 });
      const text = await line.innerText();
      must(/· persistent$/.test(text), `grant line reads "${text}"`);
      await page().locator(`button[data-project-id="${IDS.project.blog}"]`).click();
      await page().locator('[data-nav-item="project:targets"]').click();
      await ready('settings');
      const rows = await page().locator('[data-settings-section="project:targets"]').innerText();
      must(/persistent/.test(rows), 'blog-v2 Targets has no persistent row');
      await sim.shot('targets-blog-persistent');
      await goApprovals('audit');
      const first = await page()
        .locator('[data-approvals-panel="audit"] [data-audit-id]')
        .first()
        .innerText();
      must(
        /granted deploy to Cursor · always/.test(first),
        `newest audit row "${first.replace(/\n/g, ' ')}"`,
      );
      return `${text} · ${first.replace(/\n/g, ' ')}`;
    });

    // =============================================================================================================
    // 4. Policies
    // =============================================================================================================
    await sim.step('the Policies tab and pane read the three builtin rules with their counters', async () => {
      await goApprovals('policies');
      const intro = await page().locator('[data-approvals-panel="policies"]').innerText();
      must(/Policies are evaluated top to bottom/.test(intro), `policies tab reads "${intro}"`);
      const pane = page().getByRole('complementary', { name: 'Policies' });
      const items = pane.locator('[data-policy-id]');
      must((await items.count()) === 3, `policy rows ${await items.count()}`);
      const text = await pane.innerText();
      for (const s of [
        'Auto-approve read on any staging or preview target',
        'matches 12 today',
        'Always ask, require Touch ID for prod write',
        'Expire grants after 1h idle',
        'revoked 5 this week',
        '+ Rule',
        'Export JSON',
      ])
        must(text.includes(s), `policies pane lacks "${s}"`);
      await sim.shot('policies-tab');
    });

    let ruleId = '';
    let editorRuleId = '';
    await sim.step('+ Rule opens an editor to add an auto-approve rule', async () => {
      const pane = page().getByRole('complementary', { name: 'Policies' });
      await pane.getByRole('button', { name: '+ Rule' }).click();
      await sleep(800);
      const dialogs = await page().getByRole('dialog').count();
      const rows = await pane.locator('[data-policy-id]').count();
      const editor = await page()
        .locator('form, [data-policy-editor], [data-rule-editor]')
        .filter({ hasText: /rule|scope|provider/i })
        .count();
      if (dialogs === 0 && rows === 3 && editor === 0) {
        sim.finding({
          severity: 'major',
          title: '"+ Rule" in the Policies pane does nothing',
          repro: 'Approvals → Policies → "+ Rule"',
          expected: 'A rule editor (target / env / scope / duration) that adds an auto-approve or ask rule',
          observed: 'No dialog, no editor, no new row; the button is wired to a no-op',
          where: 'apps/desktop/src/renderer/screens/Approvals/Approvals.tsx PoliciesPane (TODO(policy.add))',
        });
        throw new Error('+ Rule opened nothing');
      }
      // The editor: Auto-approve deploy on Vercel preview, always. The drafted text follows the choices.
      const form = page().locator('[data-policy-rule]');
      await form.waitFor({ timeout: 5000 });
      // the inputs are visually hidden behind drawn boxes; a person clicks the label
      const tick = async (sel: string, on: boolean) => {
        const input = form.locator(sel);
        if ((await input.isChecked()) !== on) await form.locator(`label:has(${sel})`).click();
      };
      await tick('[data-policy-rule-provider="vercel"]', true);
      await tick('[data-policy-rule-env="preview"]', true);
      await tick('[data-policy-rule-scope="deploy"]', true);
      await tick('[data-policy-rule-scope="read"]', false);
      await form.locator('[data-policy-rule-durations]').getByRole('radio', { name: 'always' }).click();
      const drafted = await form.locator('[data-policy-rule-text]').inputValue();
      must(/Auto-approve deploy on Vercel \(Preview\) for always/.test(drafted), `drafted text "${drafted}"`);
      await page().locator('[data-policy-rule-save]').click();
      await page().getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });
      await poll(
        async () => pane.locator('[data-policy-id]').count(),
        (n) => n === 4,
        'four policy rows after + Rule',
        8000,
      );
      const added = rowsOf((await snap()).policies).find((p) => p.builtinKey === null);
      must(added !== undefined, 'no custom rule in the model');
      editorRuleId = added?.id ?? '';
      return `rule #${added?.ord ?? '?'}: "${added?.ruleText ?? ''}"`;
    });

    await sim.step('an auto-approve rule added over IPC appears in the pane', async () => {
      if (editorRuleId !== '') {
        // + Rule already made one: this step checks the pane for it and moves on with that id.
        await goApprovals('policies');
        const pane = page().getByRole('complementary', { name: 'Policies' });
        const mine = pane.locator(`[data-policy-row="${editorRuleId}"]`);
        await mine.waitFor({ timeout: 5000 });
        must(/Auto-approve deploy on Vercel/.test(await mine.innerText()), 'rule text missing');
        ruleId = editorRuleId;
        return `editor's rule shown: ${(await mine.innerText()).replace(/\s+/g, ' ').slice(0, 80)}`;
      }
      const r = await sim.command<{ policyId: string }>('policy.upsert', {
        policyId: null,
        rule: {
          kind: 'auto-approve',
          match: { provider: ['vercel'], env: ['preview'] },
          scopes: ['deploy'],
          duration: '1h',
        },
        ruleText: 'Auto-approve preview deploys on Vercel',
        enabled: true,
      });
      must(r.ok, `policy.upsert: ${r.error?.message ?? '?'}`);
      ruleId = r.value?.policyId ?? '';
      const pane = page().getByRole('complementary', { name: 'Policies' });
      await poll(
        async () => pane.locator('[data-policy-id]').count(),
        (n) => n === 4,
        'four policy rows',
      );
      const mine = pane.locator(`[data-policy-row="${ruleId}"]`);
      must(/Auto-approve preview deploys on Vercel/.test(await mine.innerText()), 'rule text missing');
      must(/matches 0 today/.test(await mine.innerText()), `rule meta: ${await mine.innerText()}`);
    });

    let policyGrantId = '';
    await sim.step(
      'a matching request resolves without asking and the audit says "auto: policy #4"',
      async () => {
        const p = await sim.command('target.setPolicy', {
          targetId: IDS.target.blogVercelPreview,
          policy: 'ask',
        });
        must(p.ok, `target.setPolicy: ${p.error?.message ?? '?'}`);
        const before = new Set(rowsOf((await snap()).grants).map((g) => g.id));
        // Deploy is the one renderer-reachable action that requests a grant on its own (ADR / discrepancy #63); the
        // fake PATH has no `vercel`, so the deploy itself fails after the grant — the grant and its audit are the point.
        const d = await sim.command('deploy.start', { targetId: IDS.target.blogVercelPreview });
        const grant = await poll(
          async () =>
            rowsOf((await snap()).grants).find(
              (g) => !before.has(g.id) && g.targetId === IDS.target.blogVercelPreview,
            ) ?? null,
          (g) => g !== null && g.state !== 'requested',
          'policy-decided grant',
          10_000,
        );
        policyGrantId = grant?.id ?? '';
        must(
          grant?.state === 'active',
          `grant state ${grant?.state ?? '?'} (deploy.start ok=${d.ok} ${d.error?.message ?? ''})`,
        );
        must(
          grant?.decidedBy === 'policy' && grant.policyId === ruleId,
          `decidedBy ${grant?.decidedBy ?? '?'} policy ${grant?.policyId ?? '?'}`,
        );
        must(
          (await inboxCorner()) === 1,
          `inbox corner ${await inboxCorner()} — the auto-approved request should not be in the inbox`,
        );
        const deployToast = page()
          .getByRole('status')
          .filter({ hasText: /Deploy/ });
        if ((await deployToast.count()) > 0)
          await deployToast
            .first()
            .getByRole('button', { name: /close|dismiss|×/i })
            .click()
            .catch(() => undefined);
        await goApprovals('audit');
        const rows = page().locator('[data-approvals-panel="audit"] [data-audit-id]');
        const granted = rows.filter({ hasText: /granted deploy/ }).first();
        await granted.waitFor({ timeout: 5000 });
        const text = await granted.innerText();
        must(
          /granted deploy to .* · (1h|always) \(auto: policy #4\)/.test(text), // the editor's rule said always
          `audit row "${text.replace(/\n/g, ' ')}"`,
        );
        const entry = rowsOf((await snap()).auditEntries).find(
          (e) => e.action === 'granted' && e.grantId === policyGrantId,
        );
        must(
          entry?.detail['decidedBy'] === 'policy',
          `audit detail decidedBy ${String(entry?.detail['decidedBy'])}`,
        );
        await granted.click();
        const drawer = page().getByRole('dialog', { name: 'Audit entry' });
        await drawer.waitFor({ timeout: 5000 });
        const dt = await drawer.innerText();
        must(
          /Policy\s*#4 Auto-approve (preview deploys on Vercel|deploy on Vercel \(Preview\))/.test(
            dt.replace(/\n/g, ' '),
          ),
          `drawer policy row: ${dt.replace(/\n/g, ' ')}`,
        );
        await sim.shot('audit-drawer-policy-grant');
        await page().keyboard.press('Escape');
        await poll(
          async () => drawer.count(),
          (n) => n === 0,
          'drawer closed',
          3000,
        );
        await page().locator('[data-approvals-tab="policies"]').click();
        const mine = page().locator(`[data-policy-row="${ruleId}"]`);
        must(
          /matches 1 today/.test(await mine.innerText()),
          `rule meta after match: ${await mine.innerText()}`,
        );
        return text.replace(/\n/g, ' ');
      },
    );

    await sim.step('Settings › Policies (app rail) shows the same rules as the Approvals pane', async () => {
      await rail('app:policies').click();
      await ready('settings');
      const section = page().locator('[data-settings-section="app:policies"]');
      await section.waitFor({ timeout: 5000 });
      const rowIds = await section
        .locator('[data-settings-row]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-settings-row')));
      const text = await section.innerText();
      await sim.shot('settings-policies');
      // By design (spec §4.6 / the prototype): Settings › App › Policies is three fixed rows (the staging-reads
      // toggle, idle expiry, export); the rule list itself lives under Approvals › Policies. Noted, not failed.
      if (!/Auto-approve preview deploys on Vercel/.test(text))
        sim.finding({
          severity: 'polish',
          title:
            'Settings › Policies shows the prototype’s three fixed rows; custom rules live only under Approvals › Policies',
          repro: 'Add a rule (+ Rule) → app rail › Policies',
          expected: 'a pointer to Approvals › Policies would help; the spec’s rows are as designed',
          observed: `rows: ${rowIds.join(', ')}`,
          where:
            'apps/desktop/src/renderer/screens/Settings/rows.ts policiesRows (prototype settingsRowsMap)',
        });
      return `rows: ${rowIds.join(', ')}`;
    });

    await sim.step('edit (text), toggle from the pane, and delete the rule', async () => {
      const e = await sim.command('policy.upsert', {
        policyId: ruleId,
        rule: {
          kind: 'auto-approve',
          match: { provider: ['vercel'], env: ['preview'] },
          scopes: ['deploy'],
          duration: '1h',
        },
        ruleText: 'Auto-approve preview deploys on Vercel (edited)',
        enabled: true,
      });
      must(e.ok, `policy.upsert edit: ${e.error?.message ?? '?'}`);
      await goApprovals('policies');
      const mine = page().locator(`[data-policy-row="${ruleId}"]`);
      await poll(
        async () => mine.innerText(),
        (t) => /\(edited\)/.test(t),
        'edited text in the pane',
      );
      await mine.locator('label').first().click(); // the input is visually hidden behind the drawn box
      await poll(
        async () => (await snap()).policies.byId[ruleId]?.enabled ?? true,
        (on) => on === false,
        'rule disabled from the pane',
      );
      const d = await sim.command('policy.remove', { policyId: ruleId });
      must(d.ok, `policy.remove: ${d.error?.message ?? '?'}`);
      await poll(
        async () => page().locator('[data-policy-id]').count(),
        (n) => n === 3,
        'three rules again',
      );
      const changed = rowsOf((await snap()).auditEntries).filter((x) => x.action === 'policy-changed').length;
      return `policy-changed audit rows so far: ${changed}`;
    });

    // =============================================================================================================
    // 5. Audit log
    // =============================================================================================================
    await sim.step(
      'audit rows carry time · actor · target · action, newest first; the fixture rows read as designed',
      async () => {
        await goApprovals('audit');
        const rows = page().locator('[data-approvals-panel="audit"] [data-audit-id]');
        const n = await rows.count();
        must(n >= 8, `only ${n} rows`);
        const all = await rows.allInnerTexts();
        // the fixture's row, not the one this run's auto-approve rule produced (vercel-preview, policy #4)
        const used = all.find((t) => /used deploy token/.test(t) && /vercel-prod/.test(t)) ?? '';
        must(
          /09:41/.test(used) &&
            /Claude/.test(used) &&
            /vercel-prod/.test(used) &&
            /\(auto: policy #1\)/.test(used),
          `fixture "used" row: "${used.replace(/\n/g, ' ')}"`,
        );
        const expired = all.find((t) => /revoked Gemini grant · idle 1h/.test(t)) ?? '';
        must(
          /08:58/.test(expired) && /system/.test(expired),
          `fixture "expired" row: "${expired.replace(/\n/g, ' ')}"`,
        );
        must(/^now/.test(all[0] ?? ''), `newest row is not "now": "${(all[0] ?? '').replace(/\n/g, ' ')}"`);
        const filters = await page()
          .locator('[data-approvals-panel="audit"] input, [data-audit-filter], [data-audit-search]')
          .count();
        await sim.shot('audit-log');
        return `${n} rows · filter/search controls: ${filters}`;
      },
    );

    await sim.step(
      'open a row → drawer with Actor … Policy rows, Copy JSON and Revoke now; Escape closes it',
      async () => {
        const rows = page().locator('[data-approvals-panel="audit"] [data-audit-id]');
        const row = rows
          .filter({ hasText: /used deploy token/ })
          .filter({ hasText: /vercel-prod/ })
          .first();
        await row.click();
        const drawer = page().getByRole('dialog', { name: 'Audit entry' });
        await drawer.waitFor({ timeout: 5000 });
        const text = await drawer.innerText();
        for (const k of [
          'Actor',
          'Target',
          'Scope',
          'Duration',
          'Session',
          'Worktree',
          'Triggered by',
          'Policy',
          'Copy JSON',
          'Revoke now',
        ])
          must(text.includes(k), `drawer lacks "${k}"`);
        must(/\$ vercel deploy --prod/.test(text), 'triggering command missing');
        must(/claude · acme-shop/.test(text) && /fix\/checkout/.test(text), 'session / worktree missing');
        must((await row.getAttribute('data-inv')) === 'true', 'the open row is not marked current');
        const revokeEnabled = await drawer.getByRole('button', { name: 'Revoke now' }).isEnabled();
        await sim.shot('audit-drawer');
        await page().keyboard.press('Escape');
        await poll(
          async () => drawer.count(),
          (n) => n === 0,
          'drawer closed on Escape',
          3000,
        );
        return `Revoke now enabled: ${revokeEnabled} (grant is active + user-decided → expected true)`;
      },
    );

    await sim.step(
      'the log is append-only: rows only grow, nothing disappears, the hash chain verifies',
      async () => {
        const before = rowsOf((await snap()).auditEntries).map((e) => e.id);
        const r = await sim.command<{ ok: boolean; brokenAtSeq: number | null }>('audit.verifyChain', {});
        must(r.ok && r.value?.ok === true, `verifyChain: ${JSON.stringify(r.value ?? r.error)}`);
        // A live grant: revoke from the audit drawer → a new row, the old rows untouched. The Codex grant made
        // earlier in this run (read+write · 1h) is the one that is certainly there; the Cursor "always" row exists
        // only when the fixture's done-session ask could be reviewed.
        await goApprovals('audit');
        // A grant that is still live at this point (earlier steps revoked some): its "granted" row's drawer
        // offers Revoke now; an already-revoked grant's drawer shows it disabled.
        const s0 = await snap();
        // Revoke now is for grants the person decided (decidedBy user); policy-issued ones are revoked elsewhere
        const live = new Set(
          rowsOf(s0.grants)
            .filter((g) => g.state === 'active' && g.decidedBy === 'user')
            .map((g) => g.id),
        );
        const entry = rowsOf(s0.auditEntries)
          .filter((e) => e.action === 'granted' && e.grantId !== null && live.has(e.grantId))
          .sort((a, b) => b.seq - a.seq)[0];
        must(entry !== undefined, 'no granted row of a live grant to revoke from');
        const row = page().locator(`[data-approvals-panel="audit"] [data-audit-id="${entry?.id ?? ''}"]`);
        await row.click();
        const drawer = page().getByRole('dialog', { name: 'Audit entry' });
        await drawer.waitFor({ timeout: 5000 });
        await drawer.getByRole('button', { name: 'Revoke now' }).click();
        const after = await poll(
          async () => rowsOf((await snap()).auditEntries).map((e) => e.id),
          (ids) => ids.length === before.length + 1,
          'one more audit row after Revoke now',
        );
        must(
          before.every((id) => after.includes(id)),
          'an audit row disappeared',
        );
        const first = await page()
          .locator('[data-approvals-panel="audit"] [data-audit-id]')
          .first()
          .innerText();
        must(
          /revoked \w+ grant · revoked by you/.test(first), // whichever live grant the drawer revoked
          `newest row "${first.replace(/\n/g, ' ')}"`,
        );
        const chain = await sim.command<{ ok: boolean }>('audit.verifyChain', {});
        must(chain.ok && chain.value?.ok === true, 'chain broken after revoke');
        return `${before.length} → ${after.length} rows`;
      },
    );

    // =============================================================================================================
    // 6. Notifications: the agent dock
    // =============================================================================================================
    await sim.step(
      'the agent dock lists needs-you cards across projects and a card focuses the main window',
      async () => {
        const windowsBefore = sim.app.windows().length;
        const p = sim.app.waitForEvent('window', { timeout: 10_000 }).catch(() => null);
        const r = await sim.command('window.agentDock', { open: true });
        must(r.ok, `window.agentDock: ${r.error?.message ?? '?'}`);
        let dock = await p;
        if (dock === null) dock = sim.app.windows().find((w) => w !== page()) ?? null;
        must(dock !== null, `no dock window (windows ${windowsBefore} → ${sim.app.windows().length})`);
        await dock!.waitForSelector('[data-dock]', { timeout: 10_000 });
        const cards = dock!.locator('[data-dock-card]');
        await poll(
          async () => cards.count(),
          (n) => n > 0,
          'dock cards',
        );
        const labels = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
        const projects = new Set(labels.map((l) => l.split(' in ')[1]));
        const onTop = await sim.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isAlwaysOnTop()),
        );
        const needsCards = await dock!.locator('[data-dock-card][data-on="true"]').count();
        const text = await dock!.locator('[data-dock]').innerText();
        await dock!.screenshot({ path: `${__dirname}/out/agents-approvals/dock.png` }).catch(() => undefined);
        must(projects.size > 1, `dock cards span ${projects.size} project(s): ${labels.join(' | ')}`);
        must(onTop, 'no always-on-top window');
        const blog = dock!.locator(`[data-dock-card="${IDS.session.blog}"]`);
        await blog.click();
        await ready('workspace');
        const tab = page().locator(`[data-nav-lane="${IDS.session.blog}"]`);
        await tab.waitFor({ timeout: 5000 });
        await sim.command('window.agentDock', { open: false });
        return `${labels.length} cards (${needsCards} needs-you) · ${[...projects].join(', ')} · header "${text.split('\n')[0] ?? ''}"`;
      },
    );

    // =============================================================================================================
    // 7. Background tasks
    // =============================================================================================================
    await sim.step(
      'the Tasks rail tile opens the modeless dialog with its empty state; Escape closes it',
      async () => {
        await goBoardAll();
        await rail('tasks').click();
        const dialog = page().locator('[data-task-dialog]');
        await dialog.waitFor({ timeout: 5000 });
        must((await rail('tasks').getAttribute('aria-expanded')) === 'true', 'tile aria-expanded not true');
        must((await dialog.getAttribute('aria-modal')) === 'false', 'task dialog is modal');
        const text = await dialog.innerText();
        must(/No background tasks yet\./.test(text), `dialog reads "${text.replace(/\n/g, ' ')}"`);
        await sim.shot('tasks-empty');
        // Esc closes the topmost overlay: a toast up at that moment goes first, the modeless dialog next.
        for (let i = 0; i < 3 && (await dialog.count()) > 0; i += 1) {
          await page().keyboard.press('Escape');
          await sleep(300);
        }
        await poll(
          async () => dialog.count(),
          (n) => n === 0,
          'dialog closed on Escape',
          3000,
        );
        must(
          (await rail('tasks').getAttribute('aria-expanded')) !== 'true',
          'tile still aria-expanded after close',
        );
      },
    );

    let taskId = '';
    await sim.step(
      'Tech debt audit (default agent Codex) starts hidden: dialog, Bypass permissions, no card, no tab',
      async () => {
        const s = await sim.command('project.settings.set', {
          projectId: IDS.project.acme,
          patch: { defaultAgent: 'codex' },
        });
        must(s.ok, `project.settings.set: ${s.error?.message ?? '?'}`);
        await page().locator(`button[data-project-id="${IDS.project.acme}"]`).click();
        await page().locator('[data-nav-audit]').click();
        const dialog = page().locator('[data-task-dialog]');
        await dialog.waitFor({ timeout: 5000 });
        must(/Tech debt audit · acme-shop/.test(await dialog.innerText()), 'dialog title missing');
        const task = await poll(
          async () => rowsOf((await snap()).sessions).find((x) => x.purpose === 'debt-audit') ?? null,
          (t) => t !== null,
          'debt-audit session',
          15_000,
        );
        taskId = task?.id ?? '';
        const select = dialog.locator('[data-task-mode-select]');
        await select.waitFor({ timeout: 5000 });
        const mode = await select.inputValue();
        must(mode === 'bypassPermissions', `Permissions select reads "${mode}"`);
        const label = await select.evaluate(
          (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '',
        );
        must(label === 'Bypass permissions', `selected option label "${label}"`);
        must(
          task?.permissionMode === 'bypassPermissions',
          `task session permissionMode ${task?.permissionMode ?? '?'}`,
        );
        must((await card(taskId).count()) === 0, 'the task has a board card');
        await sim.shot('task-dialog-running');
        return `task ${taskId} · state ${task?.state ?? '?'} · mode ${mode}`;
      },
    );

    await sim.step(
      'switching the Permissions select reconfigures the running task and the project default',
      async () => {
        const dialog = page().locator('[data-task-dialog]');
        const select = dialog.locator('[data-task-mode-select]');
        await select.selectOption('default');
        await poll(
          async () => {
            const s = await snap();
            return {
              session: s.sessions.byId[taskId]?.permissionMode ?? '?',
              // effective settings are { value, source } per key
              project: s.settings.project[IDS.project.acme]?.taskPermissionMode?.value ?? '?',
            };
          },
          (v) => v.session === 'default' && v.project === 'default',
          'session + project mode = default',
        );
        await select.selectOption('bypassPermissions');
        await poll(
          async () => (await snap()).sessions.byId[taskId]?.permissionMode ?? '?',
          (m) => m === 'bypassPermissions',
          'session mode back to bypass',
        );
      },
    );

    await sim.step(
      "the fake's approval shows inside the dialog; switching projects keeps it; Continue in background",
      async () => {
        const dialog = page().locator('[data-task-dialog]');
        // Styx's tasks bypass by default (no approval to show): ask mode for this one, so the fake's approval comes.
        await dialog.locator('[data-task-mode-select]').selectOption('default');
        await poll(
          async () => (await snap()).sessions.byId[taskId]?.permissionMode ?? '?',
          (m) => m === 'default',
          'task in ask mode',
        );
        const allow = dialog.getByRole('button', { name: 'Allow', exact: true });
        // The first run may already have been answered by Styx (bypass) and finished: run it again in ask mode.
        if ((await allow.count()) === 0) {
          const again = dialog.getByRole('button', { name: /Run again|Try again/ });
          if ((await again.count()) === 1) {
            await again.click();
            const fresh = await poll(
              async () =>
                rowsOf((await snap()).sessions).find((x) => x.purpose === 'debt-audit' && x.id !== taskId) ??
                null,
              (t) => t !== null,
              'a second debt-audit session',
              15_000,
            );
            taskId = fresh?.id ?? taskId;
          }
        }
        await allow.waitFor({ timeout: 30_000 });
        const status = await dialog.getByRole('status').innerText();
        must(/Needs your input/.test(status), `status "${status}"`);
        const tasksLabel = (await rail('tasks').getAttribute('aria-label')) ?? '';
        must(/1 need you/.test(tasksLabel), `Tasks tile label "${tasksLabel}"`);
        const needs = await needsYou();
        const b = await badge();
        await sim.shot('task-dialog-ask');
        // Another project while it runs.
        await page().locator(`button[data-project-id="${IDS.project.infra}"]`).click();
        await poll(
          async () =>
            page().locator(`button[data-project-id="${IDS.project.infra}"]`).getAttribute('aria-current'),
          (v) => v === 'true',
          'infra-tools current',
          3000,
        );
        must(
          (await dialog.count()) === 1 && /acme-shop/.test(await dialog.innerText()),
          'dialog lost or retitled after switching project',
        );
        must(
          (await page().locator('#layer-app').getAttribute('inert')) === null,
          'the app is inert behind the task dialog',
        );
        await dialog.getByRole('button', { name: 'Continue in background' }).click();
        await poll(
          async () => dialog.count(),
          (n) => n === 0,
          'dialog hidden',
          3000,
        );
        return `titlebar needs-you ${needs} · badge ${b} while the hidden task asks (task asks count as needs-you: ${needs === 2 ? 'yes' : 'no'})`;
      },
    );

    await sim.step('reopen from Tasks, Allow inside the dialog, the report lands', async () => {
      await rail('tasks').click();
      const dialog = page().locator('[data-task-dialog]');
      await dialog.waitFor({ timeout: 5000 });
      const entry = dialog.getByRole('button', { name: /Tech debt audit · acme-shop/ });
      must(/Needs your input/.test(await entry.innerText()), `entry reads "${await entry.innerText()}"`);
      await entry.click();
      await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
      await poll(
        async () => dialog.getByRole('status').innerText(),
        (t) => /Finished/.test(t),
        'task finished',
        20_000,
      );
      const text = await dialog.innerText();
      must(/pong/.test(text), 'report does not contain the fake\'s "pong"');
      must(
        (await dialog.getByRole('button', { name: 'Run again' }).count()) === 1,
        'no Run again after Finished',
      );
      const row = (await snap()).sessions.byId[taskId];
      must(
        row?.state === 'done' && row.exitCode === 0,
        `task row ${row?.state ?? '?'} / ${String(row?.exitCode)}`,
      );
      await sim.shot('task-finished');
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    });

    await sim.step('after a relaunch the report is still there under Tasks', async () => {
      await sim.relaunch({ env: { STYX_USER_DATA: dbDir }, screen: 'agents' });
      await ready('agents', 20_000);
      await rail('tasks').click();
      const dialog = page().locator('[data-task-dialog]');
      await dialog.waitFor({ timeout: 5000 });
      const entry = dialog.getByRole('button', { name: /Tech debt audit · acme-shop/ });
      await entry.waitFor({ timeout: 5000 });
      await entry.click();
      await poll(
        async () => dialog.innerText(),
        (t) => /pong/.test(t),
        'persisted report',
        5000,
      );
      await sim.shot('task-after-relaunch');
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    });

    await sim.step(
      'Run again starts a new audit; Stop task ends it as Stopped; the earlier report stays reachable',
      async () => {
        await sim.command('detect.clis', {});
        await rail('tasks').click();
        const dialog = page().locator('[data-task-dialog]');
        await dialog.getByRole('button', { name: /Tech debt audit · acme-shop/ }).click();
        await dialog.getByRole('button', { name: 'Run again' }).click();
        const second = await poll(
          async () =>
            rowsOf((await snap()).sessions).find((x) => x.purpose === 'debt-audit' && x.id !== taskId) ??
            null,
          (t) => t !== null,
          'second audit session',
          15_000,
        );
        await poll(
          async () => dialog.getByRole('status').innerText(),
          (t) => /Working|Needs your input/.test(t),
          'second run working',
          15_000,
        );
        await dialog.getByRole('button', { name: 'Stop task' }).click();
        await poll(
          async () => dialog.getByRole('status').innerText(),
          (t) => /Stopped/.test(t),
          'stopped',
          10_000,
        );
        const retry = await dialog.getByRole('button', { name: /Try again|Run again/ }).innerText();
        await dialog.getByRole('button', { name: 'Tasks' }).click();
        const entries = await dialog.getByRole('button', { name: /Tech debt audit · acme-shop/ }).count();
        await sim.shot('tasks-list-after-stop');
        if (entries < 2)
          sim.finding({
            severity: 'minor',
            title: 'Run again + Stop hides the previous finished report: Tasks keeps one entry per project',
            repro: 'Finish a Tech debt audit → Run again → Stop task → Tasks list',
            expected: 'The finished report stays reachable (or the stopped run is marked separately)',
            observed: `one entry "Tech debt audit · acme-shop" reading Stopped; the earlier report is gone from the list`,
            where: 'apps/desktop/src/renderer/features/tasks/TaskDialog.tsx entries (Map by taskKey)',
          });
        return `second ${second?.id ?? '?'} · retry button "${retry}" · entries ${entries}`;
      },
    );

    // =============================================================================================================
    // 8. Usage
    // =============================================================================================================
    await sim.step(
      'Usage: by-agent and by-project rows add up to the session rows, totals agree',
      async () => {
        await rail('usage').click();
        await ready('usage');
        const s = await snap();
        const agentSessions = rowsOf(s.sessions).filter((x) => x.agent !== 'shell');
        const expectAgent = new Map<string, { sessions: number; turns: number; tokens: number }>();
        for (const x of agentSessions) {
          const row = expectAgent.get(x.agent) ?? { sessions: 0, turns: 0, tokens: 0 };
          row.sessions += 1;
          row.turns += x.numTurns;
          row.tokens += x.tokensUsed ?? 0;
          expectAgent.set(x.agent, row);
        }
        const byAgent = page().locator('[data-usage-table="agent"]');
        const rows = byAgent.locator('[data-usage-row]');
        must(
          (await rows.count()) === expectAgent.size,
          `agent rows ${await rows.count()} vs ${expectAgent.size} agents with sessions`,
        );
        let sumSessions = 0;
        let sumTurns = 0;
        for (let i = 0; i < (await rows.count()); i += 1) {
          const key = (await rows.nth(i).getAttribute('data-usage-row')) ?? '';
          const cells = await rows.nth(i).getByRole('cell').allInnerTexts();
          const want = expectAgent.get(key);
          must(want !== undefined, `unexpected agent row ${key}`);
          must(
            cells[1] === String(want?.sessions),
            `${key} sessions cell "${cells[1] ?? ''}" vs ${want?.sessions ?? '?'}`,
          );
          must(
            cells[2] === String(want?.turns),
            `${key} turns cell "${cells[2] ?? ''}" vs ${want?.turns ?? '?'}`,
          );
          const tokens = (want?.tokens ?? 0) > 0 ? formatTokens(want?.tokens ?? 0) : '—';
          must(cells[3] === tokens, `${key} tokens cell "${cells[3] ?? ''}" vs ${tokens}`);
          sumSessions += Number(cells[1]);
          sumTurns += Number(cells[2]);
        }
        const total = await byAgent.locator('[data-usage-total]').getByRole('cell').allInnerTexts();
        must(
          total[1] === String(sumSessions) && total[2] === String(sumTurns),
          `agent total ${total.join('|')} vs ${sumSessions}/${sumTurns}`,
        );
        const projectTotal = await page()
          .locator('[data-usage-table="project"] [data-usage-total]')
          .getByRole('cell')
          .allInnerTexts();
        must(
          projectTotal[1] === total[1] && projectTotal[2] === total[2] && projectTotal[3] === total[3],
          `project total ${projectTotal.join('|')} vs agent total ${total.join('|')}`,
        );
        must((await byAgent.locator('[data-usage-row="shell"]').count()) === 0, 'shell listed under usage');
        await sim.shot('usage');
        return `agents ${[...expectAgent.keys()].join(',')} · total ${total.slice(1).join(' / ')}`;
      },
    );

    await sim.step('Limits: Refresh asks the fake Codex and fills the block', async () => {
      const refresh = page().locator('[data-usage-refresh]');
      await refresh.click();
      const codex = page().locator('[data-usage-limit="codex"]');
      await codex.waitFor({ timeout: 20_000 });
      const text = await codex.innerText();
      must(/plan team/.test(text), `limits row "${text.replace(/\n/g, ' ')}"`);
      must((await codex.locator('[data-usage-window]').count()) === 2, 'two windows expected');
      must(
        /5 h · 3% used/.test(text) && /7 d · 1% used/.test(text),
        `windows text "${text.replace(/\n/g, ' ')}"`,
      );
      await poll(
        async () => refresh.innerText(),
        (t) => t === 'Refresh',
        'Refresh settles',
        5000,
      );
      await sim.shot('usage-limits');
      return text.replace(/\n/g, ' ');
    });

    // =============================================================================================================
    // 9. Layout at the 1100×680 minimum
    // =============================================================================================================
    await sim.step(
      'agents / approvals / usage / task dialog fit at 1100×680 without horizontal overflow',
      async () => {
        await sim.app.evaluate(({ BrowserWindow }) => {
          const w =
            BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0];
          w?.setSize(1100, 680);
        });
        await sleep(400);
        const problems: string[] = [];
        const check = async (label: string) => {
          const m = await page().evaluate(() => {
            const de = document.documentElement;
            const over: string[] = [];
            for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed')
                over.push(
                  `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.dataset['screenReady'] ? `[screen=${el.dataset['screenReady']}]` : ''}@${Math.round(r.right)}`,
                );
              if (over.length > 3) break;
            }
            return {
              iw: window.innerWidth,
              ih: window.innerHeight,
              sw: de.scrollWidth,
              sh: de.scrollHeight,
              over,
            };
          });
          await sim.shot(`layout-1100x680-${label}`);
          if (m.sw > m.iw + 1 || m.over.length > 0)
            problems.push(`${label}: scrollWidth ${m.sw} > ${m.iw}; ${m.over.join(', ')}`);
          return m;
        };
        await goBoardAll();
        const a = await check('agents');
        await goApprovals('inbox');
        await check('approvals');
        await rail('usage').click();
        await ready('usage');
        await check('usage');
        await rail('tasks').click();
        const dialog = page().locator('[data-task-dialog]');
        await dialog.waitFor({ timeout: 5000 });
        const box = await dialog.boundingBox();
        if (box && (box.x + box.width > a.iw + 1 || box.y + box.height > a.ih + 1))
          problems.push(`task dialog ${JSON.stringify(box)} outside ${a.iw}x${a.ih}`);
        await check('tasks');
        await page().keyboard.press('Escape');
        if (problems.length > 0)
          sim.finding({
            severity: 'minor',
            title: 'Layout overflows at the 1100×680 window minimum',
            repro: 'Resize the window to 1100×680; open Agents, Approvals, Usage, Tasks',
            expected: 'No horizontal scroll; every screen and the task dialog inside the window',
            observed: problems.join(' · '),
          });
        must(problems.length === 0, problems.join(' · '));
        return `viewport ${a.iw}x${a.ih}`;
      },
    );

    // =============================================================================================================
    // 8b. Usage empty state (fresh, empty fixture)
    // =============================================================================================================
    await sim.step('Usage empty state on a fixture with no sessions', async () => {
      await sim.relaunch({ fixture: 'empty', screen: 'usage' });
      await page().waitForSelector('[data-screen-ready]', { timeout: 20_000 });
      let screen = await page().locator('[data-screen-ready]').first().getAttribute('data-screen-ready');
      if (screen !== 'usage' && (await rail('usage').count()) > 0) {
        await rail('usage').click();
        await ready('usage');
        screen = 'usage';
      }
      must(screen === 'usage', `landed on "${screen ?? '?'}", the usage rail tile is not reachable`);
      const text = await page().locator('[data-usage="true"]').innerText();
      must(
        (await page().locator('[data-usage-empty="agent"]').count()) === 1 &&
          (await page().locator('[data-usage-empty="project"]').count()) === 1,
        'empty tables not shown',
      );
      must(
        /No sessions yet\./.test(text) && /No limits reported yet\. Start a session, or refresh\./.test(text),
        `usage reads "${text.replace(/\n/g, ' ')}"`,
      );
      await sim.shot('usage-empty');
    });
  });
});
