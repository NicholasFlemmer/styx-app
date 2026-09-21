import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEMO_NOW, launchStyx, type LaunchOptions } from '../launch';

/**
 * User simulation harness (owner request, 2026-09-21): drive the built app the way a person would — every feature
 * exercised by doing it and checking what happened — and write down what was found. Unlike the e2e suite a
 * failed step does not stop the run: it is recorded with a screenshot and the simulation goes on, so one report
 * covers an area end to end. Findings are the point; a step that passes is one line.
 *
 * Runs without `STYX_E2E` so the app shows what a person sees (working line, session controls, queue / steer
 * hints); the fake agent CLIs on the e2e PATH still stand in for the real ones, so nothing spends usage.
 */
export interface Finding {
  severity: 'blocker' | 'major' | 'minor' | 'polish';
  title: string;
  repro: string;
  expected: string;
  observed: string;
  /** Where in the code the cause most likely is, when known. */
  where?: string;
}

interface StepRecord {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  shot?: string;
  note?: string;
}

export interface SimContext {
  app: ElectronApplication;
  page: Page;
  userData: string;
  /** Runs one step; a throw is recorded (with a screenshot) and the simulation continues. */
  step(name: string, fn: () => Promise<void | string>): Promise<boolean>;
  finding(f: Finding): void;
  /** A screenshot at any point, kept with the report. */
  shot(label: string): Promise<string>;
  /** `window.styx.command` from the page, for state checks a person cannot see. */
  command<T = unknown>(
    name: string,
    input: unknown,
  ): Promise<{ ok: boolean; value?: T; error?: { code: string; message: string } }>;
  relaunch(opts?: LaunchOptions): Promise<void>;
}

const OUT = resolve(__dirname, 'out');
const REPORTS = resolve(__dirname, '../../../../docs/reports/user-sim');

export async function runSim(
  area: string,
  opts: LaunchOptions,
  body: (ctx: SimContext) => Promise<void>,
): Promise<void> {
  const outDir = join(OUT, area);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(REPORTS, { recursive: true });
  const steps: StepRecord[] = [];
  const findings: Finding[] = [];
  let shots = 0;
  const launchOpts: LaunchOptions = {
    ...opts,
    env: { STYX_E2E: '0', STYX_MFA: 'auto', ...(opts.env ?? {}) },
  };
  let launched = await launchStyx(launchOpts);
  const ctx: SimContext = {
    get app() {
      return launched.app;
    },
    get page() {
      return launched.page;
    },
    get userData() {
      return launched.userData;
    },
    async shot(label) {
      shots += 1;
      const file = join(
        outDir,
        `${String(shots).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`,
      );
      await launched.page.screenshot({ path: file }).catch(() => undefined);
      return file;
    },
    async step(name, fn) {
      const t0 = Date.now();
      try {
        const note = await fn();
        steps.push({ name, ok: true, ms: Date.now() - t0, ...(typeof note === 'string' ? { note } : {}) });
        process.stdout.write(`  ✓ ${name}\n`);
        return true;
      } catch (e) {
        const shot = await ctx.shot(`fail-${name}`);
        const error = e instanceof Error ? e.message.split('\n').slice(0, 6).join('\n') : String(e);
        steps.push({ name, ok: false, ms: Date.now() - t0, error, shot });
        process.stdout.write(`  ✗ ${name}\n    ${error.split('\n')[0]}\n`);
        return false;
      }
    },
    finding(f) {
      findings.push(f);
    },
    command: (name, input) =>
      launched.page.evaluate(
        ([n, i]) =>
          (
            window as unknown as { styx: { command: (name: string, input: unknown) => Promise<unknown> } }
          ).styx.command(n as string, i),
        [name, input] as const,
      ) as Promise<never>,
    async relaunch(o = {}) {
      await launched.app.close().catch(() => undefined);
      launched = await launchStyx({ ...launchOpts, ...o, env: { ...launchOpts.env, ...(o.env ?? {}) } });
    },
  };
  const started = Date.now();
  try {
    await body(ctx);
  } catch (e) {
    findings.push({
      severity: 'blocker',
      title: 'the simulation itself stopped',
      repro: area,
      expected: 'every step runs',
      observed: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await launched.app.close().catch(() => undefined);
  }
  const passed = steps.filter((s) => s.ok).length;
  const lines: string[] = [
    `# User simulation · ${area}`,
    '',
    `Run ${new Date().toISOString()} · ${passed}/${steps.length} steps passed · ${Math.round((Date.now() - started) / 1000)} s · fixture \`${opts.fixture ?? 'demo'}\`, STYX_NOW ${opts.now ?? DEMO_NOW}, fake CLIs on PATH, no STYX_E2E.`,
    '',
    '## Findings',
    '',
  ];
  if (findings.length === 0) lines.push('None.');
  for (const [i, f] of findings.entries()) {
    lines.push(
      `### ${i + 1}. [${f.severity}] ${f.title}`,
      '',
      `- Repro: ${f.repro}`,
      `- Expected: ${f.expected}`,
      `- Observed: ${f.observed}`,
    );
    if (f.where) lines.push(`- Where: ${f.where}`);
    lines.push('');
  }
  lines.push('## Steps', '', '| # | Step | Result | Note |', '| --- | --- | --- | --- |');
  for (const [i, s] of steps.entries()) {
    const note = s.ok
      ? (s.note ?? '')
      : `${s.error ?? ''}${s.shot ? ` · ${s.shot.replace(OUT, 'out')}` : ''}`;
    lines.push(
      `| ${i + 1} | ${s.name} | ${s.ok ? 'ok' : 'FAIL'} (${s.ms} ms) | ${note.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
    );
  }
  lines.push('');
  const report = join(REPORTS, `${area}.md`);
  writeFileSync(report, lines.join('\n'));
  process.stdout.write(`\n${passed}/${steps.length} passed · ${findings.length} findings · ${report}\n`);
  if (findings.some((f) => f.severity === 'blocker')) process.exitCode = 1;
}
