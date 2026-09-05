import {
  cliAuthLabel,
  cliVersionLabel,
  copy,
  fill,
  ideImportsLabel,
  ideVersionLabel,
  platformCopy,
  type IdeInstall,
  type ReadModel,
} from '@styx/core';
import {
  Button,
  Checkbox,
  Label,
  Numeral,
  StatusDot,
  Table,
  TableCell,
  TableRow,
  TABLE_COLUMNS,
  Tag,
} from '@styx/ui';
import { useEffect, useState } from 'react';
import { PROVIDERS, methodLabel } from '../../features/modals/modals';
import { command } from '../../state/commands';
import { useModel, useNow, useUi } from '../../state/hooks';
import type { OnboardingStep } from '../../state/ui-store';
import s from './Onboarding.module.css';
import {
  DEFAULT_IDE_IMPORTS,
  STEPS,
  repoMeta,
  type IdeImports,
  type ScannedRepo,
} from './onboarding-rows';

const selectIdes = (m: ReadModel) => m.discovery.ides;
const selectClis = (m: ReadModel) => m.discovery.clis;
const selectFallback = (m: ReadModel) => m.settings.app.fallbackIde;

/**
 * Onboarding (spec §4.9): covers everything below the titlebar (the outlet hides rail and nav). Step strip
 * 01 Editor · 02 Projects · 03 Agents · 04 Targets, footer Back · Skip · Continue/Finish. Skip and Finish both
 * complete onboarding and land on Home.
 */
export function Onboarding() {
  const step = useUi((u) => u.onboardingStep);
  const setStep = useUi((u) => u.setOnboardingStep);
  const setScreen = useUi((u) => u.setScreen);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const projectId = useUi((u) => u.projectId);
  const platform = useUi((u) => u.platform);
  const now = useNow();
  const ides = useModel(selectIdes);
  const clis = useModel(selectClis);
  const fallbackKind = useModel(selectFallback);
  const words = platformCopy(platform);

  const [chosenIde, setChosenIde] = useState<string | null>(null);
  const [imports, setImports] = useState<IdeImports>(DEFAULT_IDE_IMPORTS);
  const [repos, setRepos] = useState<ScannedRepo[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const ide: IdeInstall | undefined =
    ides.find((i) => i.id === chosenIde) ??
    ides.find((i) => i.isFallback) ??
    ides.find((i) => i.kind === fallbackKind) ??
    ides[0];

  // Step 2 scans once (IDE recents included when the toggle was on).
  useEffect(() => {
    if (step !== 2 || repos !== null) return;
    let cancelled = false;
    void command('project.scan', { includeIdeRecents: imports.recents }).then((r) => {
      if (cancelled) return;
      const found = r.ok ? r.value.repos : [];
      setRepos(found);
      setChecked(new Set(found.filter((x) => x.suggested).map((x) => x.path)));
    });
    return () => {
      cancelled = true;
    };
  }, [step, repos, imports.recents]);

  const finish = async () => {
    await command('onboarding.complete', {});
    setScreen('home');
  };

  const next = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (step === 1) {
        if (ide !== undefined) {
          await command('ide.setFallback', { kind: ide.kind });
          if (imports.keybindings || imports.theme || imports.recents) {
            await command('ide.import', {
              ideId: ide.id,
              keybindings: imports.keybindings,
              theme: imports.theme,
              recents: imports.recents,
            });
          }
          if (imports.installOpenIn) await command('ide.installOpenIn', {});
        }
        setStep(2);
      } else if (step === 2) {
        for (const repo of repos ?? []) {
          if (checked.has(repo.path)) await command('project.add', { path: repo.path });
        }
        setStep(3);
      } else if (step === 3) {
        setStep(4);
      } else {
        await finish();
      }
    } finally {
      setBusy(false);
    }
  };
  const back = () => {
    if (step > 1) setStep((step - 1) as OnboardingStep);
  };
  const toggleRepo = (path: string, on: boolean) =>
    setChecked((prev) => {
      const nextSet = new Set(prev);
      if (on) nextSet.add(path);
      else nextSet.delete(path);
      return nextSet;
    });

  return (
    <div className={s['root']} data-onboarding-step={step}>
      <ol className={s['strip']} aria-label={copy.onboarding.steps.editor}>
        {STEPS.map((st) => (
          <li
            key={st.n}
            className={s['stepCell']}
            data-inv={st.n === step ? 'true' : undefined}
            aria-current={st.n === step ? 'step' : undefined}
          >
            <Numeral value={st.n} size="M" />
            <Label strong>{st.label}</Label>
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <section className={s['body']} aria-labelledby="ob-headline">
          <h1 id="ob-headline" className={s['headline']}>
            {copy.onboarding.editor.headline}
          </h1>
          <p className={s['lead']}>{copy.onboarding.editor.body}</p>
          <div className={s['tableFrame']}>
            <Table
              columns={TABLE_COLUMNS.onboardingIde}
              rowPad="10px 14px"
              gap="14px"
              aria-label={copy.onboarding.steps.editor}
            >
              {ides.map((i) => {
                const chosen = ide?.id === i.id;
                return (
                  <TableRow key={i.id} data-ide-id={i.id} onActivate={() => setChosenIde(i.id)}>
                    <TableCell>
                      <Checkbox
                        tone="accent"
                        checked={chosen}
                        aria-label={i.product}
                        onChange={() => setChosenIde(i.id)}
                      />
                    </TableCell>
                    <TableCell strong>{i.product}</TableCell>
                    <TableCell mono muted>
                      {ideVersionLabel(i)}
                    </TableCell>
                    <TableCell mono muted>
                      {ideImportsLabel(i)}
                    </TableCell>
                    <TableCell align="end">
                      <Tag size="md" inv={chosen}>
                        {chosen ? copy.onboarding.editor.roleFallback : copy.onboarding.editor.roleDetected}
                      </Tag>
                    </TableCell>
                  </TableRow>
                );
              })}
            </Table>
          </div>
          <div className={s['toggles']}>
            <Checkbox
              checked={imports.keybindings}
              onChange={(v) => setImports({ ...imports, keybindings: v })}
              label={copy.onboarding.editor.importKeybindings}
            />
            <Checkbox
              checked={imports.theme}
              onChange={(v) => setImports({ ...imports, theme: v })}
              label={copy.onboarding.editor.importTheme}
            />
            <Checkbox
              checked={imports.recents}
              onChange={(v) => setImports({ ...imports, recents: v })}
              label={copy.onboarding.editor.importRecents}
            />
            <Checkbox
              checked={imports.installOpenIn}
              onChange={(v) => setImports({ ...imports, installOpenIn: v })}
              label={copy.onboarding.editor.installOpenIn}
            />
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className={s['body']} aria-labelledby="ob-headline">
          <h1 id="ob-headline" className={s['headline']}>
            {fill(copy.onboarding.projects.headline, { n: repos?.length ?? 0 })}
          </h1>
          <p className={s['lead']}>
            {fill(copy.onboarding.projects.body, { ide: ide?.product ?? copy.general.none })}
          </p>
          <div className={s['tableFrame']}>
            <Table
              columns={TABLE_COLUMNS.onboardingRepos}
              rowPad="10px 14px"
              gap="14px"
              className={s['mono']}
              aria-label={copy.onboarding.steps.projects}
            >
              {(repos ?? []).map((r) => (
                <TableRow key={r.path} data-repo-path={r.path}>
                  <TableCell>
                    <Checkbox
                      tone="accent"
                      checked={checked.has(r.path)}
                      aria-label={r.path}
                      onChange={(v) => toggleRepo(r.path, v)}
                    />
                  </TableCell>
                  <TableCell className={s['monoCell']}>{r.path}</TableCell>
                  <TableCell muted className={s['monoCell']}>
                    {repoMeta(r, now)}
                  </TableCell>
                </TableRow>
              ))}
            </Table>
            <button
              type="button"
              className={s['addRow']}
              onClick={() => pushOverlay({ kind: 'modal', modal: 'new-project' })}
            >
              {copy.onboarding.projects.addRow}
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className={s['body']} aria-labelledby="ob-headline">
          <h1 id="ob-headline" className={s['headline']}>
            {copy.onboarding.agents.headline}
          </h1>
          <p className={s['lead']}>{copy.onboarding.agents.body}</p>
          <div className={s['tableFrame']}>
            <Table
              columns={TABLE_COLUMNS.onboardingClis}
              rowPad="10px 14px"
              gap="14px"
              aria-label={copy.onboarding.steps.agents}
            >
              {clis.map((c) => (
                <TableRow key={c.agent} data-agent={c.agent}>
                  <TableCell strong>{copy.agentProducts[c.agent]}</TableCell>
                  <TableCell mono muted>
                    {cliVersionLabel(c)}
                  </TableCell>
                  <TableCell mono>{cliAuthLabel(c)}</TableCell>
                  <TableCell align="end">
                    <StatusDot
                      tone="hollow"
                      on={!c.found}
                      {...(c.found ? {} : { label: copy.onboarding.agents.notFound })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        </section>
      ) : null}

      {step === 4 ? (
        <section className={s['body']} aria-labelledby="ob-headline">
          <h1 id="ob-headline" className={s['headline']}>
            {copy.onboarding.targets.headline}
          </h1>
          <p className={s['lead']}>
            {fill(copy.onboarding.targets.body, { keychainName: words.keychainName })}
          </p>
          <div className={s['providers']}>
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                className={s['provider']}
                data-provider={p}
                onClick={() => pushOverlay({ kind: 'modal', modal: 'connect', projectId, provider: p })}
              >
                <span className={s['providerName']}>{copy.providers[p]}</span>
                <Label>{fill(copy.onboarding.targets.tile, { method: methodLabel(p) })}</Label>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className={s['footer']}>
        <Button size="footer" variant="ghost" className={s['back']} onClick={back} aria-disabled={step === 1}>
          {copy.onboarding.footer.back}
        </Button>
        <span className={s['spacer']} />
        <Button size="footer" variant="ghost" className={s['skip']} onClick={() => void finish()}>
          {copy.onboarding.footer.skip}
        </Button>
        <Button
          size="footer"
          variant="primary"
          className={s['next']}
          disabled={busy}
          onClick={() => void next()}
        >
          {step < 4 ? copy.onboarding.footer.continue : copy.onboarding.footer.finish}
        </Button>
      </div>
    </div>
  );
}
